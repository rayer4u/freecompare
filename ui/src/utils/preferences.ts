import type { ThreeWayHunk } from "../types.ts";

export const DEFAULT_FOLDER_EXCLUDE_GLOBS = [
  ".git",
  "node_modules",
  "target",
  ".DS_Store",
] as const;

export function parseGlobsInput(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Merges user preference exclude globs with CLI `-filters` arguments.
 * Preserves an explicitly empty `prefsGlobs` array (`[]`), only falling back to
 * `DEFAULT_FOLDER_EXCLUDE_GLOBS` when `prefsGlobs` is null/undefined.
 */
export function mergeFolderExcludeGlobs(
  prefsGlobs?: readonly string[] | null,
  cliFilters?: readonly string[] | null
): string[] {
  const base =
    prefsGlobs !== undefined && prefsGlobs !== null
      ? prefsGlobs
      : DEFAULT_FOLDER_EXCLUDE_GLOBS;

  const result: string[] = [];
  const seen = new Set<string>();

  const pushUnique = (pat: string) => {
    const trimmed = pat.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    result.push(trimmed);
  };

  for (const g of base) {
    pushUnique(g);
  }

  if (cliFilters) {
    for (const raw of cliFilters) {
      let pat = raw.trim();
      if (!pat || pat.startsWith("+")) continue;
      if (pat.startsWith("-")) {
        pat = pat.slice(1).trim();
      }
      pat = pat.replace(/[/\\]+$/, "");
      pushUnique(pat);
    }
  }

  return result;
}

export interface HunkNavResult {
  nextIdx: number;
  boundary: "first" | "last" | null;
}

/**
 * Computes the next hunk index respecting `wrapAround` navigation boundaries.
 */
export function computeNextHunkIndex(
  currentIdx: number,
  totalHunks: number,
  delta: number,
  wrapAround: boolean
): HunkNavResult {
  if (totalHunks <= 0) {
    return { nextIdx: 0, boundary: null };
  }
  const clampedCur = Math.max(0, Math.min(currentIdx, totalHunks - 1));
  if (delta === 0) {
    return { nextIdx: clampedCur, boundary: null };
  }

  if (wrapAround) {
    const wrapped = (((clampedCur + delta) % totalHunks) + totalHunks) % totalHunks;
    return { nextIdx: wrapped, boundary: null };
  }

  const candidate = clampedCur + delta;
  if (candidate < 0) {
    return { nextIdx: 0, boundary: "first" };
  }
  if (candidate >= totalHunks) {
    return { nextIdx: totalHunks - 1, boundary: "last" };
  }
  return { nextIdx: candidate, boundary: null };
}

export interface ThreeWayNavResult {
  targetHunk: ThreeWayHunk | null;
  boundary: "first" | "last" | null;
}

/**
 * Selects the next or previous 3-way hunk for navigation.
 * Prioritizes unresolved/conflict hunks when any conflict exists; otherwise navigates all hunks.
 */
export function computeThreeWayNavTarget(
  hunks: readonly ThreeWayHunk[],
  activeHunkId: number | null,
  delta: number,
  wrapAround = true
): ThreeWayNavResult {
  if (hunks.length === 0) {
    return { targetHunk: null, boundary: null };
  }
  const conflicts = hunks.filter((h) => h.status === "conflict");
  const navList = conflicts.length > 0 ? conflicts : hunks;
  const curIdx = activeHunkId === null
    ? -1
    : navList.findIndex((h) => h.id === activeHunkId);

  if (curIdx === -1) {
    if (delta >= 0) {
      return { targetHunk: navList[0], boundary: null };
    }
    return {
      targetHunk: wrapAround ? navList[navList.length - 1] : navList[0],
      boundary: null,
    };
  }

  const { nextIdx, boundary } = computeNextHunkIndex(
    curIdx,
    navList.length,
    delta,
    wrapAround
  );
  return { targetHunk: navList[nextIdx], boundary };
}

/**
 * Formats line text with optional visible whitespace glyphs and configurable tab width.
 */
export function formatGlyphText(
  text: string,
  showGlyphs?: boolean,
  tabWidth = 4
): string {
  if (!showGlyphs) return text;
  const width = Math.max(1, Math.min(16, Math.floor(tabWidth) || 4));
  const tabReplacement = "→" + " ".repeat(width - 1);
  return text.replace(/ /g, "·").replace(/\t/g, tabReplacement);
}

/**
 * Returns true if a modal, context menu, or dropdown menu is currently open
 * and must consume Escape before the global App shortcut can exit/approve.
 */
export function shouldBlockGlobalEscape(opts: {
  showSettings?: boolean;
  showAbout?: boolean;
  doc?: Pick<Document, "querySelector"> | null;
}): boolean {
  if (opts.showSettings || opts.showAbout) {
    return true;
  }
  if (opts.doc) {
    const openOverlay = opts.doc.querySelector(
      ".modal-backdrop, .app-context-menu, .folder-context-menu, .app-dropdown-menu, .inline-search-bar"
    );
    if (openOverlay) {
      return true;
    }
  }
  return false;
}
