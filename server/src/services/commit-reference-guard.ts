import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  assets,
  executionWorkspaces,
  issueAttachments,
  projectWorkspaces,
  type Db,
} from "@paperclipai/db";
import type {
  IssueCommentMetadata,
  IssueCommentPresentation,
} from "@paperclipai/shared";
import { insertIssueComment } from "./issue-comment-writes.js";
import { systemNoticePresentation } from "./recovery/notice-format.js";
import { logger } from "../middleware/logger.js";

const execFile = promisify(execFileCallback);

const GIT_TIMEOUT_MS = 5_000;
const GUARD_BUDGET_MS = 4_000;
const ATTACHMENT_READ_BUDGET_MS = 2_000;
const MAX_CITED_SHAS = 25;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_TEXT_BYTES = 256 * 1024;

// A commit reference is a standalone hex token. The lookarounds deliberately
// reject substrings of a longer hex run, so a 64-character sha256 content hash
// never contributes a bogus 7-40 character "commit".
const HEX_TOKEN_RE = /(?<![0-9a-fA-F])[0-9a-fA-F]{7,40}(?![0-9a-fA-F])/g;

// Tokens that look like object ids in prose or fixtures but are almost never
// real commits. Keeping them out of the notice avoids warning on documentation.
const PLACEHOLDER_SHAS = new Set([
  "abcdef0",
  "abcdef1",
  "deadbeef",
  "deadbee",
  "cafebabe",
  "cafebabe0",
  "decafbad",
  "feedface",
  "8badf00d",
  "badf00d",
  "0badf00d",
  "f00dbabe",
  "defaced",
]);

const HASH_CONTEXT_RE = /(?:sha(?:1|256|512)?|checksum|digest|hash)\s*[:=]\s*$/i;

export type CommitReferenceCheck = {
  checkedShas: string[];
  missingShas: string[];
  repoCwd: string | null;
  branchName: string | null;
  headSha: string | null;
  unavailableReason?:
    | "no_issue_workspace"
    | "not_a_git_repository"
    | "git_unavailable";
};

/**
 * Extract plausible commit references from free-form markdown. Warn-only: this
 * is intentionally eager, and the caller never rejects a comment because of it.
 */
export function extractCommitReferenceCandidates(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const match of text.matchAll(HEX_TOKEN_RE)) {
    const token = match[0];
    const lower = token.toLowerCase();
    if (seen.has(lower) || PLACEHOLDER_SHAS.has(lower)) continue;
    // Real object ids practically always mix digits and a-f letters. All-digit
    // and all-letter tokens are far more often prose, ids, or fixtures.
    if (!/\d/.test(lower) || !/[a-f]/.test(lower)) continue;
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
    if (HASH_CONTEXT_RE.test(prefix)) continue;
    seen.add(lower);
    candidates.push(token);
    if (candidates.length >= MAX_CITED_SHAS) break;
  }
  return candidates;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

async function runGit(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile(
      "git",
      ["-c", `safe.directory=${cwd}`, "-c", "core.fsmonitor=false", "-C", cwd, ...args],
      {
        env: gitEnv(),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        signal,
      },
    );
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const candidate = error as { stdout?: string; stderr?: string; code?: unknown };
    return {
      ok: false,
      stdout: String(candidate.stdout ?? ""),
      stderr: String(candidate.stderr ?? (error instanceof Error ? error.message : "")),
    };
  }
}

function looksLikeEnvironmentFailure(stderr: string): boolean {
  return /dubious ownership|not a git repository|unable to read|permission denied|no such file or directory/i.test(
    stderr,
  );
}

/**
 * Check cited commit ids against one workspace repository. Never throws; an
 * unreadable repository reports `unavailableReason` and no missing SHAs.
 */
