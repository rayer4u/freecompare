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

  if (n * m > 250000) {
    const minLen = Math.min(n, m);
    const pairs: Array<[number | null, number | null]> = [];
    for (let i = 0; i < minLen; i++) {
      pairs.push([delIndices[i], insIndices[i]]);
    }
    if (n > minLen) {
      for (let i = minLen; i < n; i++) pairs.push([delIndices[i], null]);
    } else if (m > minLen) {
      for (let i = minLen; i < m; i++) pairs.push([null, insIndices[i]]);
    }
    return pairs;
  }

  const bigramSet = (s: string) => {
    const set = new Set<string>();
    const norm = s.trim();
    for (let i = 0; i < norm.length - 1; i++) {
      set.add(norm.slice(i, i + 2));
    }
    return set;
  };

  const leftSets = delIndices.map((idx) => bigramSet(leftLines[idx] ?? ""));
  const rightSets = insIndices.map((idx) => bigramSet(rightLines[idx] ?? ""));

  const sim = (i: number, j: number): number => {
    const s1 = leftSets[i];
    const s2 = rightSets[j];
    if (s1.size === 0 && s2.size === 0) {
      return (leftLines[delIndices[i]] ?? "").trim() === (rightLines[insIndices[j]] ?? "").trim() ? 1.0 : 0.0;
    }
    let intersection = 0;
    for (const b of s1) {
      if (s2.has(b)) intersection++;
    }
    const union = s1.size + s2.size - intersection;
    return union > 0 ? intersection / union : 0.0;
  };

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const matchScore = dp[i - 1][j - 1] + sim(i - 1, j - 1);
      dp[i][j] = Math.max(matchScore, dp[i - 1][j], dp[i][j - 1]);
    }
  }

  let i = n;
  let j = m;
  const matchedPairs: Array<[number | null, number | null]> = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const score = sim(i - 1, j - 1);
      if (Math.abs(dp[i][j] - (dp[i - 1][j - 1] + score)) < 1e-6 && score > 0.25) {
        matchedPairs.push([delIndices[i - 1], insIndices[j - 1]]);
        i--;
        j--;
        continue;
      }
    }
    if (j > 0 && (i === 0 || dp[i][j] === dp[i][j - 1])) {
      matchedPairs.push([null, insIndices[j - 1]]);
      j--;
    } else {
      matchedPairs.push([delIndices[i - 1], null]);
      i--;
    }
  }
  matchedPairs.reverse();
  return matchedPairs;
}

export function computeFastDiffOps(
  left: string[],
  right: string[],
  options: DiffOptions
): DiffOp[] {
  const n = left.length;
  const m = right.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return Array.from({ length: m }, (_, r) => ({ type: "ins" as const, r }));
  if (m === 0) return Array.from({ length: n }, (_, l) => ({ type: "del" as const, l }));

  // Intern normalized lines
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

  const ops: DiffOp[] = [];

  // 1. Common prefix fast match
  let start = 0;
  while (start < n && start < m && normL[start] === normR[start]) {
    ops.push({ type: "eq", l: start, r: start });
    start++;
  }

  // 2. Common suffix fast match
  let endL = n - 1;
  let endR = m - 1;
  while (endL >= start && endR >= start && normL[endL] === normR[endR]) {
    endL--;
    endR--;
  }
  const suffixStartL = endL + 1;
  const suffixStartR = endR + 1;

  // 3. Middle difference slice
  const midL = endL - start + 1;
  const midR = endR - start + 1;

  if (midL === 0) {
    for (let r = start; r <= endR; r++) {
      ops.push({ type: "ins", r });
    }
  } else if (midR === 0) {
    for (let l = start; l <= endL; l++) {
      ops.push({ type: "del", l });
    }
  } else {
    const maxD = Math.min(midL + midR, 4000);
    const vOffset = maxD;
    const V = new Int32Array(2 * maxD + 1);
    const trace: Int32Array[] = [];

    let foundD = -1;
    let found = false;

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
        while (x < midL && y < midR && normL[start + x] === normR[start + y]) {
          x++;
          y++;
        }
        V[k + vOffset] = x;
        if (x >= midL && y >= midR) {
          foundD = d;
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (foundD >= 0) {
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
          midOps.push({ type: "eq", l: start + curX, r: start + curY });
        }
        if (curX === prevX) {
          curY--;
          midOps.push({ type: "ins", r: start + curY });
        } else {
          curX--;
          midOps.push({ type: "del", l: start + curX });
        }
      }
      while (curX > 0 && curY > 0) {
        curX--;
        curY--;
        midOps.push({ type: "eq", l: start + curX, r: start + curY });
      }
      for (let i = midOps.length - 1; i >= 0; i--) {
        ops.push(midOps[i]);
      }
    } else {
      for (let l = start; l <= endL; l++) ops.push({ type: "del", l });
      for (let r = start; r <= endR; r++) ops.push({ type: "ins", r });
    }
  }

  for (let l = suffixStartL, r = suffixStartR; l < n && r < m; l++, r++) {
    ops.push({ type: "eq", l, r });
  }
  return ops;
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
  const ops = computeFastDiffOps(leftLines, rightLines, options);

  const allRows: ViewportRowDto[] = [];
  const hunks: TwoWayHunk[] = [];
  const stats: DiffStats = {
    modified_hunks: 0,
    inserted_hunks: 0,
    deleted_hunks: 0,
    equal_lines: 0,
    diff_lines: 0,
  };

  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.type === "eq") {
      allRows.push({
        virtual_idx: allRows.length,
        left_line_no: (op.l ?? 0) + 1,
        right_line_no: (op.r ?? 0) + 1,
        left_text: leftLines[op.l!],
        right_text: rightLines[op.r!],
        status: "equal",
        hunk_id: null,
        left_inline: [],
        right_inline: [],
        left_tokens: [],
        right_tokens: [],
      });
      stats.equal_lines++;
      k++;
    } else {
      const delIndices: number[] = [];
      const insIndices: number[] = [];
      while (k < ops.length && ops[k].type !== "eq") {
        const cur = ops[k];
        if (cur.type === "del" && cur.l !== undefined) delIndices.push(cur.l);
        if (cur.type === "ins" && cur.r !== undefined) insIndices.push(cur.r);
        k++;
      }

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
          // Lazy: compute in getViewportSlice on demand only for visible rows!
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

      const lStart = delIndices.length > 0 ? delIndices[0] : (insIndices[0] ?? 0);
      const lEnd = delIndices.length > 0 ? delIndices[delIndices.length - 1] + 1 : lStart;
      const rStart = insIndices.length > 0 ? insIndices[0] : (delIndices[0] ?? 0);
      const rEnd = insIndices.length > 0 ? insIndices[insIndices.length - 1] + 1 : rStart;

      hunks.push({
        id: hunkId,
        status: hunkStatus,
        virtual_start: vStart,
        virtual_end: allRows.length,
        left_range: { start: lStart, end: lEnd },
        right_range: { start: rStart, end: rEnd },
      });
    }
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
