const cancelledRuns = new Set<string>();
const controllers = new Map<string, AbortController>();

function normalizeRunId(runId: string | null | undefined) {
  return String(runId || "").trim();
}

export class RunCancelledError extends Error {
  runId: string;
  constructor(runId: string, message = "Run cancelled by user") {
    super(message);
    this.name = "RunCancelledError";
    this.runId = runId;
  }
}

export const runCancellationService = {
  register(runId: string) {
    const key = normalizeRunId(runId);
    if (!key) return null;
    let controller = controllers.get(key);
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      controllers.set(key, controller);
    }
    if (cancelledRuns.has(key) && !controller.signal.aborted) {
      controller.abort(new RunCancelledError(key));
    }
    return controller.signal;
  },

  getSignal(runId: string | null | undefined) {
    const key = normalizeRunId(runId);
    if (!key) return undefined;
    return this.register(key) || undefined;
  },

  cancel(runId: string | null | undefined) {
    const key = normalizeRunId(runId);
    if (!key) return false;
    cancelledRuns.add(key);
    const controller = controllers.get(key);
    if (controller && !controller.signal.aborted) {
      controller.abort(new RunCancelledError(key));
    }
    return true;
  },

  clear(runId: string | null | undefined) {
    const key = normalizeRunId(runId);
    if (!key) return;
    cancelledRuns.delete(key);
    controllers.delete(key);
  },

  isCancelled(runId: string | null | undefined) {
    const key = normalizeRunId(runId);
    return !!key && cancelledRuns.has(key);
  },

  throwIfCancelled(runId: string | null | undefined) {
    const key = normalizeRunId(runId);
    if (!key) return;
    if (cancelledRuns.has(key)) {
      throw new RunCancelledError(key);
    }
  },

  isCancellationError(error: unknown) {
    if (error instanceof RunCancelledError) return true;
    const name = String((error as any)?.name || "");
    const message = String((error as any)?.message || error || "").toLowerCase();
    return name === "AbortError" || message.includes("run cancelled by user") || message.includes("aborted");
  },
};
