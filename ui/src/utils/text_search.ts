import type { ViewportRowDto } from "../types.ts";

export type SearchScope = "both" | "left" | "right";

export interface SearchMatch {
  virtualIdx: number;
  side: "left" | "right";
  lineNo: number | null;
}

export interface GotoLineResult {
  virtualIdx: number;
  exact: boolean;
  actualLineNo: number | null;
}

/**
 * Searches `rows` for substring `query` in the specified pane scope.
 * In `"both"` scope, emits at most one match per `virtualIdx` so navigation steps cleanly row by row.
 */
export function findTextMatches(
  rows: readonly ViewportRowDto[],
  query: string,
  scope: SearchScope = "both",
  caseSensitive = false
): SearchMatch[] {
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];

  for (const row of rows) {
    const checkSide = (text: string | null): boolean => {
      if (text === null) return false;
      return caseSensitive
        ? text.includes(needle)
        : text.toLowerCase().includes(needle);
    };

    if (scope === "left") {
      if (checkSide(row.left_text)) {
        matches.push({
          virtualIdx: row.virtual_idx,
          side: "left",
          lineNo: row.left_line_no,
        });
      }
    } else if (scope === "right") {
      if (checkSide(row.right_text)) {
        matches.push({
          virtualIdx: row.virtual_idx,
          side: "right",
          lineNo: row.right_line_no,
        });
      }
    } else {
      if (checkSide(row.left_text)) {
        matches.push({
          virtualIdx: row.virtual_idx,
          side: "left",
          lineNo: row.left_line_no,
        });
      } else if (checkSide(row.right_text)) {
        matches.push({
          virtualIdx: row.virtual_idx,
          side: "right",
          lineNo: row.right_line_no,
        });
      }
    }
  }

  return matches;
}

/**
 * Finds the virtual row matching 1-based `lineNo` on `side`.
 * If the exact line is hidden (e.g. "diffs only" filter) or past EOF, falls back
 * to the nearest visible row on that side.
 */
export function findVirtualRowByLineNumber(
  rows: readonly ViewportRowDto[],
  lineNo1Based: number,
  side: "left" | "right"
): GotoLineResult | null {
  if (!Number.isFinite(lineNo1Based) || lineNo1Based < 1 || rows.length === 0) {
    return null;
  }
  const target = Math.floor(lineNo1Based);
  let lastValid: ViewportRowDto | null = null;

  for (const row of rows) {
    const ln = side === "left" ? row.left_line_no : row.right_line_no;
    if (ln === null) continue;
    lastValid = row;
    if (ln === target) {
      return {
        virtualIdx: row.virtual_idx,
        exact: true,
        actualLineNo: ln,
      };
    }
    if (ln > target) {
      return {
        virtualIdx: row.virtual_idx,
        exact: false,
        actualLineNo: ln,
      };
    }
  }

  if (lastValid) {
    const ln = side === "left" ? lastValid.left_line_no : lastValid.right_line_no;
    return {
      virtualIdx: lastValid.virtual_idx,
      exact: false,
      actualLineNo: ln,
    };
  }
  return null;
}


/**
 * Finds the index in `matches` of the first match at or after `startVirtualIdx`
 * (wrapping around to `0` if none exist after `startVirtualIdx`).
 */
export function findFirstMatchFromRow(
  matches: readonly SearchMatch[],
  startVirtualIdx: number
): number {
  if (matches.length === 0) return 0;
  const idx = matches.findIndex((m) => m.virtualIdx >= startVirtualIdx);
  return idx >= 0 ? idx : 0;
}

/**
 * Finds the index in `matches` of the last match at or before `startVirtualIdx`
 * (wrapping around to `matches.length - 1` if none exist before `startVirtualIdx`).
 */
export function findLastMatchBeforeRow(
  matches: readonly SearchMatch[],
  startVirtualIdx: number
): number {
  if (matches.length === 0) return 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].virtualIdx <= startVirtualIdx) {
      return i;
    }
  }
  return matches.length - 1;
}
