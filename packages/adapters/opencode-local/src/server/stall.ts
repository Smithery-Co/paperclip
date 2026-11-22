import {
  runningProcesses,
  signalRunningProcess,
} from "@paperclipai/adapter-utils/server-utils";

/**
 * Silence budget, in seconds, before a run whose provider stream has gone quiet is
 * stopped instead of being left to burn the full execution timeout.
 *
 * A healthy OpenCode run emits a JSONL record for every text delta, tool result and
 * step boundary, so minutes of total silence on both streams is a stalled provider
 * call, not work in progress.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_SEC = 900;

/** How often the guard samples elapsed silence. */
const DEFAULT_POLL_MS = 5_000;

export interface OpenCodeStreamStall {
  /** Silence observed when the guard tripped. */
  silenceMs: number;
  /** Silence budget in force when the guard tripped. */
  budgetMs: number;
  /** Last OpenCode JSONL record type seen before the silence started. */
  lastEventType: string | null;
  /** ISO timestamp of the last byte observed on either stream. */
  lastActivityAt: string;
  /** Operator-facing explanation, shared with the run result so it is not silent. */
  message: string;
}

export interface OpenCodeStreamGuard {
  /** Feed every stdout/stderr chunk so the guard sees activity and event type. */
  note(stream: "stdout" | "stderr", chunk: string): void;
  /** Evaluate the budget immediately. Exposed so tests do not depend on polling. */
  check(): void;
  /** Stop watching and release the timer. */
  stop(): void;
  /** Stall detail once the guard has tripped, otherwise null. */
  stall(): OpenCodeStreamStall | null;
}

export interface OpenCodeStreamGuardOptions {
  runId: string;
  /** Silence budget in seconds. `<= 0` disables the guard. */
  idleTimeoutSec: number;
  /** Grace period applied between SIGTERM and SIGKILL. */
  graceSec: number;
  /** Log sink for the trip notice. Ordinary run activity, not an error path. */
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  now?: () => number;
  pollMs?: number;
}

const EVENT_TYPE_RE = /"type"\s*:\s*"([a-z_]+)"/g;

/** Last OpenCode JSONL record type in a chunk, or null when the chunk has none. */
export function lastRecordType(chunk: string, previous: string | null): string | null {
  let last: string | null = null;
  for (const match of chunk.matchAll(EVENT_TYPE_RE)) last = match[1];
  return last ?? previous;
}

/**
 * Watches an OpenCode run for a silently stalled provider stream.
 *
 * OpenCode reports some provider failures only in its own log file, not on the JSONL
 * stdout stream, and then waits without emitting anything. The adapter previously saw
 * an event-free process that stayed alive, so the run ran until `timeoutSec` and
 * reported "execution timed out" — an hour of a two hour budget in the observed case.
 * This guard converts that silence into a fast, attributable stop.
 *
 * The guard only signals processes it can reach through the local run registry. A
 * remote/sandbox run has no local child to signal, so it records the stall and stops
 * watching rather than pretending it stopped anything.
 */
export function createOpenCodeStreamGuard(
  options: OpenCodeStreamGuardOptions,
): OpenCodeStreamGuard {
  const now = options.now ?? Date.now;
  const budgetMs = Math.max(0, options.idleTimeoutSec) * 1000;
  if (budgetMs <= 0) {
    return {
      note: () => {},
      check: () => {},
      stop: () => {},
      stall: () => null,
    };
  }

  let lastActivityAt = now();
  let lastEventType: string | null = null;
  let tripped: OpenCodeStreamStall | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let unreachable = false;

  const clearPoll = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const stop = () => {
    clearPoll();
    if (killTimer) clearTimeout(killTimer);
    killTimer = null;
  };

  const trip = (silenceMs: number) => {
    const silenceSec = Math.round(silenceMs / 1000);
    const budgetSec = Math.round(budgetMs / 1000);
    const lastEvent = lastEventType ?? "none";
    const message =
      `OpenCode produced no output for ${silenceSec}s (last record: ${lastEvent}); ` +
      `stopping the run instead of waiting for the execution timeout. ` +
      `Raise streamIdleTimeoutSec above ${budgetSec} for runs that legitimately sit this long.`;
    tripped = {
      silenceMs,
      budgetMs,
      lastEventType,
      lastActivityAt: new Date(lastActivityAt).toISOString(),
      message,
    };
    const handle = runningProcesses.get(options.runId);
    if (!handle) {
      // Remote/sandbox run: there is no local child to signal. Report the stall and
      // let the transport's own timeout end the run.
      unreachable = true;
      clearPoll();
      void options.onLog?.(
        "stderr",
        `[paperclip] ${message} This run is not a local child process, so the adapter cannot stop it.\n`,
      );
      return;
    }
    void options.onLog?.("stderr", `[paperclip] ${message}\n`);
    signalRunningProcess(handle, "SIGTERM");
    killTimer = setTimeout(() => {
      signalRunningProcess(handle, "SIGKILL");
    }, Math.max(1, options.graceSec) * 1000);
    killTimer.unref?.();
    clearPoll();
  };

  const check = () => {
    if (tripped || unreachable) return;
    const silenceMs = now() - lastActivityAt;
    if (silenceMs < budgetMs) return;
    trip(silenceMs);
  };

  pollTimer = setInterval(check, Math.min(options.pollMs ?? DEFAULT_POLL_MS, budgetMs));
  pollTimer.unref?.();

  return {
    note(stream, chunk) {
      if (!chunkHasActivity(chunk)) return;
      lastActivityAt = now();
      if (stream !== "stdout") return;
      const nextType = lastRecordType(chunk, lastEventType);
      if (nextType !== null) lastEventType = nextType;
    },
    check,
    stop,
    stall: () => tripped,
  };
}

/** Guard against a chunk being only whitespace, which is not real progress. */
export function chunkHasActivity(chunk: string): boolean {
  return chunk.trim().length > 0;
}
