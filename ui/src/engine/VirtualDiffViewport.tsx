import { Component, createEffect, createMemo, createSignal, For, Show } from "solid-js";
import {
  DiffStatus,
  InlineSegment,
  MergeDirection,
  SyntaxToken,
  TwoWayHunk,
  ViewportRowDto,
} from "../types";
import { t } from "../i18n";

export const ROW_HEIGHT = 24;
export const OVERSCAN_ROWS = 12;

interface VirtualDiffViewportProps {
  totalRows: number;
  leftLineCount: number;
  rightLineCount: number;
  focusedSide: "left" | "right";
  allSelectedSide: "left" | "right" | null;
  hunks: TwoWayHunk[];
  activeHunkId: number | null;
  selectedRowIdx: number | null;
  editorFontSize?: number;
  showWhitespaceGlyphs?: boolean;
  fetchSlice: (startRow: number, count: number) => ViewportRowDto[];
  onFocusSide: (side: "left" | "right") => void;
  onPasteToSide: (isLeft: boolean, pastedText: string) => void;
  onSelectRow: (row: ViewportRowDto) => void;
  onMergeHunk: (hunkId: number, direction: MergeDirection) => void;
  onEditLine: (isLeft: boolean, lineNo1Based: number, newText: string) => void;
  scrollTriggerRow?: number | null;
  onContextMenu?: (
    e: MouseEvent,
    row: ViewportRowDto | null,
    side: "left" | "right"
  ) => void;
}

