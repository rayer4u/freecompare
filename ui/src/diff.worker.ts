import { computeTwoWayDiffCore } from "./diff_core.ts";
import type { DiffComputationResult } from "./diff_core.ts";
import type { DiffOptions, DiffRowFilter } from "./types.ts";

export interface WorkerRequest {
  id: number;
  sessionId: string;
  leftText: string;
  rightText: string;
  options: DiffOptions;
  rowFilter?: DiffRowFilter;
}

export interface WorkerResponse {
  id: number;
  sessionId: string;
  result?: DiffComputationResult;
  error?: string;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, sessionId, leftText, rightText, options, rowFilter } = e.data;
  try {
    const splitLines = (txt: string) =>
      txt.length === 0 ? [] : txt.replace(/\r\n/g, "\n").split("\n");
    const leftLines = splitLines(leftText);
    const rightLines = splitLines(rightText);
    const result = computeTwoWayDiffCore(
      leftLines,
      rightLines,
      options,
      rowFilter ?? "all"
    );
    self.postMessage({ id, sessionId, result } as WorkerResponse);
  } catch (err: unknown) {
    self.postMessage({
      id,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    } as WorkerResponse);
  }
};
