import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { runningProcesses, type RunningProcess } from "@paperclipai/adapter-utils/server-utils";

const mocks = vi.hoisted(() => ({
  process: vi.fn(), restore: vi.fn(), stop: vi.fn(),
}));
vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(),
  prepareAdapterExecutionTargetRuntime: vi.fn(async () => ({
    runtimeRootDir: "/workspace/runtime", workspaceRemoteDir: "/workspace",
    assetDirs: {}, restoreWorkspace: mocks.restore,
  })),
  readAdapterExecutionTargetHomeDir: vi.fn(async () => "/home/fixture"),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({ env: {}, stop: mocks.stop })),
  runAdapterExecutionTargetProcess: mocks.process,
}));
import { execute } from "./execute.js";

/**
 * Regression cover for a provider failure that OpenCode records only in its own log
 * file. The CLI stays alive with nothing on stdout or stderr, so before the stall
 * guard the run burned the whole `timeoutSec` and reported "OpenCode execution timed
 * out". Two observed runs did that for 3608s and 3612s at a 3600s budget.
 */
describe("OpenCode stream stall reporting", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-stall-"));
    vi.stubEnv("XDG_CONFIG_HOME", dir);
    mocks.process.mockReset();
    mocks.restore.mockReset().mockResolvedValue(undefined);
    mocks.stop.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const context = (config: Record<string, unknown>): AdapterExecutionContext => ({
    runId: "run-stall-fixture",
    agent: { id: "agent-fixture", companyId: "company-fixture", name: "Fixture", adapterType: "opencode_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "opencode", model: "openai/fixture", cwd: dir,
      // Skip the `opencode models` availability probe: these fixtures are not the CLI.
      env: { OPENCODE_ALLOW_ALL_MODELS: "1" }, ...config },
    context: {},
    onLog: async () => {},
  });

  it("stops a silent run early and names the stall instead of the timeout", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target");
    mocks.process.mockImplementation(actual.runAdapterExecutionTargetProcess);
    // A child that emits one record and then produces nothing, like the observed runs.
    const command = path.join(dir, "fixture-opencode");
    await fs.writeFile(
      command,
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: "step_finish", part: { reason: "tool-calls" } }));\nsetInterval(() => {}, 1000);\n',
      { mode: 0o755 },
    );

    const startedAt = Date.now();
    const result = await execute(context({
      command,
      timeoutSec: 600,
      graceSec: 0.1,
      streamIdleTimeoutSec: 0.3,
    }));
    const elapsedMs = Date.now() - startedAt;

    expect(result).toMatchObject({
      timedOut: false,
      errorCode: "opencode_stream_stalled",
      resultJson: { adapterExecutionTimeout: { timeoutSec: 600, source: "configured" } },
    });
    expect(result.errorMessage).toContain("produced no output");
    expect(result.errorMessage).toContain("step_finish");
    expect(result.errorMessage).not.toContain("execution timed out");
    // The whole point: it stops on the silence budget, not the execution deadline.
    expect(elapsedMs).toBeLessThan(30_000);
    expect(runningProcesses.has("run-stall-fixture")).toBe(false);
  }, 60_000);

  it("leaves a run that keeps producing output to the execution deadline", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target");
    mocks.process.mockImplementation(actual.runAdapterExecutionTargetProcess);
    const command = path.join(dir, "fixture-chatty-opencode");
    await fs.writeFile(
      command,
      '#!/usr/bin/env node\nconst t = setInterval(() => console.log(JSON.stringify({ type: "text", part: { text: "tick" } })), 100);\nsetTimeout(() => { clearInterval(t); process.exit(0); }, 1200);\n',
      { mode: 0o755 },
    );

    const result = await execute(context({
      command,
      timeoutSec: 30,
      graceSec: 0.1,
      streamIdleTimeoutSec: 0.3,
    }));

    expect(result.errorCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it("keeps the existing timeout result when the budget is disabled", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target");
    mocks.process.mockImplementation(actual.runAdapterExecutionTargetProcess);
    const command = path.join(dir, "fixture-idle-opencode");
    await fs.writeFile(command, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });

    const result = await execute(context({
      command,
      timeoutSec: 0.3,
      graceSec: 0.1,
      streamIdleTimeoutSec: 0,
    }));

    expect(result).toMatchObject({
      timedOut: true,
      signal: "SIGTERM",
      errorMessage: "OpenCode execution timed out",
    });
  }, 60_000);
});
