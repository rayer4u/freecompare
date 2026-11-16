import type {
  DiffOptions,
  DiffRowFilter,
  DiffStatus,
  DiffStats,
  InlineSegment,
  TwoWayHunk,
  ViewportRowDto,
} from "./types.ts";

export interface DiffOp {
  type: "eq" | "del" | "ins";
  l?: number;
  r?: number;
}

const INTRA_HUNK_PAIR_THRESHOLD = 0.38;

export function normalizeLine(text: string, options: DiffOptions): string {
  let s = text;
  if (options.ignore_case) s = s.toLowerCase();
  if (options.ignore_whitespace) s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function tokenizeLine(text: string): string[] {
  const tokens: string[] = [];
  const re = /[a-zA-Z0-9_]+|[^\s\w]+|\s+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    tokens.push(match[0]);
  }
  return tokens;
}

export function computeInlineSegments(
  a: string,
  b: string
): [InlineSegment[], InlineSegment[]] {
  if (a === b) {
    return [[{ text: a, tag: "equal" }], [{ text: b, tag: "equal" }]];
  }

  const aTokens = tokenizeLine(a);
  const bTokens = tokenizeLine(b);
  const n = aTokens.length;
  const m = bTokens.length;

  if (n === 0 && m === 0) return [[], []];
  if (n === 0) return [[], [{ text: b, tag: "insert" }]];
  if (m === 0) return [[{ text: a, tag: "delete" }], []];

  if (n * m > 40000) {
    return [[{ text: a, tag: "delete" }], [{ text: b, tag: "insert" }]];
  }

  const maxD = Math.min(n + m, 500);
  const vOffset = maxD;
  const V = new Int32Array(2 * maxD + 1);
  const trace: Int32Array[] = [];

  let foundD = -1;
  for (let d = 0; d <= maxD; d++) {
    trace.push(new Int32Array(V));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && V[k - 1 + vOffset] < V[k + 1 + vOffset])) {
        x = V[k + 1 + vOffset];
      } else {
        x = V[k - 1 + vOffset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && aTokens[x] === bTokens[y]) {
        x++;
        y++;
      }
      V[k + vOffset] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    if (foundD >= 0) break;
  }

  if (foundD < 0) {
    return [[{ text: a, tag: "delete" }], [{ text: b, tag: "insert" }]];
  }

  let curX = n;
  let curY = m;
  const ops: Array<{ type: "eq" | "del" | "ins"; tok: string }> = [];

  for (let d = foundD; d > 0; d--) {
    const vPrev = trace[d];
    const k = curX - curY;
    let prevK: number;
    if (k === -d || (k !== d && vPrev[k - 1 + vOffset] < vPrev[k + 1 + vOffset])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[prevK + vOffset];
    const prevY = prevX - prevK;

    while (curX > prevX && curY > prevY) {
      curX--;
      curY--;
      ops.push({ type: "eq", tok: aTokens[curX] });
    }
    if (curX === prevX) {
      curY--;
      ops.push({ type: "ins", tok: bTokens[curY] });
    } else {
      curX--;
      ops.push({ type: "del", tok: aTokens[curX] });
    }
  }
  while (curX > 0 && curY > 0) {
    curX--;
    curY--;
    ops.push({ type: "eq", tok: aTokens[curX] });
  }
  ops.reverse();

  const lSegments: InlineSegment[] = [];
  const rSegments: InlineSegment[] = [];

  for (const op of ops) {
    if (op.type === "eq") {
      lSegments.push({ text: op.tok, tag: "equal" });
      rSegments.push({ text: op.tok, tag: "equal" });
    } else if (op.type === "del") {
      lSegments.push({ text: op.tok, tag: "delete" });
    } else if (op.type === "ins") {
      rSegments.push({ text: op.tok, tag: "insert" });
    }
  }

  const collapse = (segs: InlineSegment[]) => {
    const res: InlineSegment[] = [];
    for (const seg of segs) {
      if (res.length > 0 && res[res.length - 1].tag === seg.tag) {
        res[res.length - 1].text += seg.text;
      } else {
        res.push({ ...seg });
      }
    }
    return res;
  };

  return [collapse(lSegments), collapse(rSegments)];
}

