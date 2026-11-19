import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMissingCommitReferenceNotice,
  extractCommitReferenceCandidates,
  inspectCommitReferences,
} from "../services/commit-reference-guard.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFile(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } },
  );
  return stdout.trim();
}

describe("extractCommitReferenceCandidates", () => {
  it("finds full and abbreviated commit ids in prose and code", () => {
    const text =
      "Landed in `bc17308` and 0b1c8dc9e112a7c1be42f3a4d5e6f708192a3b4c.\n\n" +
      "```\ngit show 9e112a7\n```";
    expect(extractCommitReferenceCandidates(text)).toEqual([
      "bc17308",
      "0b1c8dc9e112a7c1be42f3a4d5e6f708192a3b4c",
      "9e112a7",
    ]);
  });

  it("ignores hex runs longer than 40 characters and content hashes", () => {
    const text = [
      "sha256: 1f2e3d4c5b6a79887766554433221100ffeeddccbbaa99887766554433221100",
      "checksum=abcdef0123456789abcdef0123456789abcdef01",
      "digest: abc1234abc1234abc1234abc1234abc1234abc1234",
    ].join("\n");
    expect(extractCommitReferenceCandidates(text)).toEqual([]);
  });

  it("ignores placeholders and all-digit or all-letter tokens", () => {
    const text = "deadbeef abcdef0 1234567 ffffffff cafe";
    expect(extractCommitReferenceCandidates(text)).toEqual([]);
  });
});

describe("inspectCommitReferences", () => {
  let root: string;
  let repo: string;
  let head: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-commit-guard-")));
    repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await git(repo, "init", "--initial-branch=main");
    await fs.writeFile(path.join(repo, "marker.txt"), "one\n");
    await git(repo, "add", "marker.txt");
    await git(repo, "commit", "-m", "init");
    head = await git(repo, "rev-parse", "HEAD");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("accepts a commit that exists in the workspace repository", async () => {
    const result = await inspectCommitReferences({ repoCwd: repo, shas: [head, head.slice(0, 7)] });
    expect(result.unavailableReason).toBeUndefined();
    expect(result.missingShas).toEqual([]);
    expect(result.headSha).toBe(head);
    expect(result.branchName).toBe("main");
  });

  it("reports SHAs absent from the workspace repository", async () => {
    const result = await inspectCommitReferences({
      repoCwd: repo,
      shas: [head, "bc17308"],
    });
    expect(result.unavailableReason).toBeUndefined();
    expect(result.missingShas).toEqual(["bc17308"]);
  });

  it("reports an unavailable repository instead of marking every SHA missing", async () => {
    const result = await inspectCommitReferences({
      repoCwd: path.join(root, "missing"),
      shas: ["bc17308"],
    });
    expect(result.missingShas).toEqual([]);
    expect(result.unavailableReason).toBeDefined();
  });
});

describe("buildMissingCommitReferenceNotice", () => {
  it("names the missing SHAs and the branch tip the repository actually has", () => {
    const notice = buildMissingCommitReferenceNotice({
      missingShas: ["bc17308", "9e112a7"],
      branchName: "THE-268-guard",
      headSha: "1234567890abcdef1234567890abcdef12345678",
    });
    expect(notice.body).toContain("`bc17308`");
    expect(notice.body).toContain("`9e112a7`");
    expect(notice.body).toContain("THE-268-guard");
    expect(notice.body).toContain("1234567890abcdef1234567890abcdef12345678");
    expect(notice.presentation.kind).toBe("system_notice");
    expect(notice.presentation.tone).toBe("warning");
    expect(notice.metadata.sections[0]?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "key_value", label: "Missing commits" }),
      ]),
    );
  });
});
