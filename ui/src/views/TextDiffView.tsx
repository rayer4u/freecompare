import { Component, createMemo, createSignal, onCleanup, onMount, Show, For } from "solid-js";
import {
  callRustRpc,
  CompareBackendClient,
  ReadTextFileResult,
  UserPreferencesDto,
  ViewRowFilter,
} from "../bridge";
import { FileBrowserModal } from "../components/FileBrowserModal";
import { VirtualDiffViewport } from "../engine/VirtualDiffViewport";
import { t } from "../i18n";
import {
  DiffOptions,
  MergeDirection,
  SiblingDiffFileItem,
  TwoWayDiffResult,
  ViewportRowDto,
} from "../types";

interface TextDiffViewProps {
  sessionId: string;
  isActive?: boolean;
  initialLeftPath?: string;
  initialRightPath?: string;
  initialLeftContent?: string;
  initialRightContent?: string;
  leftTitle?: string;
  rightTitle?: string;
  leftReadonly?: boolean;
  rightReadonly?: boolean;
  siblingFiles?: SiblingDiffFileItem[];
  reviewMode?: boolean;
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
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
    row: ViewportRowDto | null;
    side: "left" | "right";
  } | null>(null);
  const [rulesMenuPos, setRulesMenuPos] = createSignal<{ top: number; left: number } | null>(null);
  let lastReportedTitle = "";

  const dismissMenus = (e?: MouseEvent) => {
    const target = e?.target as HTMLElement | null;
    if (target?.closest(".rules-dropdown-trigger") || target?.closest(".app-dropdown-menu")) {
      return;
    }
    if (contextMenu()) setContextMenu(null);
    if (rulesMenuPos()) setRulesMenuPos(null);
  };

  const toggleRulesDropdown = (e: MouseEvent) => {
    e.stopPropagation();
    if (rulesMenuPos()) {
      setRulesMenuPos(null);
    } else {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const menuWidth = 220;
      const left = Math.min(rect.left, Math.max(10, window.innerWidth - menuWidth - 10));
      setRulesMenuPos({ top: rect.bottom + 4, left });
    }
  };

  const tryCloseOrExit = () => {
    if (
      confirmExitDirty() &&
      (summary().left_dirty || summary().right_dirty) &&
      !window.confirm(t("text_diff.dirty_confirm"))
    ) {
      return;
    }
    props.onCloseOrExit?.();
  };

  const handleApproveReview = async () => {
    await callRustRpc("set_process_exit_code", { code: 0 });
    await fetch("/api/shutdown", {
      method: "POST",
      body: JSON.stringify({ immediate: true }),
    }).catch(() => {});
    setTimeout(() => window.close(), 80);
  };

  const handleRejectReview = async () => {
    await callRustRpc("set_process_exit_code", { code: 1 });
    await fetch("/api/shutdown", {
      method: "POST",
      body: JSON.stringify({ immediate: true }),
    }).catch(() => {});
    setTimeout(() => window.close(), 80);
  };

  const isReviewMode = () => {
    if (props.reviewMode) return true;
    const lt = props.leftTitle ?? "";
    const rt = props.rightTitle ?? "";
    const lp = leftPath();
    const rp = rightPath();
    return (
      lt.includes("当前文件") ||
      lt.includes("Current") ||
      rt.includes("AI 拟修改") ||
      rt.includes("Proposed") ||
      lp.includes("fcompare-guard") ||
      rp.includes("fcompare-guard") ||
      lp.includes("CURRENT_") ||
      rp.includes("PROPOSED_")
    );
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
      showToast(t("text_diff.readonly_no_merge_right"));
      return;
    }
    if (direction === "right_to_left" && props.leftReadonly) {
      showToast(t("text_diff.readonly_no_merge_left"));
      return;
    }
    const nextSummary = CompareBackendClient.mergeHunk(props.sessionId, hunkId, direction);
    setSummary(nextSummary);
    setVersionTick((t) => t + 1);
    showToast(
      direction === "left_to_right"
        ? t("text_diff.hunk_copied_right", { id: hunkId + 1 })
        : t("text_diff.hunk_copied_left", { id: hunkId + 1 })
    );
  };

  const handleEditLine = (isLeft: boolean, lineNo1Based: number, newText: string) => {
    if ((isLeft && props.leftReadonly) || (!isLeft && props.rightReadonly)) {
      showToast(t("text_diff.readonly_no_edit"));
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
    showToast(
      t("text_diff.line_updated", {
        side: isLeft ? t("text_diff.side_left") : t("text_diff.side_right"),
        line: lineNo1Based,
      })
    );
  };

  const handlePasteTextToSide = (isLeft: boolean, text: string) => {
    if ((isLeft && props.leftReadonly) || (!isLeft && props.rightReadonly)) {
      showToast(t("text_diff.readonly_no_paste"));
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
    showToast(
      t("text_diff.pasted_lines", {
        count: lineCnt,
        side: isLeft ? t("text_diff.side_left") : t("text_diff.side_right"),
      })
    );
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
    showToast(t("text_diff.swap_toast"));
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

    // Load single side directly using full-fidelity read_text_file
    try {
      const res = await callRustRpc<ReadTextFileResult>("read_text_file", {
        path: trimmed,
      });
      if (res) {
        if (isLeft) setLeftPath(res.path);
        else setRightPath(res.path);

        const nextSummary = CompareBackendClient.replaceSideText(
          props.sessionId,
          isLeft,
          res.content
        );
        setSummary(CompareBackendClient.markSideSaved(props.sessionId, isLeft));
        setVersionTick((t) => t + 1);
        showToast(`已加载文件: ${res.path} (${res.line_count} 行, ${res.encoding})`);
      } else {
        showToast(`无法读取本地文件: ${trimmed}`);
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
        const lBase = l ? l.split(/[/\\]/).pop() || l : "";
        const rBase = r ? r.split(/[/\\]/).pop() || r : "";
        const shortTitle =
          lBase === rBase
            ? lBase
            : lBase && rBase
            ? `${lBase} ↔ ${rBase}`
            : lBase || rBase;
        if (shortTitle && shortTitle !== lastReportedTitle && !props.leftTitle && !props.rightTitle) {
          lastReportedTitle = shortTitle;
          props.onUpdateTabTitle?.(shortTitle);
        }
        showToast(`已加载对比文件: ${l} ↔ ${r}`);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReload = async () => {
    const l = leftPath().trim();
    const r = rightPath().trim();
    if (!l && !r) {
      showToast(t("text_diff.no_file_to_reload"));
      return;
    }
    if (
      (summary().left_dirty || summary().right_dirty) &&
      !window.confirm(t("text_diff.dirty_reload_confirm"))
    ) {
      return;
    }
    await handleLoadDiskPaths(l, r);
    showToast(t("text_diff.reload_success"));
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (props.isActive === false) return;
    const activeEl = document.activeElement;
    const isInputFocused =
      activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement;

    // 1. `Esc` key: Beyond Compare's signature muscle-memory shortcut!
    // If a modal or full-text selection is open, dismiss it first; otherwise exit / advance to next git difftool file!
    if (e.key === "Escape") {
      if (contextMenu()) {
        setContextMenu(null);
        return;
      }
      if (rulesMenuPos()) {
        setRulesMenuPos(null);
        return;
      }
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
      if (e.shiftKey) {
        handleRejectReview();
        return;
      }
      if (isReviewMode()) {
        handleApproveReview();
        return;
      }
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
          t("text_diff.all_selected_side", {
            side: side === "left" ? t("text_diff.side_left") : t("text_diff.side_right"),
            count,
          })
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

    // 4. Function keys (`F5` Reload / `F7` / `Shift+F7` BC Next/Prev diff) & single-key Vim/modern shortcuts
    if (e.key === "F5") {
      e.preventDefault();
      handleReload();
      return;
    }
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
    window.addEventListener("click", dismissMenus);
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
    window.removeEventListener("click", dismissMenus);
  });

  return (
    <div class="view-container">
      {/* Beyond Compare Style Action Toolbar (Clean & Slimmed) */}
      <div class="bc-toolbar">
        {/* 1. 视图过滤分段按钮 (全部 / ≠ 差异 / ＝ 相同) */}
        <div class="bc-toolbar-group">
          <button
            class={`bc-tool-btn ${rowFilter() === "all" ? "active" : ""}`}
            onClick={() => handleSetRowFilter("all")}
            title={t("text_diff.filter_all_tip")}
          >
            {t("text_diff.filter_all")}
          </button>
          <button
            class={`bc-tool-btn ${rowFilter() === "diffs" ? "active" : ""}`}
            onClick={() => handleSetRowFilter("diffs")}
            title={t("text_diff.filter_diffs_tip")}
          >
            {t("text_diff.filter_diffs")}
          </button>
          <button
            class={`bc-tool-btn ${rowFilter() === "equals" ? "active" : ""}`}
            onClick={() => handleSetRowFilter("equals")}
            title={t("text_diff.filter_equals_tip")}
          >
            {t("text_diff.filter_equals")}
          </button>
        </div>

        <div class="bc-toolbar-divider" />

        {/* 2. 差异导航 (上一处 / 下一处) */}
        <div class="bc-toolbar-group">
          <button
            class="bc-tool-btn"
            onClick={() => jumpToHunk(-1)}
            disabled={summary().hunks.length === 0}
            title={t("text_diff.prev_diff_tip")}
          >
            {t("text_diff.prev_diff")}
          </button>
          <button
            class="bc-tool-btn"
            onClick={() => jumpToHunk(1)}
            disabled={summary().hunks.length === 0}
            title={t("text_diff.next_diff_tip")}
          >
            {t("text_diff.next_diff")}
          </button>
        </div>

        <div class="bc-toolbar-divider" />

        {/* 3. 核心保存 */}
        <div class="bc-toolbar-group">
          <button
            class={`bc-tool-btn ${summary().left_dirty || summary().right_dirty ? "dirty-accent" : ""}`}
            onClick={() => handleSaveSide(focusedSide() === "left")}
            title={t("text_diff.save_tip")}
          >
            {t("text_diff.save")}
          </button>
        </div>

        <div class="bc-toolbar-divider" />

        {/* 4. 规则与视图收敛下拉菜单 (单个按钮代替原先零散的4个大按钮) */}
        <div class="bc-toolbar-group">
          <button
            class={`bc-tool-btn rules-dropdown-trigger ${rulesMenuPos() ? "active" : ""}`}
            onClick={toggleRulesDropdown}
            title={t("text_diff.view_rules_tip")}
          >
            {t("text_diff.view_rules_btn")} ▾
          </button>
        </div>

        <Show when={(props.siblingFiles?.length ?? 0) > 0}>
          <div class="bc-toolbar-divider" />
          <div class="bc-toolbar-group">
            <button
              class={`bc-tool-btn ${showFilesSidebar() ? "active" : ""}`}
              onClick={() => {
                const next = !showFilesSidebar();
                setShowFilesSidebar(next);
                callRustRpc("update_user_preferences", {
                  show_files_sidebar: next,
                }).catch(() => {});
              }}
              title="Ctrl+B"
            >
              {t("text_diff.files_nav")} ({Math.max(1, currentSiblingIdx() + 1)}/{props.siblingFiles!.length})
            </button>
            <button
              class="bc-tool-btn"
              onClick={() => switchToSiblingFile(currentSiblingIdx() - 1)}
              title={t("text_diff.prev_file_tip")}
            >
              ◀
            </button>
            <button
              class="bc-tool-btn"
              onClick={() => switchToSiblingFile(currentSiblingIdx() + 1)}
              title={t("text_diff.next_file_tip")}
            >
              ▶
            </button>
          </div>
        </Show>
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
            <span class="meta-tag" title={t("text_diff.readonly_lock")}>{t("text_diff.readonly_tag")}</span>
          </Show>
          <input
            class="path-text-input"
            list={`mru-left-${props.sessionId}`}
            placeholder={t("text_diff.path_left_placeholder")}
            value={leftPath()}
            onInput={(e) => setLeftPath(e.currentTarget.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && handleLoadSingleDiskFile(true, leftPath())
            }
            onBlur={() => {
              const p = leftPath().trim();
              if (p && !p.startsWith("(") && !summary().left_dirty) {
                handleLoadSingleDiskFile(true, p);
              }
            }}
          />
          <datalist id={`mru-left-${props.sessionId}`}>
            <For each={recentLeftPaths()}>{(p) => <option value={p} />}</For>
          </datalist>
          <Show when={summary().left_dirty}>
            <span class="dirty-dot" title={t("text_diff.dirty_dot_tip")}>●</span>
          </Show>
          <button
            class="browse-btn"
            title={t("text_diff.browse_btn")}
            onClick={() => setBrowserTargetSide("left")}
          >
            📂
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
            <span class="meta-tag" title={t("text_diff.readonly_lock")}>{t("text_diff.readonly_tag")}</span>
          </Show>
          <input
            class="path-text-input"
            list={`mru-right-${props.sessionId}`}
            placeholder={t("text_diff.path_right_placeholder")}
            value={rightPath()}
            onInput={(e) => setRightPath(e.currentTarget.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && handleLoadSingleDiskFile(false, rightPath())
            }
            onBlur={() => {
              const p = rightPath().trim();
              if (p && !p.startsWith("(") && !summary().right_dirty) {
                handleLoadSingleDiskFile(false, p);
              }
            }}
          />
          <datalist id={`mru-right-${props.sessionId}`}>
            <For each={recentRightPaths()}>{(p) => <option value={p} />}</For>
          </datalist>
          <Show when={summary().right_dirty}>
            <span class="dirty-dot" title={t("text_diff.dirty_dot_tip")}>●</span>
          </Show>
          <button
            class="browse-btn"
            title={t("text_diff.browse_btn")}
            onClick={() => setBrowserTargetSide("right")}
          >
            📂
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
              <span>{t("text_diff.changed_files")} ({props.siblingFiles!.length})</span>
              <span style={{ "font-size": "11px", opacity: "0.7" }}>{t("text_diff.switch_hint")}</span>
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
          onContextMenu={(e, row, side) => {
            const menuWidth = 240;
            const menuHeight = 360;
            const x = Math.min(e.clientX, window.innerWidth - menuWidth - 10);
            const y = Math.min(e.clientY, window.innerHeight - menuHeight - 10);
            setContextMenu({ x, y, row, side });
          }}
        />
      </div>

      {/* Beyond Compare Signature Bottom Line Detail Comparison Pane */}
      <Show when={showLineInspector()}>
        <div class="bottom-line-inspector">
          <div class="inspector-header">
            <span>
              {t("text_diff.inspector_header")}
            </span>
            <Show when={selectedRow()}>
              {(row) => (
                <span class="inspector-coords">
                  {t("text_diff.inspector_coords", {
                    side: focusedSide() === "left" ? t("text_diff.side_left") : t("text_diff.side_right"),
                    virtual: row().virtual_idx + 1,
                    left: row().left_line_no ?? "Gap",
                    right: row().right_line_no ?? "Gap",
                  })}
                </span>
              )}
            </Show>
          </div>
          <div class="inspector-rows">
            <div class="inspector-line left-detail">
              <span class="inspector-side-label">{t("text_diff.side_left")}</span>
              <code class="inspector-code">
                <Show
                  when={selectedRow()?.left_inline?.length}
                  fallback={<span class="empty-placeholder">{t("text_diff.empty_line")}</span>}
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
              <span class="inspector-side-label">{t("text_diff.side_right")}</span>
              <code class="inspector-code">
                <Show
                  when={selectedRow()?.right_inline?.length}
                  fallback={<span class="empty-placeholder">{t("text_diff.empty_line")}</span>}
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

      {/* Bottom Status Bar: Diff Statistics, Active Cursor Coords, Exit */}
      <footer class="app-statusbar">
        <div class="statusbar-left">
          <Show when={selectedRow()}>
            {(row) => (
              <span class="statusbar-item">
                {t("text_diff.inspector_coords", {
                  side: focusedSide() === "left" ? t("text_diff.side_left") : t("text_diff.side_right"),
                  virtual: row().virtual_idx + 1,
                  left: row().left_line_no ?? "—",
                  right: row().right_line_no ?? "—",
                })}
              </span>
            )}
          </Show>
          <Show when={!selectedRow()}>
            <span class="statusbar-item">
              {t("text_diff.side_left")}: {summary().left_line_count} {t("text_diff.line_count", { count: "" }).trim()} | {t("text_diff.side_right")}: {summary().right_line_count} {t("text_diff.line_count", { count: "" }).trim()}
            </span>
          </Show>
        </div>

        <div class="statusbar-center">
          <span class="stat-pill mod">{t("text_diff.stat_mod", { count: summary().stats.modified_hunks })}</span>
          <span class="stat-pill ins">{t("text_diff.stat_ins", { count: summary().stats.inserted_hunks })}</span>
          <span class="stat-pill del">{t("text_diff.stat_del", { count: summary().stats.deleted_hunks })}</span>
          <span class="stat-pill eq">{t("text_diff.stat_eq", { count: summary().stats.equal_lines })}</span>
        </div>

        <div class="statusbar-right">
          <Show when={(props.siblingFiles?.length ?? 0) > 0}>
            <span class="statusbar-item">
              📂 {Math.max(1, currentSiblingIdx() + 1)} / {props.siblingFiles!.length}
            </span>
          </Show>
          <Show when={!isReviewMode()}>
            <button
              class="statusbar-exit-btn"
              onClick={tryCloseOrExit}
              title={t("text_diff.exit_btn_tip")}
            >
              {t("text_diff.exit_btn")}
            </button>
          </Show>
        </div>
      </footer>

      {/* Viewport Right-Click Context Menu */}
      <Show when={contextMenu()}>
        {(menu) => {
          const side = () => menu().side;
          const isLeft = () => side() === "left";
          const hunk = () => currentHunk();

          return (
            <div
              class="app-context-menu"
              style={{
                position: "fixed",
                top: `${menu().y}px`,
                left: `${menu().x}px`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <Show when={hunk()}>
                <div
                  class="ctx-item"
                  onClick={() => {
                    dismissMenus();
                    handleMergeHunk(hunk()!.id, "left_to_right");
                  }}
                >
                  <span>{t("text_diff.copy_to_right")}</span>
                  <span class="ctx-shortcut">Alt+→</span>
                </div>
                <div
                  class="ctx-item"
                  onClick={() => {
                    dismissMenus();
                    handleMergeHunk(hunk()!.id, "right_to_left");
                  }}
                >
                  <span>{t("text_diff.copy_to_left")}</span>
                  <span class="ctx-shortcut">Alt+←</span>
                </div>
                <div class="ctx-divider" />
              </Show>

              <div
                class="ctx-item"
                onClick={() => {
                  dismissMenus();
                  const targetSide = side();
                  setFullEditDraft(
                    CompareBackendClient.getSideFullText(props.sessionId, targetSide === "left")
                  );
                  setEditingFullSide(targetSide);
                }}
              >
                <span>{t("text_diff.ctx_edit_side")}</span>
              </div>
              <div
                class="ctx-item"
                onClick={() => {
                  dismissMenus();
                  handleUndo(isLeft());
                }}
              >
                <span>{t("text_diff.undo")}</span>
                <span class="ctx-shortcut">Ctrl+Z</span>
              </div>
              <div
                class="ctx-item"
                onClick={() => {
                  dismissMenus();
                  handleRedo(isLeft());
                }}
              >
                <span>{t("text_diff.redo")}</span>
                <span class="ctx-shortcut">Ctrl+Y</span>
              </div>

              <div class="ctx-divider" />

              <div
                class="ctx-item"
                onClick={() => {
                  dismissMenus();
                  handleSaveSide(isLeft());
                }}
              >
                <span>{t("text_diff.save")}</span>
                <span class="ctx-shortcut">Ctrl+S</span>
              </div>
              <div
                class="ctx-item"
                onClick={() => {
                  dismissMenus();
                  handleSwapSides();
                }}
              >
                <span>{t("text_diff.swap_sides")}</span>
              </div>
              <div
                class="ctx-item"
                onClick={() => {
                  dismissMenus();
                  handleReload();
                }}
              >
                <span>{t("text_diff.reload")}</span>
                <span class="ctx-shortcut">F5</span>
              </div>

              <div class="ctx-divider" />

              <div
                class="ctx-item"
                onClick={() => {
                  dismissMenus();
                  const row = menu().row;
                  const text = isLeft() ? row?.left_text : row?.right_text;
                  if (text !== null && text !== undefined) {
                    navigator.clipboard.writeText(text);
                    showToast(t("text_diff.ctx_copy_line") + " (" + text.length + " chars)");
                  }
                }}
              >
                <span>{t("text_diff.ctx_copy_line")}</span>
                <span class="ctx-shortcut">Ctrl+C</span>
              </div>
              <div
                class="ctx-item"
                onClick={() => {
                  dismissMenus();
                  handleCopySideToClipboard(isLeft());
                }}
              >
                <span>{t("text_diff.ctx_copy_side")}</span>
              </div>
            </div>
          );
        }}
      </Show>

      {/* 视图与规则浮动菜单 (Fixed positioning avoids overflow clipping) */}
      <Show when={rulesMenuPos()}>
        {(pos) => (
          <div
            class="app-dropdown-menu"
            style={{
              position: "fixed",
              top: `${pos().top}px`,
              left: `${pos().left}px`,
              "z-index": 9999,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              class="dropdown-item"
              onClick={() => handleToggleOption("ignore_whitespace")}
            >
              <span>{t("text_diff.ignore_whitespace")}</span>
              <span class="dropdown-check">{options().ignore_whitespace ? "✓" : ""}</span>
            </div>
            <div
              class="dropdown-item"
              onClick={() => handleToggleOption("ignore_case")}
            >
              <span>{t("text_diff.ignore_case")}</span>
              <span class="dropdown-check">{options().ignore_case ? "✓" : ""}</span>
            </div>
            <div
              class="dropdown-item"
              onClick={() => {
                const next = !showWhitespaceGlyphs();
                setShowWhitespaceGlyphs(next);
                callRustRpc("update_user_preferences", {
                  show_whitespace_glyphs: next,
                }).catch(() => {});
              }}
            >
              <span>{t("text_diff.whitespace_glyphs")}</span>
              <span class="dropdown-check">{showWhitespaceGlyphs() ? "✓" : ""}</span>
            </div>
            <div class="dropdown-divider" />
            <div
              class="dropdown-item"
              onClick={() => {
                const next = !showLineInspector();
                setShowLineInspector(next);
                callRustRpc("update_user_preferences", {
                  show_line_inspector: next,
                }).catch(() => {});
              }}
            >
              <span>{t("text_diff.line_inspector")}</span>
              <span class="dropdown-check">{showLineInspector() ? "✓" : ""}</span>
            </div>
          </div>
        )}
      </Show>

      {/* Native Disk File Browser Modal */}
      <Show when={browserTargetSide()}>
        {(side) => (
          <FileBrowserModal
            mode="file"
            title={side() === "left" ? t("text_diff.browse_title_left") : t("text_diff.browse_title_right")}
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
                  {t("text_diff.modal_edit_title", {
                    side: side() === "left" ? t("text_diff.side_left") : t("text_diff.side_right"),
                  })}
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
                placeholder={t("text_diff.modal_edit_placeholder")}
                value={fullEditDraft()}
                onInput={(e) => setFullEditDraft(e.currentTarget.value)}
                autofocus
              />
              <div class="modal-footer">
                <span class="modal-selection-hint">
                  {t("text_diff.modal_edit_lines", {
                    count: fullEditDraft() ? fullEditDraft().split("\n").length : 0,
                  })}
                </span>
                <div class="modal-footer-btns">
                  <button
                    class="bc-tool-btn"
                    onClick={() => setEditingFullSide(null)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    class="bc-tool-btn active"
                    onClick={() => {
                      const isLeft = side() === "left";
                      setEditingFullSide(null);
                      handlePasteTextToSide(isLeft, fullEditDraft());
                    }}
                  >
                    {t("text_diff.modal_apply")}
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