/**
 * Computes structural similarity in `[0.0, 1.0]` between two lines using
 * Dice coefficient over sorted character bigrams, matching Rust's `line_similarity`.
 * Prevents pairing pure comment lines (`//` or `#`) with non-comment code lines.
 */
export function lineSimilarity(a: string, b: string): number {
  const aTrim = a.trim();
  const bTrim = b.trim();
  if (aTrim.length === 0 && bTrim.length === 0) return 1.0;
  if (aTrim.length === 0 || bTrim.length === 0) return 0.0;
  if (aTrim === bTrim) return 1.0;

  const aIsComment = aTrim.startsWith("//") || aTrim.startsWith("#");
  const bIsComment = bTrim.startsWith("//") || bTrim.startsWith("#");
  if (aIsComment !== bIsComment) {
    return 0.0;
  }

  const aChars = Array.from(aTrim);
  const bChars = Array.from(bTrim);
  if (aChars.length === 1 || bChars.length === 1) {
    return aChars[0] === bChars[0] ? 0.5 : 0.0;
  }

  const aBigrams: string[] = [];
  for (let i = 0; i < aChars.length - 1; i++) {
    aBigrams.push(aChars[i] + aChars[i + 1]);
  }
  const bBigrams: string[] = [];
  for (let i = 0; i < bChars.length - 1; i++) {
    bBigrams.push(bChars[i] + bChars[i + 1]);
  }
  aBigrams.sort();
  bBigrams.sort();

  let matches = 0;
  let ia = 0;
  let ib = 0;
  while (ia < aBigrams.length && ib < bBigrams.length) {
    if (aBigrams[ia] === bBigrams[ib]) {
      matches++;
      ia++;
      ib++;
    } else if (aBigrams[ia] < bBigrams[ib]) {
      ia++;
    } else {
      ib++;
    }
  }

  return (2.0 * matches) / (aBigrams.length + bBigrams.length);
}

export function alignIntraHunkLines(
  leftLines: string[],
  rightLines: string[],
  delIndices: number[],
  insIndices: number[]
): Array<[number | null, number | null]> {
  const n = delIndices.length;
  const m = insIndices.length;

  if (n === 0) return insIndices.map((r) => [null, r]);
  if (m === 0) return delIndices.map((l) => [l, null]);

  if (n * m > 14400) {
    const span = Math.max(n, m);
    const pairs: Array<[number | null, number | null]> = [];
    for (let k = 0; k < span; k++) {
      pairs.push([
        k < n ? delIndices[k] : null,
        k < m ? insIndices[k] : null,
      ]);
    }
    return pairs;
  }

  const cols = m + 1;
  const dp = new Float64Array((n + 1) * cols);
  const choice = new Uint8Array((n + 1) * cols); // 1 = Pair, 2 = Delete, 3 = Insert

  for (let i = n - 1; i >= 0; i--) {
    const lLine = leftLines[delIndices[i]] ?? "";
    for (let j = m - 1; j >= 0; j--) {
      const sim = lineSimilarity(lLine, rightLines[insIndices[j]] ?? "");
      const deleteScore = dp[(i + 1) * cols + j];
      const insertScore = dp[i * cols + (j + 1)];

      let bestScore = deleteScore;
      let bestAct = 2;

      if (insertScore > bestScore) {
        bestScore = insertScore;
        bestAct = 3;
      }

      if (sim >= INTRA_HUNK_PAIR_THRESHOLD) {
        const pairScore = sim + dp[(i + 1) * cols + (j + 1)];
        if (pairScore >= bestScore) {
          bestScore = pairScore;
          bestAct = 1;
        }
      }

      dp[i * cols + j] = bestScore;
      choice[i * cols + j] = bestAct;
    }
  }

  const result: Array<[number | null, number | null]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const act = choice[i * cols + j];
    if (act === 1) {
      result.push([delIndices[i], insIndices[j]]);
      i++;
      j++;
    } else if (act === 2) {
      result.push([delIndices[i], null]);
      i++;
    } else {
      result.push([null, insIndices[j]]);
      j++;
    }
  }
  while (i < n) {
    result.push([delIndices[i], null]);
    i++;
  }
  while (j < m) {
    result.push([null, insIndices[j]]);
    j++;
  }
  return result;
}

