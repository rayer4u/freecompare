import { Component, createMemo, createSignal, onCleanup, onMount, Show, For } from "solid-js";
import {
  callRustRpc,
  CompareBackendClient,
  UserPreferencesDto,
  ViewRowFilter,
} from "../bridge";
import { FileBrowserModal } from "../components/FileBrowserModal";
import { VirtualDiffViewport } from "../engine/VirtualDiffViewport";
import {
  DiffOptions,
  MergeDirection,
  SiblingDiffFileItem,
  TwoWayDiffResult,
  ViewportRowDto,
} from "../types";

interface TextDiffViewProps {
  sessionId: string;
  initialLeftPath?: string;
  initialRightPath?: string;
  initialLeftContent?: string;
  initialRightContent?: string;
  leftTitle?: string;
  rightTitle?: string;
  leftReadonly?: boolean;
  rightReadonly?: boolean;
  siblingFiles?: SiblingDiffFileItem[];
  onCloseOrExit?: () => void;
  onUpdateTabTitle?: (newTitle: string) => void;
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
  const [showFilesSidebar, setShowFilesSidebar] = createSignal<boolean>(
    Boolean(props.siblingFiles && props.siblingFiles.length > 1)
  );
  const [showLineInspector, setShowLineInspector] = createSignal<boolean>(true);
  const [editorFontSize, setEditorFontSize] = createSignal<number>(13);
  const [showWhitespaceGlyphs, setShowWhitespaceGlyphs] = createSignal<boolean>(false);
  const [autoJumpFirstDiff, setAutoJumpFirstDiff] = createSignal<boolean>(true);
  const [confirmExitDirty, setConfirmExitDirty] = createSignal<boolean>(true);
  const [recentLeftPaths, setRecentLeftPaths] = createSignal<string[]>([]);
  const [recentRightPaths, setRecentRightPaths] = createSignal<string[]>([]);

  const tryCloseOrExit = () => {
    if (
      confirmExitDirty() &&
      (summary().left_dirty || summary().right_dirty) &&
      !window.confirm("当前文件存在未保存的修改，确定要放弃修改并退出吗？")
    ) {
      return;
    }
    props.onCloseOrExit?.();
  };

  const currentSiblingIdx = createMemo(() => {
    const list = props.siblingFiles ?? [];
    if (list.length === 0) return -1;
    const lp = leftPath().trim();
    const rp = rightPath().trim();
    return list.findIndex(
      (item) => item.leftFullPath === lp || item.rightFullPath === rp
    );
  });

  const switchToSiblingFile = async (targetIdx: number) => {
    const list = props.siblingFiles ?? [];
    if (list.length === 0) return;
    const wrapped = (targetIdx + list.length) % list.length;
    const target = list[wrapped];
    setLeftPath(target.leftFullPath);
    setRightPath(target.rightFullPath);
    setActiveHunkIdx(0);
    const shortName = target.relativePath.split("/").pop() ?? target.relativePath;
    props.onUpdateTabTitle?.(shortName);
    await handleLoadDiskPaths(target.leftFullPath, target.rightFullPath);
  };

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
    if (direction === "left_to_right" && props.rightReadonly) {
      showToast("🔒 右侧处于只读锁定模式 (-ro2)，禁止覆盖修改");
      return;
    }
    if (direction === "right_to_left" && props.leftReadonly) {
      showToast("🔒 左侧处于只读锁定模式 (-ro1)，禁止覆盖修改");
      return;
    }
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
    if ((isLeft && props.leftReadonly) || (!isLeft && props.rightReadonly)) {
      showToast("🔒 当前侧处于只读锁定模式 (-ro)，无法编辑");
      return;
    }
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
    if ((isLeft && props.leftReadonly) || (!isLeft && props.rightReadonly)) {
      showToast("🔒 当前侧处于只读锁定模式 (-ro)，无法粘贴覆盖");
      return;
    }
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
    callRustRpc("update_user_preferences", { text_row_filter: filter }).catch(() => {});
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
    callRustRpc("update_user_preferences", {
      ignore_whitespace: next.ignore_whitespace,
      ignore_case: next.ignore_case,
    }).catch(() => {});
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
        if (autoJumpFirstDiff() && loaded.hunks.length > 0) {
          setActiveHunkIdx(0);
          const firstHunk = loaded.hunks[0];
          setScrollTriggerRow(firstHunk.virtual_start);
          const slice = CompareBackendClient.getViewportSlice(
            props.sessionId,
            firstHunk.virtual_start,
            1
          );
          if (slice.rows[0]) setSelectedRow(slice.rows[0]);
        } else {
          const initial = CompareBackendClient.getViewportSlice(props.sessionId, 0, 50);
          const firstDiff =
            initial.rows.find((row) => row.status !== "equal") ?? initial.rows[0];
          if (firstDiff) setSelectedRow(firstDiff);
        }
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

