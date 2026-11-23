import { and, desc, eq, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { isUuidLike, type IssueReviewPolicy } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { normalizeAgentNameKey } from "./agent-name-key.js";

export interface IssueReviewVerdictActor {
  type: "agent" | "user";
  id: string;
  /**
   * Set when an agent acts for a person. If that person is the review
   * requester, the agent is not an independent reviewer even though the
   * principals have different types.
   */
  relayedUserId?: string | null;
}

export interface IssueReviewRequester {
  type: "agent" | "user";
  id: string;
  runId: string | null;
  reviewInteractionId: string | null;
  /**
   * Present when an agent was attributed through a person's credential: the
   * person whose identity the write presented. Confirmations that person
   * created still belong to this review.
   */
  relayedUserId?: string | null;
}

/** Persisted on the transition so later reads do not reinterpret `_previous`. */
export interface IssueReviewRequesterRecord {
  type: "agent" | "user";
  id: string;
  runId: string | null;
  /** The person whose credential the writer presented, when identities mixed. */
  relayedUserId?: string | null;
  /** The writer presented a person's credential while an agent run executed. */
  mixedIdentity?: true;
}

interface ReviewPolicyIssue {
  id: string;
  companyId: string;
  reviewPolicy?: IssueReviewPolicy | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}

/**
 * Evidence about who moved an issue into `in_review`.
 *
 * The actor columns are not authoritative on their own: a write made through a
 * person's board credential records `actor_type = 'user'` even when the issue's
 * execution snapshot names the agent run that performed it (THE-228/THE-399).
 */
interface ReviewRequesterSignals {
  companyId: string;
  actorType: string | null;
  actorId: string | null;
  /** `activity_log.agent_id`: non-null only for agent-authored rows. */
  agentId?: string | null;
  runId?: string | null;
  details?: Record<string, unknown> | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}

type RequesterResolution =
  | { kind: "resolved"; requester: IssueReviewRequester }
  | { kind: "ambiguous"; reason: string }
  | { kind: "absent" };

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function resolveAgentIdForRun(db: Db, companyId: string, runId: string) {
  if (!isUuidLike(runId)) return null;
  const run = await db
    .select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))
    .then((rows) => rows[0] ?? null);
  return run?.agentId ?? null;
}

async function resolveAgentIdForNameKey(db: Db, companyId: string, nameKey: string) {
  const normalized = normalizeAgentNameKey(nameKey);
  if (!normalized) return null;
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      sql`lower(btrim(${agents.name})) = ${normalized}`,
    ))
    .limit(2);
  // A name shared by two agents identifies neither of them.
  return rows.length === 1 ? rows[0].id : null;
}

function agentRequester(
  agentId: string,
  runId: string | null,
  reviewInteractionId: string | null,
  relayedUserId: string | null = null,
): RequesterResolution {
  return {
    kind: "resolved",
    requester: { type: "agent", id: agentId, runId, reviewInteractionId, relayedUserId },
  };
}

