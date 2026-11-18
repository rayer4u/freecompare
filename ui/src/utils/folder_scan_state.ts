import type { FolderScanProgressEvent } from "../bridge.ts";

export interface FolderScanProgress {
  dirsScanned: number;
  itemsFound: number;
}

export type FolderScanOutcome<T> =
  | { status: "completed"; result: T }
  | { status: "empty" }
  | { status: "cancelled" }
  | { status: "stale" }
  | { status: "error"; error: unknown };

export interface FolderScanControllerCallbacks {
  onScanningChange: (scanning: boolean) => void;
  onProgressChange: (progress: FolderScanProgress) => void;
  cancelRpc: (scanId: string) => Promise<unknown> | void;
  idPrefix?: string;
}

export function isScanCancelledError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (
    msg.includes("SCAN_CANCELLED") ||
    msg.toLowerCase().includes("scan cancelled")
  );
}

/**
 * Coordinates folder scan lifecycle with monotonic `scanSeq` stale-response discarding,
 * cooperative cancellation of superseded in-flight scans, and `scan_id`-filtered progress.
 */
export function createFolderScanController(
  callbacks: FolderScanControllerCallbacks
) {
  let scanSeq = 0;
  let activeScanId: string | null = null;
  let idCounter = 0;
  const prefix = callbacks.idPrefix ?? "scan";

  const getActiveScanId = () => activeScanId;
  const getScanSeq = () => scanSeq;

  const cancelActiveScan = (): string | null => {
    const id = activeScanId;
    if (!id) return null;
    scanSeq += 1;
    activeScanId = null;
    callbacks.onScanningChange(false);
    Promise.resolve(callbacks.cancelRpc(id)).catch(() => {});
    return id;
  };

  const handleProgress = (ev: FolderScanProgressEvent): boolean => {
    if (!activeScanId || ev.scan_id !== activeScanId) {
      return false;
    }
    callbacks.onProgressChange({
      dirsScanned: ev.dirs_scanned,
      itemsFound: ev.items_found,
    });
    return true;
  };

  const runScan = async <T>(
    execute: (scanId: string) => Promise<T | null>
  ): Promise<FolderScanOutcome<T>> => {
    if (activeScanId) {
      Promise.resolve(callbacks.cancelRpc(activeScanId)).catch(() => {});
    }

    const seq = ++scanSeq;
    const scanId = `${prefix}-${Date.now()}-${++idCounter}`;
    activeScanId = scanId;
    callbacks.onProgressChange({ dirsScanned: 0, itemsFound: 0 });
    callbacks.onScanningChange(true);

    try {
      const result = await execute(scanId);
      if (seq !== scanSeq) {
        return { status: "stale" };
      }
      activeScanId = null;
      callbacks.onScanningChange(false);
      if (result) {
        return { status: "completed", result };
      }
      return { status: "empty" };
    } catch (err) {
      if (seq !== scanSeq) {
        return { status: "stale" };
      }
      activeScanId = null;
      callbacks.onScanningChange(false);
      if (isScanCancelledError(err)) {
        return { status: "cancelled" };
      }
      return { status: "error", error: err };
    }
  };

  return {
    runScan,
    cancelActiveScan,
    handleProgress,
    getActiveScanId,
    getScanSeq,
  };
}