    // 1. `Esc` key: Beyond Compare's signature muscle-memory shortcut!
    // If a modal or full-text selection is open, dismiss it first; otherwise exit / advance to next git difftool file!
    if (e.key === "Escape") {
      if (browserTargetSide()) {
        setBrowserTargetSide(null);
        return;
      }
      if (editingFullSide()) {
        setEditingFullSide(null);
        return;
      }
      if (allSelectedSide()) {
        setAllSelectedSide(null);
        return;
      }
      if (isInputFocused) {
        (activeEl as HTMLElement).blur();
        return;
      }
      e.preventDefault();
      tryCloseOrExit();
      return;
    }

    if (isInputFocused) return;

    // 2. Ctrl / Cmd shortcuts (BC + FreeCompare enhanced)
    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      // Font size zoom (`Ctrl + =` / `Ctrl + -` / `Ctrl + 0`)
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        const nextSize = Math.min(24, editorFontSize() + 1);
        setEditorFontSize(nextSize);
        callRustRpc("update_user_preferences", { editor_font_size: nextSize }).catch(
          () => {}
        );
        showToast(`代码字号: ${nextSize}px`);
        return;
      }
      if (e.key === "-") {
        e.preventDefault();
        const nextSize = Math.max(10, editorFontSize() - 1);
        setEditorFontSize(nextSize);
        callRustRpc("update_user_preferences", { editor_font_size: nextSize }).catch(
          () => {}
        );
        showToast(`代码字号: ${nextSize}px`);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        setEditorFontSize(13);
        callRustRpc("update_user_preferences", { editor_font_size: 13 }).catch(() => {});
        showToast("代码字号已重置: 13px");
        return;
      }
      // `Ctrl+Alt+M` (BC next diff file) / `Ctrl+Alt+N` (BC prev diff file)
      if (e.altKey && key === "m") {
        e.preventDefault();
        if ((props.siblingFiles?.length ?? 0) > 0) {
          switchToSiblingFile(currentSiblingIdx() + 1);
        } else {
          tryCloseOrExit();
        }
        return;
      }
      if (e.altKey && key === "n") {
        e.preventDefault();
        if ((props.siblingFiles?.length ?? 0) > 0) {
          switchToSiblingFile(currentSiblingIdx() - 1);
        }
        return;
      }
      // `Ctrl+W`: Close current comparison / advance git difftool
      if (key === "w") {
        e.preventDefault();
        tryCloseOrExit();
        return;
      }
      // `Ctrl+B`: Toggle Changed Files Sidebar (VS Code style)
      if (key === "b" && (props.siblingFiles?.length ?? 0) > 0) {
        e.preventDefault();
        setShowFilesSidebar((v) => !v);
        return;
      }
      // `Ctrl+N` (BC Next Diff) / `Ctrl+P` (BC Prev Diff)
      if (key === "n") {
        e.preventDefault();
        jumpToHunk(1);
        return;
      }
      if (key === "p") {
        e.preventDefault();
        jumpToHunk(-1);
        return;
      }
      // `Ctrl+R` (BC Copy to Right) / `Ctrl+L` (BC Copy to Left)
      if (key === "r") {
        const h = currentHunk();
        if (h) {
          e.preventDefault();
          handleMergeHunk(h.id, "left_to_right");
        }
        return;
      }
      if (key === "l") {
        const h = currentHunk();
        if (h) {
          e.preventDefault();
          handleMergeHunk(h.id, "right_to_left");
        }
        return;
      }
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
      return;
    }

    // 3. Alt shortcuts (Beyond Compare classic + PageUp/PageDown file switching)
    if (e.altKey) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        jumpToHunk(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        jumpToHunk(-1);
      } else if (e.key === "ArrowRight") {
        const h = currentHunk();
        if (h) {
          e.preventDefault();
          handleMergeHunk(h.id, "left_to_right");
        }
      } else if (e.key === "ArrowLeft") {
        const h = currentHunk();
        if (h) {
          e.preventDefault();
          handleMergeHunk(h.id, "right_to_left");
        }
      } else if (e.key === "PageDown" || e.key === "]") {
        e.preventDefault();
        if ((props.siblingFiles?.length ?? 0) > 0) {
          switchToSiblingFile(currentSiblingIdx() + 1);
        } else {
          props.onCloseOrExit?.();
        }
      } else if (e.key === "PageUp" || e.key === "[") {
        e.preventDefault();
        if ((props.siblingFiles?.length ?? 0) > 0) {
          switchToSiblingFile(currentSiblingIdx() - 1);
        }
      } else if (e.key === "Home") {
        e.preventDefault();
        if (summary().hunks.length > 0) {
          setActiveHunkIdx(0);
          jumpToHunk(0);
        }
      } else if (e.key === "End") {
        e.preventDefault();
        if (summary().hunks.length > 0) {
          setActiveHunkIdx(summary().hunks.length - 1);
          jumpToHunk(0);
        }
      }
      return;
    }

    // 4. Function keys (`F7` / `Shift+F7` BC Next/Prev diff) & single-key Vim/modern shortcuts
    if (e.key === "F7") {
      e.preventDefault();
      jumpToHunk(e.shiftKey ? -1 : 1);
    } else if (e.key === "n" || e.key === "j") {
      e.preventDefault();
      jumpToHunk(1);
    } else if (e.key === "p" || e.key === "N" || e.key === "k") {
      e.preventDefault();
      jumpToHunk(-1);
    } else if (e.key === "]") {
      e.preventDefault();
      if ((props.siblingFiles?.length ?? 0) > 0) {
        switchToSiblingFile(currentSiblingIdx() + 1);
      } else {
        tryCloseOrExit();
      }
    } else if (e.key === "[") {
      e.preventDefault();
      if ((props.siblingFiles?.length ?? 0) > 0) {
        switchToSiblingFile(currentSiblingIdx() - 1);
      }
    } else if (e.key === "\\") {
      if ((props.siblingFiles?.length ?? 0) > 0) {
        e.preventDefault();
        setShowFilesSidebar((v) => !v);
      }
    } else if (e.key === "d") {
      e.preventDefault();
      handleSetRowFilter(rowFilter() === "diffs" ? "all" : "diffs");
    } else if (e.key === "q") {
      e.preventDefault();
      tryCloseOrExit();
    }
  };

  onMount(async () => {
    window.addEventListener("keydown", handleKeyDown);
    const prefs = await callRustRpc<UserPreferencesDto>("get_user_preferences");
    if (prefs) {
      const f =
        prefs.text_row_filter === "diffs" || prefs.text_row_filter === "equals"
          ? prefs.text_row_filter
          : "all";
      setRowFilter(f);
      setOptions({
        ignore_whitespace: Boolean(prefs.ignore_whitespace),
        ignore_case: Boolean(prefs.ignore_case),
        show_only_diffs: f === "diffs",
        context_lines: 3,
      });
      if ((props.siblingFiles?.length ?? 0) > 1) {
        setShowFilesSidebar(prefs.show_files_sidebar ?? true);
      }
      setShowLineInspector(prefs.show_line_inspector ?? true);
      setEditorFontSize(prefs.editor_font_size || 13);
      setShowWhitespaceGlyphs(Boolean(prefs.show_whitespace_glyphs));
      setAutoJumpFirstDiff(prefs.auto_jump_first_diff ?? true);
      setConfirmExitDirty(prefs.confirm_before_exit_dirty ?? true);
      setRecentLeftPaths(prefs.recent_left_paths ?? []);
      setRecentRightPaths(prefs.recent_right_paths ?? []);
    }
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
          <button
            class={`bc-tool-btn ${showWhitespaceGlyphs() ? "active" : ""}`}
            onClick={() => {
              const next = !showWhitespaceGlyphs();
              setShowWhitespaceGlyphs(next);
              callRustRpc("update_user_preferences", {
                show_whitespace_glyphs: next,
              }).catch(() => {});
            }}
            title="显示可见空白符 (· 空格 / → Tab)"
          >
            ¶ 可见空白
          </button>
          <button
            class={`bc-tool-btn ${showLineInspector() ? "active" : ""}`}
            onClick={() => {
              const next = !showLineInspector();
              setShowLineInspector(next);
              callRustRpc("update_user_preferences", {
                show_line_inspector: next,
              }).catch(() => {});
            }}
            title="显示/隐藏底部单行详情放大镜面板"
          >
            🔍 详情栏
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

        {/* Summary Badges & Changed File Navigation */}
        <div class="bc-stats-pills">
          <Show when={(props.siblingFiles?.length ?? 0) > 0}>
            <button
              class={`bc-tool-btn ${showFilesSidebar() ? "active" : ""}`}
              onClick={() => {
                const next = !showFilesSidebar();
                setShowFilesSidebar(next);
                callRustRpc("update_user_preferences", {
                  show_files_sidebar: next,
                }).catch(() => {});
              }}
              title="展开/收起变更文件列表 (Ctrl+B 或 \)"
            >
              📂 文件 ({Math.max(1, currentSiblingIdx() + 1)}/{props.siblingFiles!.length})
            </button>
            <button
              class="bc-tool-btn"
              onClick={() => switchToSiblingFile(currentSiblingIdx() - 1)}
              title="上一个变更文件 ([ 或 Alt+PageUp 或 Ctrl+Alt+N)"
            >
              ⬅️ 上一文件 ([)
            </button>
            <button
              class="bc-tool-btn"
              onClick={() => switchToSiblingFile(currentSiblingIdx() + 1)}
              title="下一个变更文件 (] 或 Alt+PageDown 或 Ctrl+Alt+M)"
            >
              ➡️ 下一文件 (])
            </button>
          </Show>
          <span class="stat-pill mod">修改块: {summary().stats.modified_hunks}</span>
          <span class="stat-pill ins">新增块: {summary().stats.inserted_hunks}</span>
          <span class="stat-pill del">删除块: {summary().stats.deleted_hunks}</span>
          <span class="stat-pill eq">相同行: {summary().stats.equal_lines}</span>
          <button
            class="bc-tool-btn"
            onClick={tryCloseOrExit}
            title="Beyond Compare 风格 Esc 退出当前对比，自动进入 Git 队列下一个文件或返回目录列表 (Esc / q / Ctrl+W)"
          >
            ⏭️ 下个文件/退出 (Esc)
          </button>
        </div>
      </div>

      {/* Dual Path / Clipboard Action Header */}
      <div class="dual-path-bar">
        <div
          class={`path-input-box ${focusedSide() === "left" ? "box-focused" : ""}`}
          onClick={() => setFocusedSide("left")}
        >
          <span class="side-badge left">
            {props.leftTitle ? `LEFT: ${props.leftTitle}` : "LEFT"}
          </span>
          <Show when={props.leftReadonly}>
            <span class="meta-tag" title="只读锁定 (-ro1)">🔒 只读</span>
          </Show>
          <input
            class="path-text-input"
            list={`mru-left-${props.sessionId}`}
            placeholder="输入左侧文件路径回车，或直接在下方 Ctrl+V 粘贴文本..."
            value={leftPath()}
            onInput={(e) => setLeftPath(e.currentTarget.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && handleLoadSingleDiskFile(true, leftPath())
            }
          />
          <datalist id={`mru-left-${props.sessionId}`}>
            <For each={recentLeftPaths()}>{(p) => <option value={p} />}</For>
          </datalist>
          <Show when={summary().left_dirty}>
            <span class="dirty-dot" title="左侧有未保存修改">●</span>
          </Show>
          <span class="meta-tag">{summary().left_line_count} 行</span>
          <button
            class="browse-btn"
            disabled={props.leftReadonly}
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
          <span class="side-badge right">
            {props.rightTitle ? `RIGHT: ${props.rightTitle}` : "RIGHT"}
          </span>
          <Show when={props.rightReadonly}>
            <span class="meta-tag" title="只读锁定 (-ro2)">🔒 只读</span>
          </Show>
          <input
            class="path-text-input"
            list={`mru-right-${props.sessionId}`}
            placeholder="输入右侧文件路径回车，或直接在下方 Ctrl+V 粘贴文本..."
            value={rightPath()}
            onInput={(e) => setRightPath(e.currentTarget.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && handleLoadSingleDiskFile(false, rightPath())
            }
          />
          <datalist id={`mru-right-${props.sessionId}`}>
            <For each={recentRightPaths()}>{(p) => <option value={p} />}</For>
          </datalist>
          <Show when={summary().right_dirty}>
            <span class="dirty-dot" title="右侧有未保存修改">●</span>
          </Show>
          <span class="meta-tag">{summary().right_line_count} 行</span>
          <button
            class="browse-btn"
            disabled={props.rightReadonly}
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

      {/* Main Stage: Optional Changed Files Sidebar + Custom Virtual Scrolling Viewport */}
      <div style={{ display: "flex", flex: "1", "min-height": "0", overflow: "hidden" }}>
        <Show when={showFilesSidebar() && (props.siblingFiles?.length ?? 0) > 0}>
          <aside
            style={{
              width: "240px",
              "border-right": "1px solid var(--border-color)",
              background: "var(--bg-panel)",
              display: "flex",
              "flex-direction": "column",
              "flex-shrink": "0",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "6px 10px",
                "font-size": "12px",
                "font-weight": "600",
                "border-bottom": "1px solid var(--border-color)",
                display: "flex",
                "justify-content": "space-between",
                "align-items": "center",
              }}
            >
              <span>📂 变更文件 ({props.siblingFiles!.length})</span>
              <span style={{ "font-size": "11px", opacity: "0.7" }}>[ / ] 切换</span>
            </div>
            <div style={{ flex: "1", "overflow-y": "auto", padding: "4px 0" }}>
              <For each={props.siblingFiles}>
                {(item, idx) => {
                  const isActive = () => idx() === currentSiblingIdx();
                  const statusBadge =
                    item.status === "modified"
                      ? "≠"
                      : item.status === "left_only"
                      ? "←"
                      : item.status === "right_only"
                      ? "→"
                      : "=";
                  return (
                    <div
                      onClick={() => switchToSiblingFile(idx())}
                      style={{
                        padding: "5px 10px",
                        cursor: "pointer",
                        "font-size": "12px",
                        display: "flex",
                        "align-items": "center",
                        gap: "6px",
                        background: isActive()
                          ? "rgba(59, 130, 246, 0.22)"
                          : "transparent",
                        "border-left": isActive()
                          ? "3px solid #3b82f6"
                          : "3px solid transparent",
                        "white-space": "nowrap",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                      }}
                      title={item.relativePath}
                    >
                      <span style={{ opacity: "0.8", "font-family": "monospace" }}>
                        {statusBadge}
                      </span>
                      <span style={{ overflow: "hidden", "text-overflow": "ellipsis" }}>
                        {item.relativePath}
                      </span>
                    </div>
                  );
                }}
              </For>
            </div>
          </aside>
        </Show>

        <VirtualDiffViewport
          totalRows={summary().total_virtual_rows}
          leftLineCount={summary().left_line_count}
          rightLineCount={summary().right_line_count}
          focusedSide={focusedSide()}
          allSelectedSide={allSelectedSide()}
          hunks={summary().hunks}
          activeHunkId={currentHunk()?.id ?? null}
          selectedRowIdx={selectedRow()?.virtual_idx ?? null}
          editorFontSize={editorFontSize()}
          showWhitespaceGlyphs={showWhitespaceGlyphs()}
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
      </div>

      {/* Beyond Compare Signature Bottom Line Detail Comparison Pane */}
      <Show when={showLineInspector()}>
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
      </Show>

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
