import type { FolderEntryDto, FolderSubtreeResult } from "../types";

/**
 * Collect directories that were both scanned on demand and currently expanded,
 * ordered shallow-to-deep so parent directories are re-populated before nested children.
 */
export function collectExpandedLoadedDirs(
  scannedDirs: ReadonlySet<string>,
  collapsedDirs: ReadonlySet<string>
): string[] {
  return Array.from(scannedDirs)
    .filter((dir) => !collapsedDirs.has(dir))
    .sort((a, b) => {
      const depthDiff = a.split("/").length - b.split("/").length;
      return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
    });
}

/**
 * Merge a freshly scanned subtree result under its parent directory entry,
 * replacing any previously cached descendants and updating the parent's status.
 */
export function mergeSubtreeEntries(
  entries: readonly FolderEntryDto[],
  subtree: FolderSubtreeResult
): FolderEntryDto[] {
  const cleanRel = subtree.relative_path;
  const prefix = cleanRel + "/";
  const parentIdx = entries.findIndex((e) => e.relative_path === cleanRel);
  if (parentIdx < 0) return entries.slice();

  const updated = entries.slice();
  updated[parentIdx] = { ...updated[parentIdx], status: subtree.status };

  let removeCount = 0;
  for (let i = parentIdx + 1; i < updated.length; i++) {
    if (updated[i].relative_path.startsWith(prefix)) {
      removeCount++;
    } else {
      break;
    }
  }
  updated.splice(parentIdx + 1, removeCount, ...subtree.entries);
  return updated;
}

/**
 * Merge top-level rescan entries while preserving already-loaded descendants
 * of directories that were not invalidated (e.g. deleted or overwritten dirs).
 */
export function mergeTopLevelPreservingSubtrees(
  prevEntries: readonly FolderEntryDto[],
  nextTopEntries: readonly FolderEntryDto[],
  invalidatedDir?: string | ReadonlySet<string>
): FolderEntryDto[] {
  const subtreesByTopDir = new Map<string, FolderEntryDto[]>();
  const invalidatedList = !invalidatedDir
    ? []
    : typeof invalidatedDir === "string"
    ? [invalidatedDir]
    : Array.from(invalidatedDir);
  const invalidatedSet = new Set(invalidatedList);

  const isInvalidated = (relPath: string) =>
    invalidatedSet.has(relPath) ||
    invalidatedList.some((dir) => relPath.startsWith(dir + "/"));

  for (const entry of prevEntries) {
    const slashIdx = entry.relative_path.indexOf("/");
    if (slashIdx <= 0) continue;
    if (isInvalidated(entry.relative_path)) {
      continue;
    }
    const topDir = entry.relative_path.slice(0, slashIdx);
    let list = subtreesByTopDir.get(topDir);
    if (!list) {
      list = [];
      subtreesByTopDir.set(topDir, list);
    }
    list.push(entry);
  }

  const merged: FolderEntryDto[] = [];
  for (const top of nextTopEntries) {
    merged.push(top);
    if (top.is_dir && !invalidatedSet.has(top.relative_path)) {
      const children = subtreesByTopDir.get(top.relative_path);
      if (children && children.length > 0) {
        merged.push(...children);
      }
    }
  }
  return merged;
}

/**
 * Resolve the effective list of relative paths for a context-menu batch action.
 * If the right-clicked path is not part of the current selection, only that path is targeted;
 * otherwise all unique selected paths are returned (excluding descendants covered by a selected ancestor dir).
 */
export function resolveBatchTargetPaths(
  clickedRelPath: string,
  selectedRelPaths: readonly string[]
): string[] {
  if (!selectedRelPaths.includes(clickedRelPath) || selectedRelPaths.length <= 1) {
    return [clickedRelPath];
  }
  const unique = Array.from(new Set(selectedRelPaths));
  const sortedShallowFirst = unique.slice().sort((a, b) => {
    const depthDiff = a.split("/").length - b.split("/").length;
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
  });
  const kept: string[] = [];
  for (const p of sortedShallowFirst) {
    const coveredByAncestor = kept.some((anc) => p.startsWith(anc + "/"));
    if (!coveredByAncestor) {
      kept.push(p);
    }
  }
  // Preserve original selection order for deterministic execution
  const keptSet = new Set(kept);
  return unique.filter((p) => keptSet.has(p));
}