export const VirtualDiffViewport: Component<VirtualDiffViewportProps> = (props) => {
  let scrollContainerRef: HTMLDivElement | undefined;
  let leftCodeScrollRef: HTMLDivElement | undefined;
  let rightCodeScrollRef: HTMLDivElement | undefined;
  let overviewCanvasRef: HTMLCanvasElement | undefined;

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(560);
  const [editingCell, setEditingCell] = createSignal<{
    isLeft: boolean;
    lineNo: number;
    virtualIdx: number;
    value: string;
  } | null>(null);

  const visibleRange = createMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop() / ROW_HEIGHT) - OVERSCAN_ROWS);
    const visibleCount = Math.ceil(viewportHeight() / ROW_HEIGHT) + OVERSCAN_ROWS * 2;
    const count = Math.min(props.totalRows - start, visibleCount);
    return { start, count: Math.max(0, count) };
  });

  const visibleRows = createMemo(() => {
    const { start, count } = visibleRange();
    return props.fetchSlice(start, count);
  });

  createEffect(() => {
    const targetRow = props.scrollTriggerRow;
    if (targetRow !== null && targetRow !== undefined && scrollContainerRef) {
      const targetTop = Math.max(0, targetRow * ROW_HEIGHT - viewportHeight() / 3);
      scrollContainerRef.scrollTo({ top: targetTop, behavior: "smooth" });
    }
  });

  createEffect(() => {
    const canvas = overviewCanvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = "rgba(128, 138, 155, 0.10)";
    ctx.fillRect(0, 0, width, height);

    const total = Math.max(1, props.totalRows);
    for (const hunk of props.hunks) {
      const y1 = Math.floor((hunk.virtual_start / total) * height);
      const h = Math.max(3, Math.ceil(((hunk.virtual_end - hunk.virtual_start) / total) * height));
      if (hunk.status === "modified") {
        ctx.fillStyle = "#ef4444";
      } else if (hunk.status === "inserted") {
        ctx.fillStyle = "#22c55e";
      } else if (hunk.status === "deleted") {
        ctx.fillStyle = "#f59e0b";
      }
      ctx.fillRect(2, y1, width - 4, h);
    }

    const topRatio = scrollTop() / (Math.max(1, total) * ROW_HEIGHT);
    const heightRatio = viewportHeight() / (Math.max(1, total) * ROW_HEIGHT);
    const lensY = Math.max(0, Math.min(height - 12, topRatio * height));
    const lensH = Math.max(12, Math.min(height - lensY, heightRatio * height));

    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1.5;
    ctx.fillStyle = "rgba(56, 189, 248, 0.16)";
    ctx.fillRect(1, lensY, width - 2, lensH);
    ctx.strokeRect(1, lensY, width - 2, lensH);
  });

  const handleHorizontalScroll = (source: "left" | "right", e: Event) => {
    const target = e.currentTarget as HTMLDivElement;
    if (source === "left" && rightCodeScrollRef) {
      rightCodeScrollRef.scrollLeft = target.scrollLeft;
    } else if (source === "right" && leftCodeScrollRef) {
      leftCodeScrollRef.scrollLeft = target.scrollLeft;
    }
  };

  const handleOverviewClick = (e: MouseEvent) => {
    if (!overviewCanvasRef || !scrollContainerRef) return;
    const rect = overviewCanvasRef.getBoundingClientRect();
    const clickRatio = (e.clientY - rect.top) / rect.height;
    const targetScrollTop = Math.max(
      0,
      clickRatio * props.totalRows * ROW_HEIGHT - viewportHeight() / 2
    );
    scrollContainerRef.scrollTop = targetScrollTop;
  };

  const commitInlineEdit = () => {
    const cell = editingCell();
    if (!cell) return;
    props.onEditLine(cell.isLeft, cell.lineNo, cell.value);
    setEditingCell(null);
  };

  const visibleHunks = createMemo(() => {
    const { start, count } = visibleRange();
    const end = start + count;
    return props.hunks.filter((h) => h.virtual_end >= start && h.virtual_start <= end);
  });

  return (
    <div class="virtual-diff-shell">
      <div
        ref={(el) => {
          scrollContainerRef = el;
          setTimeout(() => setViewportHeight(el.clientHeight || 560), 0);
        }}
        class="virtual-scroll-viewport"
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          setViewportHeight(e.currentTarget.clientHeight);
        }}
      >
        <div
          class="virtual-scroll-spacer"
          style={{
            height: `${Math.max(props.totalRows * ROW_HEIGHT, viewportHeight())}px`,
          }}
        >
          {/* Left Pane */}
          <div
            ref={leftCodeScrollRef}
            tabIndex={0}
            class={`diff-pane diff-pane-left ${
              props.focusedSide === "left" ? "pane-focused" : ""
            } ${props.allSelectedSide === "left" ? "pane-all-selected" : ""}`}
            onClick={() => props.onFocusSide("left")}
            onContextMenu={(e) => {
              if (e.defaultPrevented) return;
              e.preventDefault();
              props.onFocusSide("left");
              props.onContextMenu?.(e, null, "left");
            }}
            onPaste={(e) => {
              if (editingCell()) return;
              const text = e.clipboardData?.getData("text/plain");
              if (text !== undefined && text.length > 0) {
                e.preventDefault();
                props.onPasteToSide(true, text);
              }
            }}
            onScroll={(e) => handleHorizontalScroll("left", e)}
          >
            <Show when={props.leftLineCount === 0}>
              <div class="empty-paste-overlay">
                <div class="paste-hint-card">
                  <strong>{t("text_diff.empty_left_title")}</strong>
                  <span>
                    {t("text_diff.empty_desc")}
                  </span>
                </div>
              </div>
            </Show>

            <div
              class="virtual-rows-layer"
              style={{
                transform: `translateY(${visibleRange().start * ROW_HEIGHT}px)`,
              }}
            >
              <For each={visibleRows()}>
                {(row) => {
                  const isSelected = () => props.selectedRowIdx === row.virtual_idx;
                  const isEditing = () =>
                    editingCell()?.isLeft === true &&
                    editingCell()?.virtualIdx === row.virtual_idx;

                  return (
                    <div
                      class={`diff-row status-${row.status} ${
                        row.left_text === null ? "diff-row-gap" : ""
                      } ${isSelected() ? "diff-row-selected" : ""}`}
                      style={{ height: `${ROW_HEIGHT}px` }}
                      onClick={() => {
                        props.onFocusSide("left");
                        props.onSelectRow(row);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        props.onFocusSide("left");
                        props.onSelectRow(row);
                        props.onContextMenu?.(e, row, "left");
                      }}
                      onDblClick={() => {
                        if (row.left_line_no !== null && row.left_text !== null) {
                          setEditingCell({
                            isLeft: true,
                            lineNo: row.left_line_no,
                            virtualIdx: row.virtual_idx,
                            value: row.left_text,
                          });
                        }
                      }}
                    >
                      <span class="line-num-gutter">
                        {row.left_line_no ?? ""}
                      </span>
                      <div
                        class="line-code-content"
                        style={{ "font-size": `${props.editorFontSize ?? 13}px` }}
                      >
                        <Show
                          when={!isEditing()}
                          fallback={
                            <input
                              class="inline-line-editor"
                              value={editingCell()?.value ?? ""}
                              autofocus
                              onInput={(e) =>
                                setEditingCell((prev) =>
                                  prev ? { ...prev, value: e.currentTarget.value } : null
                                )
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitInlineEdit();
                                if (e.key === "Escape") setEditingCell(null);
                              }}
                              onBlur={commitInlineEdit}
                            />
                          }
                        >
                          {renderRichLine(
                            row.status,
                            row.left_inline,
                            row.left_tokens,
                            props.showWhitespaceGlyphs
                          )}
                        </Show>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>

          {/* Center Alignment Connector Gutter */}
          <div class="diff-center-gutter">
            <svg
              class="gutter-svg-connectors"
              width="68"
              height={Math.max(props.totalRows * ROW_HEIGHT, viewportHeight())}
            >
              <For each={visibleHunks()}>
                {(hunk) => {
                  const y1 = hunk.virtual_start * ROW_HEIGHT;
                  const y2 = hunk.virtual_end * ROW_HEIGHT;
                  const fill =
                    hunk.status === "modified"
                      ? "rgba(239, 68, 68, 0.22)"
                      : hunk.status === "inserted"
                      ? "rgba(34, 197, 94, 0.22)"
                      : "rgba(245, 158, 11, 0.22)";
                  const stroke =
                    hunk.status === "modified"
                      ? "#ef4444"
                      : hunk.status === "inserted"
                      ? "#22c55e"
                      : "#f59e0b";
                  const d = `M 0 ${y1} C 28 ${y1}, 40 ${y1}, 68 ${y1} L 68 ${y2} C 40 ${y2}, 28 ${y2}, 0 ${y2} Z`;
                  return (
                    <g>
                      <path d={d} fill={fill} stroke={stroke} stroke-width="1" />
                    </g>
                  );
                }}
              </For>
            </svg>

            <For each={visibleHunks()}>
              {(hunk) => {
                const topPx = hunk.virtual_start * ROW_HEIGHT;
                return (
                  <div
                    class={`gutter-hunk-actions ${
                      props.activeHunkId === hunk.id ? "hunk-active" : ""
                    }`}
                    style={{ top: `${topPx}px` }}
                  >
                    <button
                      class="gutter-copy-btn copy-right"
                      title={t("text_diff.copy_to_right_tip")}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onMergeHunk(hunk.id, "left_to_right");
                      }}
                    >
                      »
                    </button>
                    <button
                      class="gutter-copy-btn copy-left"
                      title={t("text_diff.copy_to_left_tip")}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onMergeHunk(hunk.id, "right_to_left");
                      }}
                    >
                      «
                    </button>
                  </div>
                );
              }}
            </For>
          </div>

          {/* Right Pane */}
          <div
            ref={rightCodeScrollRef}
            tabIndex={0}
            class={`diff-pane diff-pane-right ${
              props.focusedSide === "right" ? "pane-focused" : ""
            } ${props.allSelectedSide === "right" ? "pane-all-selected" : ""}`}
            onClick={() => props.onFocusSide("right")}
            onContextMenu={(e) => {
              if (e.defaultPrevented) return;
              e.preventDefault();
              props.onFocusSide("right");
              props.onContextMenu?.(e, null, "right");
            }}
            onPaste={(e) => {
              if (editingCell()) return;
              const text = e.clipboardData?.getData("text/plain");
              if (text !== undefined && text.length > 0) {
                e.preventDefault();
                props.onPasteToSide(false, text);
              }
            }}
            onScroll={(e) => handleHorizontalScroll("right", e)}
          >
            <Show when={props.rightLineCount === 0}>
              <div class="empty-paste-overlay">
                <div class="paste-hint-card">
                  <strong>{t("text_diff.empty_right_title")}</strong>
                  <span>
                    {t("text_diff.empty_desc")}
                  </span>
                </div>
              </div>
            </Show>

            <div
              class="virtual-rows-layer"
              style={{
                transform: `translateY(${visibleRange().start * ROW_HEIGHT}px)`,
              }}
            >
              <For each={visibleRows()}>
                {(row) => {
                  const isSelected = () => props.selectedRowIdx === row.virtual_idx;
                  const isEditing = () =>
                    editingCell()?.isLeft === false &&
                    editingCell()?.virtualIdx === row.virtual_idx;

                  return (
                    <div
                      class={`diff-row status-${row.status} ${
                        row.right_text === null ? "diff-row-gap" : ""
                      } ${isSelected() ? "diff-row-selected" : ""}`}
                      style={{ height: `${ROW_HEIGHT}px` }}
                      onClick={() => {
                        props.onFocusSide("right");
                        props.onSelectRow(row);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        props.onFocusSide("right");
                        props.onSelectRow(row);
                        props.onContextMenu?.(e, row, "right");
                      }}
                      onDblClick={() => {
                        if (row.right_line_no !== null && row.right_text !== null) {
                          setEditingCell({
                            isLeft: false,
                            lineNo: row.right_line_no,
                            virtualIdx: row.virtual_idx,
                            value: row.right_text,
                          });
                        }
                      }}
                    >
                      <span class="line-num-gutter">
                        {row.right_line_no ?? ""}
                      </span>
                      <div
                        class="line-code-content"
                        style={{ "font-size": `${props.editorFontSize ?? 13}px` }}
                      >
                        <Show
                          when={!isEditing()}
                          fallback={
                            <input
                              class="inline-line-editor"
                              value={editingCell()?.value ?? ""}
                              autofocus
                              onInput={(e) =>
                                setEditingCell((prev) =>
                                  prev ? { ...prev, value: e.currentTarget.value } : null
                                )
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitInlineEdit();
                                if (e.key === "Escape") setEditingCell(null);
                              }}
                              onBlur={commitInlineEdit}
                            />
                          }
                        >
                          {renderRichLine(
                            row.status,
                            row.right_inline,
                            row.right_tokens,
                            props.showWhitespaceGlyphs
                          )}
                        </Show>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </div>
      </div>

      {/* Right-hand Beyond Compare Style Overview Bar (Minimap) */}
      <div class="overview-minimap-rail" title={t("text_diff.minimap_tip")}>
        <canvas
          ref={overviewCanvasRef}
          width="18"
          height="560"
          class="overview-canvas"
          onClick={handleOverviewClick}
        />
      </div>
    </div>
  );
};

function formatGlyphText(text: string, showGlyphs?: boolean): string {
  if (!showGlyphs) return text;
  return text.replace(/ /g, "·").replace(/\t/g, "→   ");
}

function renderRichLine(
  status: DiffStatus,
  inlineSegs: InlineSegment[],
  syntaxTokens: SyntaxToken[],
  showWhitespaceGlyphs?: boolean
) {
  if (status !== "equal" && inlineSegs.length > 0) {
    return (
      <For each={inlineSegs}>
        {(seg) => (
          <span
            class={
              seg.tag === "delete"
                ? "inline-char-delete"
                : seg.tag === "insert"
                ? "inline-char-insert"
                : ""
            }
          >
            {formatGlyphText(seg.text, showWhitespaceGlyphs)}
          </span>
        )}
      </For>
    );
  }

  return (
    <For each={syntaxTokens}>
      {(tok) => (
        <span class={`tok-${tok.kind}`}>
          {formatGlyphText(tok.text, showWhitespaceGlyphs)}
        </span>
      )}
    </For>
  );
}