export async function inspectCommitReferences(input: {
  repoCwd: string;
  shas: readonly string[];
  signal?: AbortSignal;
}): Promise<CommitReferenceCheck> {
  const checkedShas = input.shas.slice(0, MAX_CITED_SHAS);
  const repoCwd = path.resolve(input.repoCwd);
  if (checkedShas.length === 0) {
    return { checkedShas, missingShas: [], repoCwd, branchName: null, headSha: null };
  }

  const probe = await runGit(repoCwd, ["rev-parse", "--git-dir"], input.signal);
  if (!probe.ok) {
    return {
      checkedShas,
      missingShas: [],
      repoCwd,
      branchName: null,
      headSha: null,
      unavailableReason: looksLikeEnvironmentFailure(probe.stderr)
        ? "not_a_git_repository"
        : "git_unavailable",
    };
  }

  const [head, branch] = await Promise.all([
    runGit(repoCwd, ["rev-parse", "HEAD"], input.signal),
    runGit(repoCwd, ["rev-parse", "--abbrev-ref", "HEAD"], input.signal),
  ]);
  const headSha = head.ok ? head.stdout.trim() : null;
  const branchName = branch.ok ? branch.stdout.trim() : null;

  const missingShas: string[] = [];
  for (const sha of checkedShas) {
    if (input.signal?.aborted) break;
    const check = await runGit(
      repoCwd,
      ["cat-file", "-e", `${sha}^{commit}`],
      input.signal,
    );
    if (check.ok) continue;
    if (looksLikeEnvironmentFailure(check.stderr)) {
      return {
        checkedShas,
        missingShas,
        repoCwd,
        branchName,
        headSha,
        unavailableReason: "not_a_git_repository",
      };
    }
    missingShas.push(sha);
  }

  if (input.signal?.aborted) {
    return {
      checkedShas,
      missingShas: [],
      repoCwd,
      branchName,
      headSha,
      unavailableReason: "git_unavailable",
    };
  }
  return { checkedShas, missingShas, repoCwd, branchName, headSha };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the repository a comment's cited SHAs should be checked against. The
 * issue's execution worktree is preferred because it shares objects with the
 * canonical project checkout and has the task branch checked out; the project
 * workspace is the fallback for issues without a live worktree.
 */
async function resolveIssueRepositoryCwd(
  db: Db,
  issue: { companyId: string; executionWorkspaceId?: string | null; projectWorkspaceId?: string | null },
): Promise<string | null> {
  const candidates: string[] = [];
  if (issue.executionWorkspaceId) {
    const [workspace] = await db
      .select({ cwd: executionWorkspaces.cwd })
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.id, issue.executionWorkspaceId),
          eq(executionWorkspaces.companyId, issue.companyId),
        ),
      )
      .limit(1);
    if (workspace?.cwd) candidates.push(workspace.cwd);
  }
  if (issue.projectWorkspaceId) {
    const [workspace] = await db
      .select({ cwd: projectWorkspaces.cwd })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.id, issue.projectWorkspaceId),
          eq(projectWorkspaces.companyId, issue.companyId),
        ),
      )
      .limit(1);
    if (workspace?.cwd) candidates.push(workspace.cwd);
  }

  for (const candidate of candidates) {
    if (candidate && (await isDirectory(candidate))) return path.resolve(candidate);
  }
  return null;
}

async function readAttachmentTexts(
  db: Db,
  companyId: string,
  commentId: string,
): Promise<string[]> {
  const rows = await db
    .select({
      objectKey: assets.objectKey,
      contentType: assets.contentType,
      byteSize: assets.byteSize,
    })
    .from(issueAttachments)
    .innerJoin(
      assets,
      and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, issueAttachments.companyId)),
    )
    .where(
      and(
        eq(issueAttachments.companyId, companyId),
        eq(issueAttachments.issueCommentId, commentId),
      ),
    )
    .limit(MAX_ATTACHMENTS);

  const texts: string[] = [];
  const readable = rows.filter(
    (row) =>
      row.byteSize > 0 &&
      row.byteSize <= MAX_ATTACHMENT_TEXT_BYTES &&
      (/^text\//i.test(row.contentType) || /json|xml|yaml|markdown/i.test(row.contentType)),
  );
  if (readable.length === 0) return texts;

  // Imported lazily so unit tests and non-attachment comment paths never load
  // the storage configuration.
  const { getStorageService } = await import("../storage/index.js");
  const storage = getStorageService();
  for (const row of readable) {
    try {
      const object = await storage.getObject(companyId, row.objectKey);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of object.stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_ATTACHMENT_TEXT_BYTES) break;
        chunks.push(buffer);
      }
      texts.push(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      logger.warn(
        { err: error, companyId, commentId },
        "commit reference guard could not read a comment attachment",
      );
    }
  }
  return texts;
}

