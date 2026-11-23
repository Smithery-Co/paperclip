import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  heartbeatRuns,
  instanceUserRoles,
  issues,
  agents,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createDbState(input: {
  boardKey: { id: string; userId: string; token: string };
  companyIds?: string[];
  run?: { id: string; status: string };
  issue?: { id: string; executionRunId?: string | null; checkoutRunId?: string | null };
  issueRuns?: Array<{ id: string; status: string }>;
}) {
  const activity: Array<Record<string, unknown>> = [];
  const boardKeyRow = {
    ...input.boardKey,
    keyHash: hashToken(input.boardKey.token),
    revokedAt: null,
    expiresAt: null,
  };
  const user = { id: input.boardKey.userId, name: "Board Human", email: null };
  const memberships = (input.companyIds ?? []).map((companyId) => ({
    companyId,
    membershipRole: "member",
    status: "active",
  }));
  const runRow = input.run
    ? { id: input.run.id, status: input.run.status }
    : null;
  const issueRow = input.issue ? {
    id: input.issue.id,
    executionRunId: input.issue.executionRunId ?? null,
    checkoutRunId: input.issue.checkoutRunId ?? null,
  } : null;
  const issueRuns = input.issueRuns ?? [];

  const db = {
    select: () => ({
      from(table: unknown) {
        return {
          where() {
            if (table === boardApiKeys) return Promise.resolve([boardKeyRow]);
            if (table === authUsers) return Promise.resolve([user]);
            if (table === companyMemberships) return Promise.resolve(memberships);
            if (table === instanceUserRoles) return Promise.resolve([]);
            if (table === heartbeatRuns) {
              return Promise.resolve(runRow ? [runRow] : issueRuns);
            }
            if (table === issues) return Promise.resolve(issueRow ? [issueRow] : []);
            if (table === agentApiKeys) return Promise.resolve([]);
            if (table === agents) return Promise.resolve([]);
            if (table === companies) return Promise.resolve([]);
            return Promise.resolve([]);
          },
        };
      },
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
    insert: (table: unknown) => ({
      values(values: Record<string, unknown>) {
        if (table === activityLog) activity.push(values);
        return Promise.resolve([]);
      },
    }),
  } as any;

  return { db, activity };
}

function createApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
  app.get("/actor", (req, res) => res.json(req.actor));
  app.patch("/companies/:companyId/issues/:issueId", (_req, res) => res.json({ written: true }));
  app.post("/companies/:companyId/issues/:issueId/comments", (_req, res) => res.json({ written: true }));
  app.use(errorHandler);
  return app;
}

describe("board credential with agent run guard", () => {
  const userId = "YPXEEXR9ChSECl08WzVu6OerkCsawMtI";
  const companyId = randomUUID();
  const boardKey = { id: randomUUID(), userId, token: `pcp_board_${"a".repeat(48)}` };

  it.each(["patch", "post"] as const)(
    "refuses a %s made with a board key that carries an agent run id",
    async (verb) => {
      const runId = randomUUID();
      const { db, activity } = createDbState({
        boardKey,
        companyIds: [companyId],
        run: { id: runId, status: "running" },
      });
      const path = verb === "patch"
        ? `/companies/${companyId}/issues/${randomUUID()}`
        : `/companies/${companyId}/issues/${randomUUID()}/comments`;
      const client = request(createApp(db))[verb](path)
        .set("Authorization", `Bearer ${boardKey.token}`)
        .set("X-Paperclip-Run-Id", runId)
        .send({ status: "in_review" });

      const res = await client;

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("board_credential_with_agent_run");
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({
        companyId,
        actorType: "user",
        actorId: userId,
        action: "auth.board_credential_with_agent_run_refused",
        entityType: "heartbeat_run",
        runId,
      });
      expect((activity[0].details as Record<string, unknown>)).toMatchObject({
        boardApiKeyId: boardKey.id,
        mixedIdentity: true,
        activeRun: true,
        runIdSource: "run_id_header",
        authorizationReason: "board_credential_with_agent_run",
      });
    },
  );

  it("refuses a board-key status write with no run-id header while the issue is locked to a live run", async () => {
    const runId = randomUUID();
    const issueId = randomUUID();
    const { db, activity } = createDbState({
      boardKey,
      companyIds: [companyId],
      issue: { id: issueId, executionRunId: runId },
      issueRuns: [{ id: runId, status: "running" }],
    });

    const res = await request(createApp(db))
      .patch(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${boardKey.token}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("board_credential_with_agent_run");
    expect(activity[0]).toMatchObject({ runId });
    expect((activity[0].details as Record<string, unknown>)).toMatchObject({
      mixedIdentity: true,
      activeRun: true,
      runIdSource: "issue_execution_lock",
    });
  });

  it("refuses a board-key status write when only checkoutRunId holds the live run", async () => {
    const runId = randomUUID();
    const issueId = randomUUID();
    const { db, activity } = createDbState({
      boardKey,
      companyIds: [companyId],
      issue: { id: issueId, checkoutRunId: runId },
      issueRuns: [{ id: runId, status: "running" }],
    });

    const res = await request(createApp(db))
      .patch(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${boardKey.token}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("board_credential_with_agent_run");
    expect(activity[0]).toMatchObject({ runId });
    expect((activity[0].details as Record<string, unknown>).runIdSource).toBe("issue_execution_lock");
  });

  it("fails closed for a stale or malformed run id, without writing a run FK", async () => {
    const staleRunId = "not-a-uuid";
    const { db, activity } = createDbState({ boardKey, companyIds: [companyId] });

    const res = await request(createApp(db))
      .patch(`/companies/${companyId}/issues/${randomUUID()}`)
      .set("Authorization", `Bearer ${boardKey.token}`)
      .set("X-Paperclip-Run-Id", staleRunId)
      .send({ status: "in_review" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("board_credential_with_agent_run");
    expect(activity[0]).toMatchObject({ action: "auth.board_credential_with_agent_run_refused" });
    expect(activity[0]).not.toHaveProperty("runId");
    expect((activity[0].details as Record<string, unknown>).activeRun).toBe(false);
  });

  it("still allows board-key reads that carry a run id", async () => {
    const runId = randomUUID();
    const { db, activity } = createDbState({
      boardKey,
      companyIds: [companyId],
      run: { id: runId, status: "running" },
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${boardKey.token}`)
      .set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "board", source: "board_key", runId });
    expect(activity).toHaveLength(0);
  });

  it("leaves a board-key write without a run id unchanged", async () => {
    const { db, activity } = createDbState({ boardKey, companyIds: [companyId] });

    const res = await request(createApp(db))
      .patch(`/companies/${companyId}/issues/${randomUUID()}`)
      .set("Authorization", `Bearer ${boardKey.token}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ written: true });
    expect(activity).toHaveLength(0);
  });

  it("allows a board-key write after the issue's run has settled", async () => {
    const runId = randomUUID();
    const issueId = randomUUID();
    const { db, activity } = createDbState({
      boardKey,
      companyIds: [companyId],
      issue: { id: issueId, executionRunId: runId },
      issueRuns: [{ id: runId, status: "succeeded" }],
    });

    const res = await request(createApp(db))
      .patch(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${boardKey.token}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(activity).toHaveLength(0);
  });
});
