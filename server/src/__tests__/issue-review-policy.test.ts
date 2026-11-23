import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import {
  assertIssueReviewVerdictActorAllowed,
  buildIssueReviewRequesterForTransition,
  isIssueReviewVerdictInteraction,
  resolveIssueReviewRequester,
} from "../services/issue-review-policy.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue review verdict policy", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-review-policy-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedReview(policy: "not_creator" | "human_only") {
    const companyId = randomUUID();
    const requesterAgentId = randomUUID();
    const peerAgentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Review Policy Company",
      issuePrefix: "RPC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: requesterAgentId,
        companyId,
        name: "Requester",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: peerAgentId,
        companyId,
        name: "Peer reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const [issue] = await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review this",
      status: "in_review",
      priority: "medium",
      reviewPolicy: policy,
      createdByAgentId: requesterAgentId,
    }).returning();
    return { issue, companyId, requesterAgentId, peerAgentId };
  }

  it("does no database work for the default anyone policy", async () => {
    const noQueryDb = new Proxy({}, {
      get() {
        throw new Error("default policy must not query");
      },
    }) as Db;

    await expect(assertIssueReviewVerdictActorAllowed(noQueryDb, {
      issue: { id: randomUUID(), companyId: randomUUID(), reviewPolicy: null },
      actor: { type: "agent", id: randomUUID() },
    })).resolves.toBeUndefined();
  });

  it("blocks the in-review requester under not_creator and admits another agent", async () => {
    const seeded = await seedReview("not_creator");
    expect(seeded.issue.reviewPolicy).toBe("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.requesterAgentId,
      agentId: seeded.requesterAgentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: { status: "in_review", _previous: { status: "in_progress" } },
    });

    const denied = assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.requesterAgentId },
    });
    await expect(denied).rejects.toMatchObject<Partial<HttpError>>({
      status: 403,
      details: expect.objectContaining({
        code: "review_policy_denied",
        policy: "not_creator",
        allowedActor: "writer_other_than_review_requester",
      }),
      message: "Whoever sent this task for review cannot also approve or reject it; someone else must submit the verdict.",
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.peerAgentId },
    })).resolves.toBeUndefined();
  });

  it("ignores later in-review snapshots that did not record a status transition", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values([
      {
        companyId: seeded.companyId,
        actorType: "agent",
        actorId: seeded.requesterAgentId,
        agentId: seeded.requesterAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: seeded.issue.id,
        details: { status: "in_review", _previous: { status: "in_progress" } },
        createdAt: new Date("2026-08-06T00:00:00.000Z"),
      },
      {
        companyId: seeded.companyId,
        actorType: "agent",
        actorId: seeded.peerAgentId,
        agentId: seeded.peerAgentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: seeded.issue.id,
        details: { status: "in_review", priority: "high" },
        createdAt: new Date("2026-08-06T00:01:00.000Z"),
      },
    ]);

    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.requesterAgentId },
    })).rejects.toMatchObject<Partial<HttpError>>({
      status: 403,
      details: expect.objectContaining({ code: "review_policy_denied" }),
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.peerAgentId },
    })).resolves.toBeUndefined();
  });

  it("classifies only confirmations created by the review requester as review verdicts", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.requesterAgentId,
      agentId: seeded.requesterAgentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: {
        status: "in_review",
        reviewInteractionId: "review-confirmation",
        _previous: { status: "in_progress" },
      },
    });

    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "review-confirmation", createdByAgentId: seeded.requesterAgentId },
    })).resolves.toBe(true);
    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "review-confirmation", createdByAgentId: seeded.peerAgentId },
    })).resolves.toBe(false);
    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "requester-sibling", createdByAgentId: seeded.requesterAgentId },
    })).resolves.toBe(false);
  });

  it("classifies an unbound legacy confirmation only when the review requester created it", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.requesterAgentId,
      agentId: seeded.requesterAgentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: { status: "in_review", _previous: { status: "in_progress" } },
    });

    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "legacy-review", createdByAgentId: seeded.requesterAgentId },
    })).resolves.toBe(true);
    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "unrelated-confirmation", createdByAgentId: seeded.peerAgentId },
    })).resolves.toBe(false);
  });

  it("uses authenticated principal type for human_only", async () => {
    const seeded = await seedReview("human_only");
    expect(seeded.issue.reviewPolicy).toBe("human_only");
    const denied = assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.requesterAgentId },
    });
    await expect(denied).rejects.toMatchObject<Partial<HttpError>>({
      status: 403,
      details: expect.objectContaining({
        code: "review_policy_denied",
        policy: "human_only",
        allowedActor: "authenticated_user_with_issue_write_access",
        remediation: "Ask a person with access to this task to approve or reject it in Paperclip.",
      }),
      message: "Only a signed-in person can approve or reject this review; an agent cannot submit the verdict.",
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "user", id: "board-user" },
    })).resolves.toBeUndefined();
  });

  // THE-228 / THE-399: the in_review transition was written under the human's
  // board credential while an agent run executed, so the row says `user` but
  // its own execution snapshot names the agent. The author must not slip
  // through on the credential type mismatch.
  async function seedBoardCredentialedAgentTransition() {
    const seeded = await seedReview("not_creator");
    const machineRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: machineRunId,
      companyId: seeded.companyId,
      agentId: seeded.requesterAgentId,
      status: "succeeded",
      issueId: seeded.issue.id,
    });
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user-YPXEEXR9",
      agentId: null,
      runId: null,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: {
        status: "in_review",
        authorizationReason: "allow_board_actor",
        _previous: {
          status: "in_progress",
          executionRunId: machineRunId,
          checkoutRunId: machineRunId,
          executionAgentNameKey: "requester",
        },
      },
    });
    return { ...seeded, machineRunId };
  }

  it("resolves a board-credentialed transition to the executing agent", async () => {
    const seeded = await seedBoardCredentialedAgentTransition();
    await expect(resolveIssueReviewRequester(db, seeded.issue)).resolves.toMatchObject({
      type: "agent",
      id: seeded.requesterAgentId,
      runId: seeded.machineRunId,
      relayedUserId: "board-user-YPXEEXR9",
    });
  });

  it("blocks the executing agent's own verdict on a board-credentialed transition", async () => {
    const seeded = await seedBoardCredentialedAgentTransition();
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.requesterAgentId },
    })).rejects.toMatchObject<Partial<HttpError>>({
      status: 403,
      details: expect.objectContaining({
        code: "review_policy_denied",
        policy: "not_creator",
        allowedActor: "writer_other_than_review_requester",
      }),
    });
  });

  it("still admits a different agent after a board-credentialed transition", async () => {
    const seeded = await seedBoardCredentialedAgentTransition();
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.peerAgentId },
    })).resolves.toBeUndefined();
  });

  it("falls back to the agent name key when the run row does not resolve", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: {
        status: "in_review",
        authorizationReason: "allow_board_actor",
        _previous: {
          status: "in_progress",
          executionRunId: randomUUID(),
          executionAgentNameKey: "requester",
        },
      },
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.requesterAgentId },
    })).rejects.toMatchObject<Partial<HttpError>>({
      status: 403,
      details: expect.objectContaining({ code: "review_policy_denied" }),
    });
  });

  it("fails closed when agent execution metadata cannot be resolved to an agent", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: {
        status: "in_review",
        authorizationReason: "allow_board_actor",
        _previous: {
          status: "in_progress",
          executionRunId: randomUUID(),
          executionAgentNameKey: "deleted-agent",
        },
      },
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.peerAgentId },
    })).rejects.toMatchObject<Partial<HttpError>>({
      status: 403,
      details: expect.objectContaining({
        code: "review_policy_denied",
        reason: "agent_execution_unresolved",
      }),
    });
  });

  it("blocks a genuine board requester's own agent from the verdict", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: {
        status: "in_review",
        authorizationReason: "allow_board_actor",
        _previous: { status: "in_progress" },
      },
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.requesterAgentId, relayedUserId: "board-user" },
    })).rejects.toMatchObject<Partial<HttpError>>({
      status: 403,
      details: expect.objectContaining({
        code: "review_policy_denied",
        reason: "mixed_identity",
      }),
    });
  });

  it("admits distinct principals and an unrelated agent's relayed identity", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: {
        status: "in_review",
        authorizationReason: "allow_board_actor",
        _previous: { status: "in_progress" },
      },
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "user", id: "another-person" },
    })).resolves.toBeUndefined();
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.peerAgentId, relayedUserId: "another-person" },
    })).resolves.toBeUndefined();
  });

  it("persists the requester on a new transition instead of reinterpreting the snapshot", async () => {
    const seeded = await seedReview("not_creator");
    const persisted = await buildIssueReviewRequesterForTransition(db, {
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.requesterAgentId,
      agentId: seeded.requesterAgentId,
      runId: null,
    });
    expect(persisted).toEqual({ type: "agent", id: seeded.requesterAgentId, runId: null });
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.requesterAgentId,
      agentId: seeded.requesterAgentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: {
        status: "in_review",
        reviewRequester: persisted,
        _previous: { status: "in_progress" },
      },
    });
    await expect(resolveIssueReviewRequester(db, seeded.issue)).resolves.toMatchObject({
      type: "agent",
      id: seeded.requesterAgentId,
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.requesterAgentId },
    })).rejects.toMatchObject<Partial<HttpError>>({
      status: 403,
      details: expect.objectContaining({ code: "review_policy_denied" }),
    });
  });

  it("persists mixed identity when a board credential writes during a run", async () => {
    const seeded = await seedReview("not_creator");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: seeded.companyId,
      agentId: seeded.requesterAgentId,
      status: "running",
      issueId: seeded.issue.id,
    });
    await expect(buildIssueReviewRequesterForTransition(db, {
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      agentId: null,
      runId,
    })).resolves.toEqual({
      type: "agent",
      id: seeded.requesterAgentId,
      runId,
      relayedUserId: "board-user",
      mixedIdentity: true,
    });
  });

  it("keeps an unattributable transition a review verdict so the policy still applies", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: {
        status: "in_review",
        _previous: { status: "in_progress", executionAgentNameKey: "deleted-agent" },
      },
    });
    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "unbound", createdByUserId: "board-user" },
    })).resolves.toBe(true);
  });

  // THE-415: the persisted requester is written by the transition that created
  // it. When the runner omits `X-Paperclip-Run-Id` the write path cannot see
  // the live run and stamps the credential holder, so a persisted `user` must
  // not shadow an agent execution named by the same transition's snapshot.
  async function seedPersistedUserWithAgentExecution() {
    const seeded = await seedReview("not_creator");
    const requesterRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: requesterRunId,
      companyId: seeded.companyId,
      agentId: seeded.requesterAgentId,
      status: "succeeded",
      issueId: seeded.issue.id,
    });
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      agentId: null,
      runId: null,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: {
        status: "in_review",
        authorizationReason: "allow_board_actor",
        reviewRequester: { type: "user", id: "board-user", runId: null },
        _previous: { status: "in_progress", executionRunId: requesterRunId },
      },
    });
    return { ...seeded, requesterRunId };
  }

  it("does not let a persisted user requester shadow the agent execution snapshot", async () => {
    const seeded = await seedPersistedUserWithAgentExecution();
    await expect(resolveIssueReviewRequester(db, seeded.issue)).resolves.toMatchObject({
      type: "agent",
      id: seeded.requesterAgentId,
      runId: seeded.requesterRunId,
      relayedUserId: "board-user",
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.requesterAgentId },
    })).rejects.toMatchObject<Partial<HttpError>>({
      status: 403,
      details: expect.objectContaining({
        code: "review_policy_denied",
        policy: "not_creator",
        allowedActor: "writer_other_than_review_requester",
      }),
    });
  });

  it("still admits a different agent when a persisted user shadowed an execution", async () => {
    const seeded = await seedPersistedUserWithAgentExecution();
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.peerAgentId },
    })).resolves.toBeUndefined();
  });

  it("fails closed when a persisted user names an execution that cannot be resolved", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: {
        status: "in_review",
        reviewRequester: { type: "user", id: "board-user", runId: null },
        _previous: {
          status: "in_progress",
          executionRunId: randomUUID(),
          executionAgentNameKey: "deleted-agent",
        },
      },
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.peerAgentId },
    })).rejects.toMatchObject<Partial<HttpError>>({
      status: 403,
      details: expect.objectContaining({
        code: "review_policy_denied",
        reason: "agent_execution_unresolved",
      }),
    });
  });

  it("honours a persisted user requester when the transition names no agent execution", async () => {
    const seeded = await seedReview("not_creator");
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: {
        status: "in_review",
        reviewRequester: { type: "user", id: "board-user", runId: null },
        _previous: { status: "in_progress" },
      },
    });
    await expect(resolveIssueReviewRequester(db, seeded.issue)).resolves.toMatchObject({
      type: "user",
      id: "board-user",
    });
    await expect(assertIssueReviewVerdictActorAllowed(db, {
      issue: seeded.issue,
      actor: { type: "agent", id: seeded.peerAgentId },
    })).resolves.toBeUndefined();
  });

  it("persists the relayed person alongside a mixed-identity requester", async () => {
    const seeded = await seedReview("not_creator");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: seeded.companyId,
      agentId: seeded.requesterAgentId,
      status: "running",
      issueId: seeded.issue.id,
    });
    const persisted = await buildIssueReviewRequesterForTransition(db, {
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      agentId: null,
      runId,
    });
    expect(persisted).toEqual({
      type: "agent",
      id: seeded.requesterAgentId,
      runId,
      relayedUserId: "board-user",
      mixedIdentity: true,
    });
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issue.id,
      details: {
        status: "in_review",
        reviewRequester: persisted,
        _previous: { status: "in_progress" },
      },
    });
    await expect(resolveIssueReviewRequester(db, seeded.issue)).resolves.toMatchObject({
      type: "agent",
      id: seeded.requesterAgentId,
      runId,
      relayedUserId: "board-user",
    });
    // The relayed person's confirmation still belongs to this review.
    await expect(isIssueReviewVerdictInteraction(db, {
      issue: seeded.issue,
      interaction: { id: "unbound", createdByUserId: "board-user" },
    })).resolves.toBe(true);
  });

  it("attributes a board-credentialed write from the pre-update snapshot when the run id is missing", async () => {
    const seeded = await seedReview("not_creator");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: seeded.companyId,
      agentId: seeded.requesterAgentId,
      status: "running",
      issueId: seeded.issue.id,
    });
    await expect(buildIssueReviewRequesterForTransition(db, {
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      agentId: null,
      runId: null,
      existing: { executionRunId: runId, executionAgentNameKey: "requester" },
    })).resolves.toEqual({
      type: "agent",
      id: seeded.requesterAgentId,
      runId,
      relayedUserId: "board-user",
      mixedIdentity: true,
    });
  });

  it("refuses to record a persisted user when the snapshot names an unresolvable execution", async () => {
    const seeded = await seedReview("not_creator");
    await expect(buildIssueReviewRequesterForTransition(db, {
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      agentId: null,
      runId: null,
      existing: { executionAgentNameKey: "deleted-agent" },
    })).resolves.toBeNull();
  });

  it("does not record an agent transition that carries no agent id as a person", async () => {
    const seeded = await seedReview("not_creator");
    await expect(buildIssueReviewRequesterForTransition(db, {
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.requesterAgentId,
      agentId: null,
      runId: null,
    })).resolves.toBeNull();
  });
});
