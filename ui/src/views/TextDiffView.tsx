import { Component, createMemo, createSignal, onCleanup, onMount, Show, For } from "solid-js";
import {
  callRustRpc,
  CompareBackendClient,
  ViewRowFilter,
} from "../bridge";
import { FileBrowserModal } from "../components/FileBrowserModal";
import { VirtualDiffViewport } from "../engine/VirtualDiffViewport";
import {
  DiffOptions,
  MergeDirection,
  TwoWayDiffResult,
  ViewportRowDto,
} from "../types";

interface TextDiffViewProps {
  sessionId: string;
  initialLeftPath?: string;
  initialRightPath?: string;
  initialLeftContent?: string;
  initialRightContent?: string;
}

export const TextDiffView: Component<TextDiffViewProps> = (props) => {
  const [leftPath, setLeftPath] = createSignal(props.initialLeftPath ?? "");
  const [rightPath, setRightPath] = createSignal(props.initialRightPath ?? "");

  const [focusedSide, setFocusedSide] = createSignal<"left" | "right">("left");
  const [allSelectedSide, setAllSelectedSide] = createSignal<"left" | "right" | null>(
    null
  );
  const [rowFilter, setRowFilter] = createSignal<ViewRowFilter>("all");
  const [browserTargetSide, setBrowserTargetSide] = createSignal<"left" | "right" | null>(
    null
  );
  const [editingFullSide, setEditingFullSide] = createSignal<"left" | "right" | null>(
    null
  );
  const [fullEditDraft, setFullEditDraft] = createSignal("");

  const [options, setOptions] = createSignal<DiffOptions>({
    ignore_whitespace: false,
    ignore_case: false,
    show_only_diffs: false,
    context_lines: 3,
  });

  // New sessions start completely blank unless initialLeftContent / initialRightContent or paths are passed!
  const [summary, setSummary] = createSignal<TwoWayDiffResult>(
    CompareBackendClient.createTwoWaySession(
      props.sessionId,
      props.initialLeftContent ?? "",
      props.initialRightContent ?? "",
      options()
    )
  );

  const [versionTick, setVersionTick] = createSignal(0);
  const [activeHunkIdx, setActiveHunkIdx] = createSignal<number>(0);
  const [selectedRow, setSelectedRow] = createSignal<ViewportRowDto | null>(null);
  const [scrollTriggerRow, setScrollTriggerRow] = createSignal<number | null>(null);
  const [toastMsg, setToastMsg] = createSignal<string | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2600);
  };

  const fetchSlice = (startRow: number, count: number): ViewportRowDto[] => {
    versionTick();
    return CompareBackendClient.getViewportSlice(props.sessionId, startRow, count).rows;
  };

  const currentHunk = createMemo(() => {
    const hunks = summary().hunks;
    if (hunks.length === 0) return null;
    const idx = Math.max(0, Math.min(activeHunkIdx(), hunks.length - 1));
    return hunks[idx];
  });

  const jumpToHunk = (delta: number) => {
    const hunks = summary().hunks;
    if (hunks.length === 0) return;
    const nextIdx = (activeHunkIdx() + delta + hunks.length) % hunks.length;
    setActiveHunkIdx(nextIdx);
    const targetHunk = hunks[nextIdx];
    setScrollTriggerRow(targetHunk.virtual_start);
    const slice = CompareBackendClient.getViewportSlice(
      props.sessionId,
      targetHunk.virtual_start,
      1
    );
    if (slice.rows[0]) {
      setSelectedRow(slice.rows[0]);
    }
  };

  const handleMergeHunk = (hunkId: number, direction: MergeDirection) => {
    const nextSummary = CompareBackendClient.mergeHunk(props.sessionId, hunkId, direction);
    setSummary(nextSummary);
    setVersionTick((t) => t + 1);
    showToast(
      direction === "left_to_right"
        ? `已将差异块 #${hunkId + 1} 复制到右侧`
        : `已将差异块 #${hunkId + 1} 复制到左侧`
    );
  };

  const handleEditLine = (isLeft: boolean, lineNo1Based: number, newText: string) => {
    const nextSummary = CompareBackendClient.editLine(
      props.sessionId,
      isLeft,
      lineNo1Based,
      newText
    );
    setSummary(nextSummary);
    setVersionTick((t) => t + 1);
    showToast(`已更新${isLeft ? "左侧" : "右侧"}第 ${lineNo1Based} 行`);
  };

  const handlePasteTextToSide = (isLeft: boolean, text: string) => {
    setAllSelectedSide(null);
    const nextSummary = CompareBackendClient.replaceSideText(
      props.sessionId,
      isLeft,
      text
    );
    setSummary(nextSummary);
    setVersionTick((t) => t + 1);
    const slice = CompareBackendClient.getViewportSlice(props.sessionId, 0, 40);
    const firstDiff = slice.rows.find((r) => r.status !== "equal") ?? slice.rows[0] ?? null;
    setSelectedRow(firstDiff);
    const lineCnt = isLeft ? nextSummary.left_line_count : nextSummary.right_line_count;
    showToast(`已粘贴 ${lineCnt} 行文本到${isLeft ? "左侧" : "右侧"}`);
  };

  const handleReadClipboardAndPaste = async (isLeft: boolean) => {
    setFocusedSide(isLeft ? "left" : "right");
    try {
      const clipText = await navigator.clipboard.readText();
      if (!clipText) {
        showToast("剪贴板为空，也可直接点击左/右视图按 Ctrl+V 粘贴");
        return;
      }
      handlePasteTextToSide(isLeft, clipText);
    } catch {
      showToast("请直接点击左/右侧区域并按下 Ctrl+V (或 Cmd+V) 粘贴文本");
    }
  };

  const handleCopySideToClipboard = async (isLeft: boolean) => {
    const fullText = CompareBackendClient.getSideFullText(props.sessionId, isLeft);
    try {
      await navigator.clipboard.writeText(fullText);
      const lineCnt = isLeft ? summary().left_line_count : summary().right_line_count;
      showToast(`已拷贝${isLeft ? "左侧" : "右侧"}全部文本 (${lineCnt} 行) 到剪贴板`);
    } catch {
      showToast("拷贝失败，请检查剪贴板权限");
    }
  };

  const handleSwapSides = () => {
    const lPath = leftPath();
    setLeftPath(rightPath());
    setRightPath(lPath);
    const nextSummary = CompareBackendClient.swapSides(props.sessionId);
    setSummary(nextSummary);
    setVersionTick((t) => t + 1);
    showToast("已交换左右两侧内容");
  };

  const handleSetRowFilter = (filter: ViewRowFilter) => {
    setRowFilter(filter);
    const nextOpts: DiffOptions = {
      ...options(),
      show_only_diffs: filter === "diffs",
    };
    setOptions(nextOpts);
    const nextSummary = CompareBackendClient.updateOptions(
      props.sessionId,
      nextOpts,
      filter
    );
    setSummary(nextSummary);
    setVersionTick((t) => t + 1);
  };

  const handleToggleOption = (key: keyof DiffOptions) => {
    const next: DiffOptions = {
      ...options(),
      [key]: !options()[key],
    };
    setOptions(next);
    const nextSummary = CompareBackendClient.updateOptions(
      props.sessionId,
      next,
      rowFilter()
    );
    setSummary(nextSummary);
    setVersionTick((t) => t + 1);
  };

  const handleUndo = (isLeft: boolean) => {
    const nextSummary = CompareBackendClient.undoSide(props.sessionId, isLeft);
    setSummary(nextSummary);
    setVersionTick((t) => t + 1);
  };

  const handleRedo = (isLeft: boolean) => {
    const nextSummary = CompareBackendClient.redoSide(props.sessionId, isLeft);
    setSummary(nextSummary);
    setVersionTick((t) => t + 1);
  };

  const handleSaveSide = async (isLeft: boolean) => {
    const path = (isLeft ? leftPath() : rightPath()).trim();
    const content = CompareBackendClient.getSideFullText(props.sessionId, isLeft);
    if (path && !path.startsWith("(")) {
      try {
        const res = await callRustRpc<{ saved: boolean }>("write_text_file", {
          path,
          content,
        });
        if (res?.saved) {
          setSummary(CompareBackendClient.markSideSaved(props.sessionId, isLeft));
          showToast(`已保存到磁盘文件: ${path}`);
          return;
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    // Fallback download if no disk path is set
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = isLeft ? "left.txt" : "right.txt";
    a.click();
    URL.revokeObjectURL(url);
    setSummary(CompareBackendClient.markSideSaved(props.sessionId, isLeft));
    showToast(`已导出${isLeft ? "左侧" : "右侧"}文本文件`);
  };

  const handleLoadSingleDiskFile = async (isLeft: boolean, filePath: string) => {
    const trimmed = filePath.trim();
    if (!trimmed) return;
    if (isLeft) setLeftPath(trimmed);
    else setRightPath(trimmed);

    const lPath = isLeft ? trimmed : leftPath().trim();
    const rPath = !isLeft ? trimmed : rightPath().trim();

    if (lPath && rPath && !lPath.startsWith("(") && !rPath.startsWith("(")) {
      await handleLoadDiskPaths(lPath, rPath);
      return;
    }

    // Load single side by comparing against self and extracting its lines
    try {
      const data = await callRustRpc<{
        initial_slice: { rows: ViewportRowDto[] };
      }>("open_two_way_files", {
        left_path: trimmed,
        right_path: trimmed,
        options: options(),
        initial_row_count: 50000,
      });
      if (data) {
        const text = data.initial_slice.rows
          .map((r) => r.left_text ?? "")
          .join("\n");
        const nextSummary = CompareBackendClient.replaceSideText(
          props.sessionId,
          isLeft,
          text
        );
        setSummary(CompareBackendClient.markSideSaved(props.sessionId, isLeft));
        setVersionTick((t) => t + 1);
        showToast(`已加载文件: ${trimmed} (${nextSummary.left_line_count} 行)`);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleLoadDiskPaths = async (overrideL?: string, overrideR?: string) => {
    const l = (overrideL ?? leftPath()).trim();
    const r = (overrideR ?? rightPath()).trim();
    if (!l && !r) return;
    if (l && !r) {
      await handleLoadSingleDiskFile(true, l);
      return;
    }
    if (!l && r) {
      await handleLoadSingleDiskFile(false, r);
      return;
    }

    try {
      const loaded = await CompareBackendClient.loadRealDiskFiles(
        props.sessionId,
        l,
        r,
        options()
      );
      if (loaded) {
        setSummary(loaded);
        setVersionTick((t) => t + 1);
        const initial = CompareBackendClient.getViewportSlice(props.sessionId, 0, 50);
        const firstDiff = initial.rows.find((row) => row.status !== "equal") ?? initial.rows[0];
        if (firstDiff) setSelectedRow(firstDiff);
        showToast(`已加载对比文件: ${l} ↔ ${r}`);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const activeEl = document.activeElement;
    const isInputFocused =
      activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement;

    if (!isInputFocused && (e.ctrlKey || e.metaKey)) {
      const key = e.key.toLowerCase();
      if (key === "a") {
        e.preventDefault();
        const side = focusedSide();
        setAllSelectedSide(side);
        const count =
          side === "left" ? summary().left_line_count : summary().right_line_count;
        showToast(
          `已全选${side === "left" ? "左侧" : "右侧"}全部 ${count} 行 (按 Ctrl+C 即可拷贝全文)`
        );
        return;
      }
      if (key === "c") {
        const nativeSelection = window.getSelection()?.toString() ?? "";
        if (nativeSelection.length > 0 && !allSelectedSide()) {
          return;
        }
        e.preventDefault();
        const isLeft = (allSelectedSide() ?? focusedSide()) === "left";
        handleCopySideToClipboard(isLeft);
        return;
      }
      if (key === "s") {
        e.preventDefault();
        handleSaveSide(focusedSide() === "left");
        return;
      }
      if (key === "z") {
        e.preventDefault();
        handleUndo(focusedSide() === "left");
        return;
      }
      if (key === "y") {
        e.preventDefault();
        handleRedo(focusedSide() === "left");
        return;
      }
    }

    if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      jumpToHunk(1);
    } else if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      jumpToHunk(-1);
    } else if (e.altKey && e.key === "ArrowRight") {
      const h = currentHunk();
      if (h) {
        e.preventDefault();
        handleMergeHunk(h.id, "left_to_right");
      }
    } else if (e.altKey && e.key === "ArrowLeft") {
      const h = currentHunk();
      if (h) {
        e.preventDefault();
        handleMergeHunk(h.id, "right_to_left");
      }
    }
  };

  onMount(async () => {
    window.addEventListener("keydown", handleKeyDown);
    if (props.initialLeftPath || props.initialRightPath) {
      await handleLoadDiskPaths(props.initialLeftPath, props.initialRightPath);
    }
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <div class="view-container">
      {/* Beyond Compare Style Action Toolbar */}
      <div class="bc-toolbar">
        <div class="bc-toolbar-group">
          <button
            class={`bc-tool-btn ${rowFilter() === "all" ? "active" : ""}`}
            onClick={() => handleSetRowFilter("all")}
            title="显示全部行"
          >
            ✱ 全部
          </button>
          <button
            class={`bc-tool-btn ${rowFilter() === "diffs" ? "active" : ""}`}
            onClick={() => handleSetRowFilter("diffs")}
            title="仅显示差异行"
          >
            ≠ 仅差异
          </button>
          <button
            class={`bc-tool-btn ${rowFilter() === "equals" ? "active" : ""}`}
            onClick={() => handleSetRowFilter("equals")}
            title="仅显示相同行"
          >
            ＝ 仅相同
          </button>
        </div>

        <div class="bc-toolbar-divider" />

        <div class="bc-toolbar-group">
          <button
            class={`bc-tool-btn ${options().ignore_whitespace ? "active" : ""}`}
            onClick={() => handleToggleOption("ignore_whitespace")}
            title="忽略空白字符差异"
          >
            ␣ 忽略空白
          </button>
          <button
            class={`bc-tool-btn ${options().ignore_case ? "active" : ""}`}
            onClick={() => handleToggleOption("ignore_case")}
            title="忽略大小写差异"
          >
            Aa 忽略大小写
          </button>
        </div>

        <div class="bc-toolbar-divider" />

        <div class="bc-toolbar-group">
          <button
            class="bc-tool-btn"
            onClick={() => jumpToHunk(-1)}
            disabled={summary().hunks.length === 0}
            title="上一处差异 (Alt+Up)"
          >
            ↑ 上一差异
          </button>
          <button
            class="bc-tool-btn"
            onClick={() => jumpToHunk(1)}
            disabled={summary().hunks.length === 0}
            title="下一处差异 (Alt+Down)"
          >
            ↓ 下一差异
          </button>
          <button
            class="bc-tool-btn accent-right"
            disabled={!currentHunk()}
            onClick={() => currentHunk() && handleMergeHunk(currentHunk()!.id, "left_to_right")}
            title="将当前差异块复制到右侧 (Alt+Right)"
          >
            复制到右 »
          </button>
          <button
            class="bc-tool-btn accent-left"
            disabled={!currentHunk()}
            onClick={() => currentHunk() && handleMergeHunk(currentHunk()!.id, "right_to_left")}
            title="将当前差异块复制到左侧 (Alt+Left)"
          >
            « 复制到左
          </button>
          <button
            class="bc-tool-btn"
            onClick={handleSwapSides}
            title="交换左右两侧内容 (Swap Sides)"
          >
            ⇄ 交换左右
          </button>
        </div>

        <div class="bc-toolbar-divider" />

        <div class="bc-toolbar-group">
          <button
            class="bc-tool-btn"
            onClick={() => handleUndo(focusedSide() === "left")}
            title="撤销 (Ctrl+Z)"
          >
            ↶ 撤销
          </button>
          <button
            class="bc-tool-btn"
            onClick={() => handleRedo(focusedSide() === "left")}
            title="重做 (Ctrl+Y)"
          >
            ↷ 重做
          </button>
          <button
            class="bc-tool-btn"
            onClick={() => {
              const side = focusedSide();
              setFullEditDraft(
                CompareBackendClient.getSideFullText(props.sessionId, side === "left")
              );
              setEditingFullSide(side);
            }}
            title="自由编辑或粘贴大段多行文本"
          >
            ✏️ 编辑文本
          </button>
          <button
            class="bc-tool-btn"
            onClick={() => handleSaveSide(focusedSide() === "left")}
            title="保存当前焦点侧 (Ctrl+S)"
          >
            💾 保存
          </button>
        </div>

        {/* Summary Badges */}
        <div class="bc-stats-pills">
          <span class="stat-pill mod">修改块: {summary().stats.modified_hunks}</span>
          <span class="stat-pill ins">新增块: {summary().stats.inserted_hunks}</span>
          <span class="stat-pill del">删除块: {summary().stats.deleted_hunks}</span>
          <span class="stat-pill eq">相同行: {summary().stats.equal_lines}</span>
        </div>
      </div>

      {/* Dual Path / Clipboard Action Header */}
      <div class="dual-path-bar">
        <div
          class={`path-input-box ${focusedSide() === "left" ? "box-focused" : ""}`}
          onClick={() => setFocusedSide("left")}
        >
          <span class="side-badge left">LEFT</span>
          <input
            class="path-text-input"
            placeholder="输入左侧文件路径回车，或直接在下方 Ctrl+V 粘贴文本..."
            value={leftPath()}
            onInput={(e) => setLeftPath(e.currentTarget.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && handleLoadSingleDiskFile(true, leftPath())
            }
          />
          <Show when={summary().left_dirty}>
            <span class="dirty-dot" title="左侧有未保存修改">●</span>
          </Show>
          <span class="meta-tag">{summary().left_line_count} 行</span>
          <button
            class="browse-btn"
            title="从剪贴板粘贴文本到左侧 (Ctrl+V)"
            onClick={() => handleReadClipboardAndPaste(true)}
          >
            📋 粘贴
          </button>
          <button
            class="browse-btn"
            title="拷贝左侧全文到剪贴板 (Ctrl+C)"
            onClick={() => handleCopySideToClipboard(true)}
          >
            📄 拷贝
          </button>
          <button
            class="browse-btn"
            onClick={() => setBrowserTargetSide("left")}
          >
            📂 浏览...
          </button>
        </div>

        <div
          class={`path-input-box ${focusedSide() === "right" ? "box-focused" : ""}`}
          onClick={() => setFocusedSide("right")}
        >
          <span class="side-badge right">RIGHT</span>
          <input
            class="path-text-input"
            placeholder="输入右侧文件路径回车，或直接在下方 Ctrl+V 粘贴文本..."
            value={rightPath()}
            onInput={(e) => setRightPath(e.currentTarget.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && handleLoadSingleDiskFile(false, rightPath())
            }
          />
          <Show when={summary().right_dirty}>
            <span class="dirty-dot" title="右侧有未保存修改">●</span>
          </Show>
          <span class="meta-tag">{summary().right_line_count} 行</span>
          <button
            class="browse-btn"
            title="从剪贴板粘贴文本到右侧 (Ctrl+V)"
            onClick={() => handleReadClipboardAndPaste(false)}
          >
            📋 粘贴
          </button>
          <button
            class="browse-btn"
            title="拷贝右侧全文到剪贴板 (Ctrl+C)"
            onClick={() => handleCopySideToClipboard(false)}
          >
            📄 拷贝
          </button>
          <button
            class="browse-btn"
            onClick={() => setBrowserTargetSide("right")}
          >
            📂 浏览...
          </button>
        </div>
      </div>

      {/* Main Custom Virtual Scrolling Viewport */}
      <VirtualDiffViewport
        totalRows={summary().total_virtual_rows}
        leftLineCount={summary().left_line_count}
        rightLineCount={summary().right_line_count}
        focusedSide={focusedSide()}
        allSelectedSide={allSelectedSide()}
        hunks={summary().hunks}
        activeHunkId={currentHunk()?.id ?? null}
        selectedRowIdx={selectedRow()?.virtual_idx ?? null}
        fetchSlice={fetchSlice}
        onFocusSide={(side) => {
          setFocusedSide(side);
          if (allSelectedSide() && allSelectedSide() !== side) {
            setAllSelectedSide(null);
          }
        }}
        onPasteToSide={handlePasteTextToSide}
        onSelectRow={(row) => {
          setAllSelectedSide(null);
          setSelectedRow(row);
          if (row.hunk_id !== null) {
            const idx = summary().hunks.findIndex((h) => h.id === row.hunk_id);
            if (idx >= 0) setActiveHunkIdx(idx);
          }
        }}
        onMergeHunk={handleMergeHunk}
        onEditLine={handleEditLine}
        scrollTriggerRow={scrollTriggerRow()}
      />

      {/* Beyond Compare Signature Bottom Line Detail Comparison Pane */}
      <div class="bottom-line-inspector">
        <div class="inspector-header">
          <span>
            🔍 当前行详情对比 (点击左/右窗格可直接 Ctrl+V 粘贴全文、Ctrl+A 全选单侧、Ctrl+C 拷贝全文、双击行直接修改)
          </span>
          <Show when={selectedRow()}>
            {(row) => (
              <span class="inspector-coords">
                焦点侧: {focusedSide() === "left" ? "左 (LEFT)" : "右 (RIGHT)"} | 虚拟行 #
                {row().virtual_idx + 1} | 左行号: {row().left_line_no ?? "Gap"} | 右行号:{" "}
                {row().right_line_no ?? "Gap"}
              </span>
            )}
          </Show>
        </div>
        <div class="inspector-rows">
          <div class="inspector-line left-detail">
            <span class="inspector-side-label">左 (L)</span>
            <code class="inspector-code">
              <Show
                when={selectedRow()?.left_inline?.length}
                fallback={<span class="empty-placeholder">(空行 / 未选择)</span>}
              >
                <For each={selectedRow()!.left_inline}>
                  {(seg) => (
                    <span class={seg.tag === "delete" ? "inline-char-delete" : ""}>
                      {seg.text}
                    </span>
                  )}
                </For>
              </Show>
            </code>
          </div>
          <div class="inspector-line right-detail">
            <span class="inspector-side-label">右 (R)</span>
            <code class="inspector-code">
              <Show
                when={selectedRow()?.right_inline?.length}
                fallback={<span class="empty-placeholder">(空行 / 未选择)</span>}
              >
                <For each={selectedRow()!.right_inline}>
                  {(seg) => (
                    <span class={seg.tag === "insert" ? "inline-char-insert" : ""}>
                      {seg.text}
                    </span>
                  )}
                </For>
              </Show>
            </code>
          </div>
        </div>
      </div>

      {/* Native Disk File Browser Modal */}
      <Show when={browserTargetSide()}>
        {(side) => (
          <FileBrowserModal
            mode="file"
            title={side() === "left" ? "选择左侧对比文件" : "选择右侧对比文件"}
            initialPath={side() === "left" ? leftPath() : rightPath()}
            onClose={() => setBrowserTargetSide(null)}
            onSelect={(selectedPath) => {
              const isLeft = side() === "left";
              setBrowserTargetSide(null);
              handleLoadSingleDiskFile(isLeft, selectedPath);
            }}
          />
        )}
      </Show>

      {/* Multi-line Full Text Editor Modal */}
      <Show when={editingFullSide()}>
        {(side) => (
          <div class="modal-backdrop" onClick={() => setEditingFullSide(null)}>
            <div class="file-browser-dialog" onClick={(e) => e.stopPropagation()}>
              <div class="modal-header">
                <strong>
                  ✏️ 自由编辑/输入{side() === "left" ? "左侧 (LEFT)" : "右侧 (RIGHT)"}文本
                </strong>
                <button
                  class="modal-close-btn"
                  onClick={() => setEditingFullSide(null)}
                >
                  ×
                </button>
              </div>
              <textarea
                class="full-text-editor-area"
                placeholder="在此直接输入或粘贴多行文本..."
                value={fullEditDraft()}
                onInput={(e) => setFullEditDraft(e.currentTarget.value)}
                autofocus
              />
              <div class="modal-footer">
                <span class="modal-selection-hint">
                  共 {fullEditDraft() ? fullEditDraft().split("\n").length : 0} 行
                </span>
                <div class="modal-footer-btns">
                  <button
                    class="bc-tool-btn"
                    onClick={() => setEditingFullSide(null)}
                  >
                    取消
                  </button>
                  <button
                    class="bc-tool-btn active"
                    onClick={() => {
                      const isLeft = side() === "left";
                      setEditingFullSide(null);
                      handlePasteTextToSide(isLeft, fullEditDraft());
                    }}
                  >
                    应用并对比
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={toastMsg()}>
        <div class="floating-toast">{toastMsg()}</div>
      </Show>
    </div>
  );
};