/**
 * Finds Longest Increasing Subsequence of unique anchor matches between
 * `normL[lStart..lEnd)` and `normR[rStart..rEnd)` in O(K log K) time.
 */
function findUniqueAnchorLis(
  normL: Int32Array,
  lStart: number,
  lEnd: number,
  normR: Int32Array,
  rStart: number,
  rEnd: number
): Array<[number, number]> {
  const leftPos = new Map<number, number>();
  const rightPos = new Map<number, number>();

  for (let l = lStart; l < lEnd; l++) {
    const id = normL[l];
    leftPos.set(id, leftPos.has(id) ? -1 : l);
  }
  for (let r = rStart; r < rEnd; r++) {
    const id = normR[r];
    rightPos.set(id, rightPos.has(id) ? -1 : r);
  }

  const candidates: Array<[number, number]> = [];
  for (let l = lStart; l < lEnd; l++) {
    const id = normL[l];
    if (leftPos.get(id) === l) {
      const r = rightPos.get(id);
      if (r !== undefined && r >= 0) {
        candidates.push([l, r]);
      }
    }
  }

  if (candidates.length === 0) return [];

  // Patience LIS over candidates[*][1]
  const tailIndices: number[] = [];
  const prev = new Int32Array(candidates.length).fill(-1);

  for (let i = 0; i < candidates.length; i++) {
    const rVal = candidates[i][1];
    let lo = 0;
    let hi = tailIndices.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[tailIndices[mid]][1] < rVal) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo > 0) {
      prev[i] = tailIndices[lo - 1];
    }
    tailIndices[lo] = i;
  }

  const lis: Array<[number, number]> = [];
  let cur = tailIndices[tailIndices.length - 1];
  while (cur !== -1) {
    lis.push(candidates[cur]);
    cur = prev[cur];
  }
  lis.reverse();
  return lis;
}

function diffSliceMyers(
  normL: Int32Array,
  lStart: number,
  lEnd: number,
  normR: Int32Array,
  rStart: number,
  rEnd: number,
  ops: DiffOp[]
): boolean {
  const midL = lEnd - lStart;
  const midR = rEnd - rStart;
  if (midL === 0 && midR === 0) return true;
  if (midL === 0) {
    for (let r = rStart; r < rEnd; r++) ops.push({ type: "ins", r });
    return true;
  }
  if (midR === 0) {
    for (let l = lStart; l < lEnd; l++) ops.push({ type: "del", l });
    return true;
  }

  const maxD = Math.min(midL + midR, 4000);
  const vOffset = maxD;
  const V = new Int32Array(2 * maxD + 1);
  const trace: Int32Array[] = [];

  let foundD = -1;
  for (let d = 0; d <= maxD; d++) {
    trace.push(new Int32Array(V));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && V[k - 1 + vOffset] < V[k + 1 + vOffset])) {
        x = V[k + 1 + vOffset];
      } else {
        x = V[k - 1 + vOffset] + 1;
      }
      let y = x - k;
      while (x < midL && y < midR && normL[lStart + x] === normR[rStart + y]) {
        x++;
        y++;
      }
      V[k + vOffset] = x;
      if (x >= midL && y >= midR) {
        foundD = d;
        break;
      }
    }
    if (foundD >= 0) break;
  }

  if (foundD < 0) return false;

  let curX = midL;
  let curY = midR;
  const midOps: DiffOp[] = [];
  for (let d = foundD; d > 0; d--) {
    const vPrev = trace[d];
    const k = curX - curY;
    let prevK: number;
    if (k === -d || (k !== d && vPrev[k - 1 + vOffset] < vPrev[k + 1 + vOffset])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[prevK + vOffset];
    const prevY = prevX - prevK;

    while (curX > prevX && curY > prevY) {
      curX--;
      curY--;
      midOps.push({ type: "eq", l: lStart + curX, r: rStart + curY });
    }
    if (curX === prevX) {
      curY--;
      midOps.push({ type: "ins", r: rStart + curY });
    } else {
      curX--;
      midOps.push({ type: "del", l: lStart + curX });
    }
  }
  while (curX > 0 && curY > 0) {
    curX--;
    curY--;
    midOps.push({ type: "eq", l: lStart + curX, r: rStart + curY });
  }
  for (let i = midOps.length - 1; i >= 0; i--) {
    ops.push(midOps[i]);
  }
  return true;
}