async function resolveRequesterFromSignals(
  db: Db,
  signals: ReviewRequesterSignals,
): Promise<RequesterResolution> {
  const details = readRecord(signals.details);
  const reviewInteractionId = readString(details?.reviewInteractionId);
  const previous = readRecord(details?._previous);

  const persisted = readRecord(details?.reviewRequester);
  const persistedType = persisted?.type === "agent" || persisted?.type === "user"
    ? persisted.type
    : null;
  const persistedId = readString(persisted?.id);
  if (persistedType && persistedId) {
    return {
      kind: "resolved",
      requester: {
        type: persistedType,
        id: persistedId,
        runId: readString(persisted?.runId),
        reviewInteractionId,
        relayedUserId: readString(persisted?.relayedUserId),
      },
    };
  }

  const actorId = readString(signals.actorId);
  if (signals.actorType === "agent" && actorId) {
    return agentRequester(actorId, readString(signals.runId), reviewInteractionId);
  }
  const rowAgentId = readString(signals.agentId);
  if (rowAgentId) {
    return agentRequester(rowAgentId, readString(signals.runId), reviewInteractionId);
  }

  // Execution metadata is the only evidence that a board-credentialed write was
  // actually performed by an agent run.
  const executionRunId = readString(previous?.executionRunId);
  const checkoutRunId = readString(previous?.checkoutRunId);
  const executionAgentNameKey = readString(previous?.executionAgentNameKey);
  if (executionRunId || checkoutRunId || executionAgentNameKey) {
    // The recorded person is the identity the run presented, not an independent
    // writer, so keep it attached to the agent attribution.
    const relayedUserId = signals.actorType === "user" ? actorId : null;
    for (const runId of [executionRunId, checkoutRunId]) {
      if (!runId) continue;
      const agentId = await resolveAgentIdForRun(db, signals.companyId, runId);
      if (agentId) return agentRequester(agentId, runId, reviewInteractionId, relayedUserId);
    }
    if (executionAgentNameKey) {
      const agentId = await resolveAgentIdForNameKey(db, signals.companyId, executionAgentNameKey);
      if (agentId) {
        return agentRequester(
          agentId,
          executionRunId ?? checkoutRunId,
          reviewInteractionId,
          relayedUserId,
        );
      }
    }
    // The row says a person asked for review while its own snapshot names an
    // agent that no longer resolves. Refuse to guess which writer the verdict
    // should be compared against.
    return { kind: "ambiguous", reason: "agent_execution_unresolved" };
  }

  if (signals.actorType === "user" && actorId) {
    return {
      kind: "resolved",
      requester: { type: "user", id: actorId, runId: null, reviewInteractionId },
    };
  }

  if (signals.createdByAgentId && !signals.createdByUserId) {
    return {
      kind: "resolved",
      requester: {
        type: "agent",
        id: signals.createdByAgentId,
        runId: null,
        reviewInteractionId: null,
      },
    };
  }
  if (signals.createdByUserId && !signals.createdByAgentId) {
    return {
      kind: "resolved",
      requester: {
        type: "user",
        id: signals.createdByUserId,
        runId: null,
        reviewInteractionId: null,
      },
    };
  }
  return { kind: "absent" };
}

function reviewTransitionWhere(issue: ReviewPolicyIssue) {
  return and(
    eq(activityLog.companyId, issue.companyId),
    eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, issue.id),
    eq(activityLog.action, "issue.updated"),
    sql`(
      (
        ${activityLog.details} ->> 'status' = 'in_review'
        AND ${activityLog.details} -> '_previous' ->> 'status' IS NOT NULL
        AND ${activityLog.details} -> '_previous' ->> 'status' <> 'in_review'
      )
      OR
      (
        ${activityLog.details} -> 'changes' -> 'status' ->> 'to' = 'in_review'
        AND ${activityLog.details} -> 'changes' -> 'status' ->> 'from' IS NOT NULL
        AND ${activityLog.details} -> 'changes' -> 'status' ->> 'from' <> 'in_review'
      )
    )`,
  );
}