export function buildMissingCommitReferenceNotice(input: {
  missingShas: readonly string[];
  branchName: string | null;
  headSha: string | null;
}): {
  body: string;
  presentation: IssueCommentPresentation;
  metadata: IssueCommentMetadata;
} {
  const missing = input.missingShas.map((sha) => `\`${sha}\``);
  const listed = missing.join(", ");
  const branch = input.branchName?.trim() || "unknown branch";
  const head = input.headSha?.trim() || "unknown commit";
  const body =
    "Commit reference check\n\n" +
    `This comment cites ${missing.length === 1 ? "a commit" : "commits"} that ${missing.length === 1 ? "is" : "are"} not present in this task's workspace repository: ${listed}.\n\n` +
    `The repository's \`${branch}\` is at \`${head}\`. If a cited SHA refers to another repository or to a ` +
    "`refs/paperclip/runs/*` preservation ref, ignore this notice; this is a warning only and the comment was saved.";

  return {
    body,
    presentation: systemNoticePresentation({
      tone: "warning",
      title: "Cited commit missing from workspace",
    }),
    metadata: {
      version: 1,
      sections: [
        {
          title: "Commit reference check",
          rows: [
            { type: "key_value", label: "Missing commits", value: listed },
            { type: "key_value", label: "Workspace branch", value: branch },
            { type: "key_value", label: "Branch tip", value: head },
            {
              type: "text",
              text: "Warn only: the comment was saved. Cross-repository SHAs and refs/paperclip/runs/* preservation refs are expected to fail this check.",
            },
          ],
        },
      ],
    },
  };
}

/**
 * Non-blocking guard for comment creation. Extracts cited commit ids from the
 * comment body and text attachments, checks them against the issue's workspace
 * repository, and posts one system notice when some are missing. It never
 * throws and never changes the comment's success status.
 */
export async function warnAboutUnresolvedCommitReferences(input: {
  db: Db;
  issue: {
    id: string;
    companyId: string;
    identifier: string | null;
    executionWorkspaceId?: string | null;
    projectWorkspaceId?: string | null;
  };
  comment: { id: string; body: string };
}): Promise<{ posted: boolean; missingShas: string[] }> {
  try {
    const texts = [input.comment.body];
    try {
      texts.push(
        ...(await withTimeout(
          readAttachmentTexts(input.db, input.issue.companyId, input.comment.id),
          ATTACHMENT_READ_BUDGET_MS,
          [],
        )),
      );
    } catch (error) {
      logger.warn(
        { err: error, commentId: input.comment.id },
        "commit reference guard could not scan comment attachments",
      );
    }

    const cited: string[] = [];
    const seen = new Set<string>();
    for (const text of texts) {
      for (const sha of extractCommitReferenceCandidates(text)) {
        const lower = sha.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        cited.push(sha);
        if (cited.length >= MAX_CITED_SHAS) break;
      }
      if (cited.length >= MAX_CITED_SHAS) break;
    }
    if (cited.length === 0) return { posted: false, missingShas: [] };

    const repoCwd = await resolveIssueRepositoryCwd(input.db, input.issue);
    if (!repoCwd) return { posted: false, missingShas: [] };

    const controller = new AbortController();
    const budget = setTimeout(() => controller.abort(), GUARD_BUDGET_MS);
    budget.unref?.();
    let check: CommitReferenceCheck;
    try {
      check = await inspectCommitReferences({
        repoCwd,
        shas: cited,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(budget);
    }
    if (check.unavailableReason || check.missingShas.length === 0) {
      return { posted: false, missingShas: [] };
    }

    const notice = buildMissingCommitReferenceNotice({
      missingShas: check.missingShas,
      branchName: check.branchName,
      headSha: check.headSha,
    });
    await insertIssueComment(input.db, {
      companyId: input.issue.companyId,
      issueId: input.issue.id,
      authorType: "system",
      body: notice.body,
      presentation: notice.presentation,
      metadata: notice.metadata,
    });
    logger.info(
      {
        issueId: input.issue.id,
        commentId: input.comment.id,
        missingShas: check.missingShas,
        repoCwd: check.repoCwd,
      },
      "posted missing commit reference notice",
    );
    return { posted: true, missingShas: check.missingShas };
  } catch (error) {
    logger.warn(
      { err: error, issueId: input.issue.id, commentId: input.comment.id },
      "commit reference guard failed without blocking the comment",
    );
    return { posted: false, missingShas: [] };
  }
}