function diffSliceWithAnchors(
  normL: Int32Array,
  lStart: number,
  lEnd: number,
  normR: Int32Array,
  rStart: number,
  rEnd: number,
  ops: DiffOp[],
  depth = 0
): void {
  // Trim common prefix & suffix on this slice first
  while (lStart < lEnd && rStart < rEnd && normL[lStart] === normR[rStart]) {
    ops.push({ type: "eq", l: lStart, r: rStart });
    lStart++;
    rStart++;
  }
  const suffixOps: DiffOp[] = [];
  while (lEnd > lStart && rEnd > rStart && normL[lEnd - 1] === normR[rEnd - 1]) {
    lEnd--;
    rEnd--;
    suffixOps.push({ type: "eq", l: lEnd, r: rEnd });
  }

  const midL = lEnd - lStart;
  const midR = rEnd - rStart;

  if (midL === 0) {
    for (let r = rStart; r < rEnd; r++) ops.push({ type: "ins", r });
  } else if (midR === 0) {
    for (let l = lStart; l < lEnd; l++) ops.push({ type: "del", l });
  } else {
    const shouldSplitByAnchors = midL + midR > 2000 && depth < 16;
    let handled = false;

    if (!shouldSplitByAnchors) {
      handled = diffSliceMyers(normL, lStart, lEnd, normR, rStart, rEnd, ops);
    }

    if (!handled && depth < 16) {
      const anchors = findUniqueAnchorLis(normL, lStart, lEnd, normR, rStart, rEnd);
      if (anchors.length > 0) {
        let curL = lStart;
        let curR = rStart;
        for (const [al, ar] of anchors) {
          if (al > curL || ar > curR) {
            diffSliceWithAnchors(normL, curL, al, normR, curR, ar, ops, depth + 1);
          }
          ops.push({ type: "eq", l: al, r: ar });
          curL = al + 1;
          curR = ar + 1;
        }
        if (curL < lEnd || curR < rEnd) {
          diffSliceWithAnchors(normL, curL, lEnd, normR, curR, rEnd, ops, depth + 1);
        }
        handled = true;
      } else if (shouldSplitByAnchors) {
        // No unique anchors found; attempt bounded Myers directly before falling back
        handled = diffSliceMyers(normL, lStart, lEnd, normR, rStart, rEnd, ops);
      }
    }

    if (!handled) {
      for (let l = lStart; l < lEnd; l++) ops.push({ type: "del", l });
      for (let r = rStart; r < rEnd; r++) ops.push({ type: "ins", r });
    }
  }

  for (let i = suffixOps.length - 1; i >= 0; i--) {
    ops.push(suffixOps[i]);
  }
}

export function computeFastDiffOps(
  left: string[],
  right: string[],
  options: DiffOptions
): DiffOp[] {
  const { ops } = computeInternedDiffOps(left, right, options);
  return ops;
}