async function loadLatestReviewTransition(db: Db, issue: ReviewPolicyIssue) {
  return db
    .select({
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
      agentId: activityLog.agentId,
      runId: activityLog.runId,
      details: activityLog.details,
    })
    .from(activityLog)
    .where(reviewTransitionWhere(issue))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function resolveTransitionRequester(
  db: Db,
  issue: ReviewPolicyIssue,
): Promise<RequesterResolution> {
  const transition = await loadLatestReviewTransition(db, issue);
  return resolveRequesterFromSignals(db, {
    companyId: issue.companyId,
    actorType: transition?.actorType ?? null,
    actorId: transition?.actorId ?? null,
    agentId: transition?.agentId ?? null,
    runId: transition?.runId ?? null,
    details: transition?.details ?? null,
    createdByAgentId: issue.createdByAgentId ?? null,
    createdByUserId: issue.createdByUserId ?? null,
  });
}

export async function resolveIssueReviewRequester(
  db: Db,
  issue: ReviewPolicyIssue,
): Promise<IssueReviewRequester | null> {
  const resolution = await resolveTransitionRequester(db, issue);
  return resolution.kind === "resolved" ? resolution.requester : null;
}

/**
 * Record who asked for review on a new transition.
 *
 * A write made with a person's credential while a run is executing is stamped
 * with that run's agent and flagged as mixed identity, so the gate and the
 * audit trail agree about the writer instead of recording the person.
 */
export async function buildIssueReviewRequesterForTransition(
  db: Db,
  input: {
    companyId: string;
    actorType: "agent" | "user";
    actorId: string;
    agentId?: string | null;
    runId?: string | null;
  },
): Promise<IssueReviewRequesterRecord | null> {
  const agentId = readString(input.agentId);
  const runId = readString(input.runId);
  if (input.actorType === "agent" && agentId) {
    return { type: "agent", id: agentId, runId };
  }
  const actorId = readString(input.actorId);
  if (!actorId) return null;
  if (input.actorType === "user" && runId) {
    const runAgentId = await resolveAgentIdForRun(db, input.companyId, runId);
    if (runAgentId) {
      logger.warn(
        {
          companyId: input.companyId,
          actorId,
          runId,
          agentId: runAgentId,
          reason: "board_credential_with_agent_run",
        },
        "review transition written with a board credential during an agent run; attributing it to the run's agent",
      );
      return { type: "agent", id: runAgentId, runId, mixedIdentity: true };
    }
  }
  return { type: "user", id: actorId, runId: null };
}

export async function isIssueReviewVerdictInteraction(
  db: Db,
  input: {
    issue: ReviewPolicyIssue;
    interaction: {
      id: string;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    };
  },
): Promise<boolean> {
  const resolution = await resolveTransitionRequester(db, input.issue);
  if (resolution.kind === "absent") return false;
  // An unattributable requester must stay a review verdict: dropping it here
  // would route the confirmation around the issue's review policy entirely.
  if (resolution.kind === "ambiguous") return true;
  const requester = resolution.requester;
  if (requester.reviewInteractionId && requester.reviewInteractionId !== input.interaction.id) return false;
  // Older review transitions did not persist the interaction binding. In that
  // case, an unattributed confirmation is ambiguous and must fail closed.
  // Confirmations attributed to an unrelated writer remain independently
  // resolvable, while requester-created confirmations inherit the issue policy.
  if (!requester.reviewInteractionId
    && !input.interaction.createdByAgentId
    && !input.interaction.createdByUserId) {
    return true;
  }
  // A confirmation the relayed person created is still this review's
  // confirmation even though the requester is recorded as the agent.
  if (requester.relayedUserId && input.interaction.createdByUserId === requester.relayedUserId) {
    return true;
  }
  return requester.type === "agent"
    ? input.interaction.createdByAgentId === requester.id
    : input.interaction.createdByUserId === requester.id;
}

export async function assertIssueReviewVerdictActorAllowed(
  db: Db,
  input: {
    issue: ReviewPolicyIssue;
    actor: IssueReviewVerdictActor;
    reviewPolicy?: IssueReviewPolicy | null;
  },
): Promise<void> {
  const policy = input.reviewPolicy ?? input.issue.reviewPolicy ?? "anyone";
  if (policy === "anyone") return;

  if (policy === "human_only") {
    if (input.actor.type === "user") return;
    throw forbidden(
      "Only a signed-in person can approve or reject this review; an agent cannot submit the verdict.",
      {
        code: "review_policy_denied",
        policy,
        allowedActor: "authenticated_user_with_issue_write_access",
        remediation: "Ask a person with access to this task to approve or reject it in Paperclip.",
      },
    );
  }

  const resolution = await resolveTransitionRequester(db, input.issue);
  if (resolution.kind !== "resolved") {
    throw forbidden(
      "Someone other than whoever sent this task for review must decide it, and Paperclip could not tell who sent it.",
      {
        code: "review_policy_denied",
        policy,
        allowedActor: "writer_other_than_review_requester",
        reason: resolution.kind === "ambiguous" ? resolution.reason : "requester_unknown",
        remediation: "Move the task out of review and back into review so Paperclip records who sent it, then have someone else submit the verdict.",
      },
    );
  }
  const requester = resolution.requester;
  // An agent acting for the requester is the requester, not a peer reviewer.
  // Only the requester side is compared: agents acting for different people
  // remain independent reviewers for each other.
  const relayedUserId = readString(input.actor.relayedUserId);
  if (input.actor.type === "agent"
    && relayedUserId
    && requester.type === "user"
    && relayedUserId === requester.id) {
    throw forbidden(
      "Whoever sent this task for review cannot also approve or reject it; someone else must submit the verdict.",
      {
        code: "review_policy_denied",
        policy,
        allowedActor: "writer_other_than_review_requester",
        reason: "mixed_identity",
        remediation: "Have someone else with access to this task submit the verdict.",
      },
    );
  }
  if (requester.type !== input.actor.type || requester.id !== input.actor.id) return;

  throw forbidden(
    "Whoever sent this task for review cannot also approve or reject it; someone else must submit the verdict.",
    {
      code: "review_policy_denied",
      policy,
      allowedActor: "writer_other_than_review_requester",
      remediation: "Have someone else with access to this task submit the verdict.",
    },
  );
}
