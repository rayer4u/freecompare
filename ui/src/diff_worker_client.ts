import { computeTwoWayDiffCore } from "./diff_core.ts";
import type { DiffComputationResult } from "./diff_core.ts";
import type { DiffOptions, DiffRowFilter } from "./types.ts";
import type { WorkerRequest, WorkerResponse } from "./diff.worker.ts";

let workerInstance: Worker | null = null;
let reqCounter = 1;
const pendingCallbacks = new Map<
  number,
  {
    resolve: (res: DiffComputationResult) => void;
    reject: (err: Error) => void;
  }
>();

function getOrCreateWorker(): Worker | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return null;
  }
  if (!workerInstance) {
    try {
      workerInstance = new Worker(
        new URL("./diff.worker.ts", import.meta.url),
        { type: "module" }
      );
      workerInstance.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const { id, result, error } = e.data;
        const cb = pendingCallbacks.get(id);
        if (cb) {
          pendingCallbacks.delete(id);
          if (error) {
            cb.reject(new Error(error));
          } else if (result) {
            cb.resolve(result);
          }
        }
      };
      workerInstance.onerror = (err) => {
        console.error("Diff Worker error:", err);
      };
    } catch (e) {
      console.warn("Failed to instantiate Diff Worker, falling back to sync:", e);
      workerInstance = null;
    }
  }
  return workerInstance;
}

export function terminateWorker(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
    for (const [, cb] of pendingCallbacks) {
      cb.reject(new Error("Worker terminated"));
    }
    pendingCallbacks.clear();
  }
}

export async function computeDiffAsync(
  sessionId: string,
  leftText: string,
  rightText: string,
  options: DiffOptions,
  rowFilter: DiffRowFilter = "all"
): Promise<DiffComputationResult> {
  const worker = getOrCreateWorker();
  if (worker) {
    return new Promise<DiffComputationResult>((resolve, reject) => {
      const id = reqCounter++;
      pendingCallbacks.set(id, { resolve, reject });
      const req: WorkerRequest = {
        id,
        sessionId,
        leftText,
        rightText,
        options,
        rowFilter,
      };
      worker.postMessage(req);
    });
  }

  // Fallback for Node.js test environments or environments without Worker
  const splitLines = (txt: string) =>
    txt.length === 0 ? [] : txt.replace(/\r\n/g, "\n").split("\n");
  const leftLines = splitLines(leftText);
  const rightLines = splitLines(rightText);
  return Promise.resolve(
    computeTwoWayDiffCore(leftLines, rightLines, options, rowFilter)
  );
}