function computeInternedDiffOps(
  left: string[],
  right: string[],
  options: DiffOptions
): { ops: DiffOp[]; normL: Int32Array; normR: Int32Array } {
  const n = left.length;
  const m = right.length;
  const stringPool = new Map<string, number>();
  let nextId = 1;
  const intern = (s: string): number => {
    let id = stringPool.get(s);
    if (!id) {
      id = nextId++;
      stringPool.set(s, id);
    }
    return id;
  };

  const normL = new Int32Array(n);
  for (let i = 0; i < n; i++) normL[i] = intern(normalizeLine(left[i], options));
  const normR = new Int32Array(m);
  for (let j = 0; j < m; j++) normR[j] = intern(normalizeLine(right[j], options));

  if (n === 0 && m === 0) return { ops: [], normL, normR };
  if (n === 0) {
    return {
      ops: Array.from({ length: m }, (_, r) => ({ type: "ins" as const, r })),
      normL,
      normR,
    };
  }
  if (m === 0) {
    return {
      ops: Array.from({ length: n }, (_, l) => ({ type: "del" as const, l })),
      normL,
      normR,
    };
  }

  const ops: DiffOp[] = [];
  diffSliceWithAnchors(normL, 0, n, normR, 0, m, ops, 0);
  return { ops, normL, normR };
}

interface HunkRange {
  leftStart: number;
  leftEnd: number;
  rightStart: number;
  rightEnd: number;
}

function leadingIndent(s: string): number {
  let indent = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === " ") indent += 1;
    else if (ch === "\t") indent += 4;
    else break;
  }
  return indent;
}

function scoreSplitBoundary(lines: string[], start: number, end: number): number {
  let score = 0;
  if (start === 0 || end === lines.length) {
    score += 50;
  }
  if (start > 0 && lines[start - 1].trim().length === 0) {
    score += 100;
  }
  if (start < lines.length && lines[start].trim().length === 0) {
    score += 80;
  }
  if (end > 0 && end <= lines.length && lines[end - 1].trim().length === 0) {
    score += 90;
  }
  if (start > 0) {
    const prevTrim = lines[start - 1].trim();
    if (prevTrim === "}" || prevTrim === "};") {
      score += 60;
    }
  }
  if (end < lines.length) {
    score -= leadingIndent(lines[end]);
  }
  return score;
}

/**
 * Stage 2: Indentation & Blank-Line Slider Heuristic (ported from Rust `optimize_hunk_sliders`).
 */
