import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runningProcesses, type RunningProcess } from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_SEC,
  chunkHasActivity,
  createOpenCodeStreamGuard,
  lastRecordType,
} from "./stall.js";

const RUN_ID = "run-stall-fixture";

function fakeProcess(kill = vi.fn()): RunningProcess {
  return {
    child: { exitCode: null, signalCode: null, kill } as unknown as RunningProcess["child"],
    graceSec: 5,
    processGroupId: null,
  };
}

/** A clock the test advances by hand, so no test depends on real elapsed time. */
function manualClock(startMs = 1_000_000) {
  let current = startMs;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe("OpenCode stream stall guard", () => {
  beforeEach(() => runningProcesses.delete(RUN_ID));
  afterEach(() => {
    runningProcesses.delete(RUN_ID);
    vi.useRealTimers();
  });

  it("defaults to a bounded budget rather than waiting out the run timeout", () => {
    expect(DEFAULT_STREAM_IDLE_TIMEOUT_SEC).toBe(900);
  });

  it("does not trip while the stream is still producing records", () => {
    const clock = manualClock();
    const guard = createOpenCodeStreamGuard({
      runId: RUN_ID,
      idleTimeoutSec: 60,
      graceSec: 5,
      now: clock.now,
    });
    runningProcesses.set(RUN_ID, fakeProcess());

    for (let i = 0; i < 10; i += 1) {
      clock.advance(30_000);
      guard.note("stdout", '{"type":"text","part":{"text":"working"}}\n');
      guard.check();
    }

    expect(guard.stall()).toBeNull();
    guard.stop();
  });

  it("trips after the budget and SIGTERMs the local child", () => {
    const clock = manualClock();
    const child = fakeProcess();
    const guard = createOpenCodeStreamGuard({
      runId: RUN_ID,
      idleTimeoutSec: 60,
      graceSec: 5,
      now: clock.now,
    });
    runningProcesses.set(RUN_ID, child);

    guard.note("stdout", '{"type":"step_finish","part":{"reason":"tool-calls"}}\n');
    clock.advance(61_000);
    guard.check();

    const stall = guard.stall();
    expect(stall).not.toBeNull();
    expect(stall?.silenceMs).toBe(61_000);
    expect(stall?.budgetMs).toBe(60_000);
    // The last record tells an operator whether the run stalled on the model call.
    expect(stall?.lastEventType).toBe("step_finish");
    expect(stall?.message).toContain("no output for 61s");
    expect(stall?.message).toContain("step_finish");
    expect(child.child.kill).toHaveBeenCalledWith("SIGTERM");
    guard.stop();
  });

  it("escalates to SIGKILL after the grace period", () => {
    vi.useFakeTimers();
    const clock = manualClock();
    const child = fakeProcess();
    const guard = createOpenCodeStreamGuard({
      runId: RUN_ID,
      idleTimeoutSec: 60,
      graceSec: 7,
      now: clock.now,
    });
    runningProcesses.set(RUN_ID, child);

    clock.advance(61_000);
    guard.check();
    expect(child.child.kill).toHaveBeenCalledWith("SIGTERM");

    vi.advanceTimersByTime(7_000);
    expect(child.child.kill).toHaveBeenCalledWith("SIGKILL");
    guard.stop();
  });

  it("reports but cannot stop a run with no local child (remote/sandbox)", async () => {
    const clock = manualClock();
    const onLog = vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => {});
    const guard = createOpenCodeStreamGuard({
      runId: "run-remote-fixture",
      idleTimeoutSec: 60,
      graceSec: 5,
      onLog,
      now: clock.now,
    });

    clock.advance(61_000);
    guard.check();

    expect(guard.stall()?.message).toContain("no output for 61s");
    await vi.waitFor(() => expect(onLog).toHaveBeenCalled());
    expect(String(onLog.mock.calls[0]?.[1])).toContain("cannot stop it");
    guard.stop();
  });

  it("only counts real bytes as activity", () => {
    const clock = manualClock();
    const guard = createOpenCodeStreamGuard({
      runId: RUN_ID,
      idleTimeoutSec: 60,
      graceSec: 5,
      now: clock.now,
    });
    runningProcesses.set(RUN_ID, fakeProcess());

    clock.advance(61_000);
    guard.note("stdout", "   \n\n");
    guard.check();

    expect(guard.stall()).not.toBeNull();
    guard.stop();
  });

  it("is inert when disabled", () => {
    const clock = manualClock();
    const child = fakeProcess();
    const guard = createOpenCodeStreamGuard({
      runId: RUN_ID,
      idleTimeoutSec: 0,
      graceSec: 5,
      now: clock.now,
    });
    runningProcesses.set(RUN_ID, child);

    clock.advance(10 * 60 * 1000);
    guard.check();

    expect(guard.stall()).toBeNull();
    expect(child.child.kill).not.toHaveBeenCalled();
    guard.stop();
  });
});

describe("lastRecordType", () => {
  it("takes the newest record in a multi-record chunk", () => {
    const chunk = [
      '{"type":"text","part":{"text":"a"}}',
      '{"type":"tool_use","part":{}}',
      '{"type":"step_finish","part":{"reason":"tool-calls"}}',
    ].join("\n");
    expect(lastRecordType(chunk, null)).toBe("step_finish");
  });

  it("keeps the previous type when a chunk carries no record", () => {
    expect(lastRecordType("not json at all\n", "text")).toBe("text");
  });
});

describe("chunkHasActivity", () => {
  it("ignores whitespace-only chunks", () => {
    expect(chunkHasActivity("  \n\t ")).toBe(false);
    expect(chunkHasActivity('{"type":"text"}')).toBe(true);
  });
});