export function optimizeHunkSliders(
  hunks: HunkRange[],
  normL: Int32Array,
  normR: Int32Array,
  leftRaw: string[],
  rightRaw: string[]
): void {
  const len = hunks.length;
  for (let idx = 0; idx < len; idx++) {
    const prevLeftEnd = idx > 0 ? hunks[idx - 1].leftEnd : 0;
    const prevRightEnd = idx > 0 ? hunks[idx - 1].rightEnd : 0;
    const nextLeftStart = idx + 1 < len ? hunks[idx + 1].leftStart : normL.length;
    const nextRightStart = idx + 1 < len ? hunks[idx + 1].rightStart : normR.length;

    const h = hunks[idx];

    if (h.leftStart === h.leftEnd && h.rightStart < h.rightEnd) {
      while (
        h.leftStart > prevLeftEnd &&
        h.rightStart > prevRightEnd &&
        normR[h.rightEnd - 1] === normL[h.leftStart - 1] &&
        normR[h.rightEnd - 1] === normR[h.rightStart - 1]
      ) {
        h.leftStart--;
        h.leftEnd--;
        h.rightStart--;
        h.rightEnd--;
      }

      let bestLStart = h.leftStart;
      let bestLEnd = h.leftEnd;
      let bestRStart = h.rightStart;
      let bestREnd = h.rightEnd;
      let bestScore = scoreSplitBoundary(rightRaw, h.rightStart, h.rightEnd);

      let curLStart = h.leftStart;
      let curLEnd = h.leftEnd;
      let curRStart = h.rightStart;
      let curREnd = h.rightEnd;
      while (
        curLEnd < nextLeftStart &&
        curREnd < nextRightStart &&
        normR[curRStart] === normL[curLEnd] &&
        normR[curRStart] === normR[curREnd]
      ) {
        curLStart++;
        curLEnd++;
        curRStart++;
        curREnd++;
        const score = scoreSplitBoundary(rightRaw, curRStart, curREnd);
        if (score >= bestScore) {
          bestScore = score;
          bestLStart = curLStart;
          bestLEnd = curLEnd;
          bestRStart = curRStart;
          bestREnd = curREnd;
        }
      }
      h.leftStart = bestLStart;
      h.leftEnd = bestLEnd;
      h.rightStart = bestRStart;
      h.rightEnd = bestREnd;
    } else if (h.leftStart < h.leftEnd && h.rightStart === h.rightEnd) {
      while (
        h.leftStart > prevLeftEnd &&
        h.rightStart > prevRightEnd &&
        normL[h.leftEnd - 1] === normR[h.rightStart - 1] &&
        normL[h.leftEnd - 1] === normL[h.leftStart - 1]
      ) {
        h.leftStart--;
        h.leftEnd--;
        h.rightStart--;
        h.rightEnd--;
      }

      let bestLStart = h.leftStart;
      let bestLEnd = h.leftEnd;
      let bestRStart = h.rightStart;
      let bestREnd = h.rightEnd;
      let bestScore = scoreSplitBoundary(leftRaw, h.leftStart, h.leftEnd);

      let curLStart = h.leftStart;
      let curLEnd = h.leftEnd;
      let curRStart = h.rightStart;
      let curREnd = h.rightEnd;
      while (
        curLEnd < nextLeftStart &&
        curREnd < nextRightStart &&
        normL[curLStart] === normR[curREnd] &&
        normL[curLStart] === normL[curLEnd]
      ) {
        curLStart++;
        curLEnd++;
        curRStart++;
        curREnd++;
        const score = scoreSplitBoundary(leftRaw, curLStart, curLEnd);
        if (score >= bestScore) {
          bestScore = score;
          bestLStart = curLStart;
          bestLEnd = curLEnd;
          bestRStart = curRStart;
          bestREnd = curREnd;
        }
      }
      h.leftStart = bestLStart;
      h.leftEnd = bestLEnd;
      h.rightStart = bestRStart;
      h.rightEnd = bestREnd;
    }
  }
}

export interface DiffComputationResult {
  leftLines: string[];
  rightLines: string[];
  allRows: ViewportRowDto[];
  visibleRows: ViewportRowDto[];
  hunks: TwoWayHunk[];
  stats: DiffStats;
}

export function computeTwoWayDiffCore(
  leftLines: string[],
  rightLines: string[],
  options: DiffOptions,
  rowFilter: DiffRowFilter = "all"
): DiffComputationResult {
  const { ops, normL, normR } = computeInternedDiffOps(leftLines, rightLines, options);

  // Extract raw contiguous non-equal hunks from ops
  const rawHunks: HunkRange[] = [];
  let k = 0;
  let curL = 0;
  let curR = 0;
  while (k < ops.length) {
    if (ops[k].type === "eq") {
      curL++;
      curR++;
      k++;
    } else {
      const lStart = curL;
      const rStart = curR;
      while (k < ops.length && ops[k].type !== "eq") {
        if (ops[k].type === "del") curL++;
        else curR++;
        k++;
      }
      rawHunks.push({
        leftStart: lStart,
        leftEnd: curL,
        rightStart: rStart,
        rightEnd: curR,
      });
    }
  }

  // Stage 2: Slider Heuristic
  optimizeHunkSliders(rawHunks, normL, normR, leftLines, rightLines);

  const allRows: ViewportRowDto[] = [];
  const hunks: TwoWayHunk[] = [];
  const stats: DiffStats = {
    modified_hunks: 0,
    inserted_hunks: 0,
    deleted_hunks: 0,
    equal_lines: 0,
    diff_lines: 0,
  };

  const pushEqualSpan = (lFrom: number, rFrom: number, count: number) => {
    for (let offset = 0; offset < count; offset++) {
      const lIdx = lFrom + offset;
      const rIdx = rFrom + offset;
      allRows.push({
        virtual_idx: allRows.length,
        left_line_no: lIdx + 1,
        right_line_no: rIdx + 1,
        left_text: leftLines[lIdx],
        right_text: rightLines[rIdx],
        status: "equal",
        hunk_id: null,
        left_inline: [],
        right_inline: [],
        left_tokens: [],
        right_tokens: [],
      });
      stats.equal_lines++;
    }
  };

  let cursorL = 0;
  let cursorR = 0;

  for (const hr of rawHunks) {
    const eqCount = Math.min(hr.leftStart - cursorL, hr.rightStart - cursorR);
    if (eqCount > 0) {
      pushEqualSpan(cursorL, cursorR, eqCount);
    }

    const delIndices: number[] = [];
    for (let l = hr.leftStart; l < hr.leftEnd; l++) delIndices.push(l);
    const insIndices: number[] = [];
    for (let r = hr.rightStart; r < hr.rightEnd; r++) insIndices.push(r);

    const hunkId = hunks.length;
    const vStart = allRows.length;
    let hunkStatus: DiffStatus = "modified";
    if (delIndices.length > 0 && insIndices.length > 0) {
      hunkStatus = "modified";
      stats.modified_hunks++;
    } else if (delIndices.length === 0) {
      hunkStatus = "inserted";
      stats.inserted_hunks++;
    } else {
      hunkStatus = "deleted";
      stats.deleted_hunks++;
    }

    const pairedRows = alignIntraHunkLines(leftLines, rightLines, delIndices, insIndices);
    for (const [lIdx, rIdx] of pairedRows) {
      const lText = lIdx !== null ? leftLines[lIdx] : null;
      const rText = rIdx !== null ? rightLines[rIdx] : null;

      let rowStatus: DiffStatus = "modified";
      let lInline: InlineSegment[] = [];
      let rInline: InlineSegment[] = [];

      if (lText !== null && rText !== null) {
        rowStatus = "modified";
      } else if (lText !== null) {
        rowStatus = "deleted";
        lInline = [{ text: lText, tag: "delete" }];
      } else if (rText !== null) {
        rowStatus = "inserted";
        rInline = [{ text: rText, tag: "insert" }];
      }

      allRows.push({
        virtual_idx: allRows.length,
        left_line_no: lIdx !== null ? lIdx + 1 : null,
        right_line_no: rIdx !== null ? rIdx + 1 : null,
        left_text: lText,
        right_text: rText,
        status: rowStatus,
        hunk_id: hunkId,
        left_inline: lInline,
        right_inline: rInline,
        left_tokens: [],
        right_tokens: [],
      });
      stats.diff_lines++;
    }

    hunks.push({
      id: hunkId,
      status: hunkStatus,
      virtual_start: vStart,
      virtual_end: allRows.length,
      left_range: { start: hr.leftStart, end: hr.leftEnd },
      right_range: { start: hr.rightStart, end: hr.rightEnd },
    });

    cursorL = hr.leftEnd;
    cursorR = hr.rightEnd;
  }

  const trailingEq = Math.min(leftLines.length - cursorL, rightLines.length - cursorR);
  if (trailingEq > 0) {
    pushEqualSpan(cursorL, cursorR, trailingEq);
  }

  let visibleRows: ViewportRowDto[];
  if (rowFilter === "diffs" || options.show_only_diffs) {
    visibleRows = allRows
      .filter((r) => r.status !== "equal")
      .map((r, idx) => ({ ...r, virtual_idx: idx }));
  } else if (rowFilter === "equals") {
    visibleRows = allRows
      .filter((r) => r.status === "equal")
      .map((r, idx) => ({ ...r, virtual_idx: idx }));
  } else {
    visibleRows = allRows;
  }

  return {
    leftLines,
    rightLines,
    allRows,
    visibleRows,
    hunks,
    stats,
  };
}
