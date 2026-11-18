import { Component, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import {
  callRustRpc,
  createBlankFolderDiff,
  recomputeFolderStats,
  UserPreferencesDto,
} from "../bridge";
import { FileBrowserModal } from "../components/FileBrowserModal";
import { t } from "../i18n";
import { mergeFolderExcludeGlobs } from "../utils/preferences";
import {
  mergeSubtreeEntries,
  mergeTopLevelPreservingSubtrees,
  resolveBatchTargetPaths,
} from "../utils/folder_sync";
import {
  displayPathBaseName,
  isSftpUri,
  joinComparePath,
} from "../utils/sftp";
import {
  FolderDiffResult,
  FolderEntryDto,
  FolderItemStatus,
  FolderSubtreeResult,
  SiblingDiffFileItem,
} from "../types";

interface FolderDiffViewProps {
  isActive?: boolean;
  initialLeftDir?: string;
  initialRightDir?: string;
  expandAll?: boolean;
  filters?: string[];
  userPrefs?: UserPreferencesDto | null;
  onCloseOrExit?: () => void;
  onOpenFileDiff: (
    leftFullPath: string,
    rightFullPath: string,
    relativePath: string,
    siblingFiles: SiblingDiffFileItem[]
  ) => void;
  onOpenFolderDiff?: (
    leftFullPath: string,
    rightFullPath: string,
    relativePath: string
  ) => void;
  onUpdateTabTitle?: (newTitle: string) => void;
}

type FilterStatus = "all" | "diffs" | "orphans" | "equals";
type SelectedCellItem = { side: "left" | "right"; relPath: string };

export const FolderDiffView: Component<FolderDiffViewProps> = (props) => {
  let treeBodyRef: HTMLDivElement | undefined;
  const [folderData, setFolderData] = createSignal<FolderDiffResult>(
    createBlankFolderDiff()
  );
  const [leftInput, setLeftInput] = createSignal(props.initialLeftDir ?? "");
  const [rightInput, setRightInput] = createSignal(props.initialRightDir ?? "");
  const [filterStatus, setFilterStatus] = createSignal<FilterStatus>("all");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [collapsedDirs, setCollapsedDirs] = createSignal<Set<string>>(new Set());
  const [scannedDirs, setScannedDirs] = createSignal<Set<string>>(new Set());
  const [selectedRelPath, setSelectedRelPath] = createSignal<string | null>(null);
  const [selectedItems, setSelectedItems] = createSignal<SelectedCellItem[]>([]);
  const [activeSide, setActiveSide] = createSignal<"left" | "right">("left");
  const [pendingCompareSource, setPendingCompareSource] = createSignal<{
    side: "left" | "right";
    relPath: string;
  } | null>(null);
  const [compareMode, setCompareMode] = createSignal<"hash" | "fast">("hash");
  const [isRecursiveScan, setIsRecursiveScan] = createSignal(Boolean(props.expandAll));
  const [prefsExcludeGlobs, setPrefsExcludeGlobs] = createSignal<string[] | null>(null);
  const effectiveExcludeGlobs = () =>
    mergeFolderExcludeGlobs(
      props.userPrefs?.folder_exclude_globs ?? prefsExcludeGlobs(),
      props.filters
    );
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
    entry: FolderEntryDto;
    side: "left" | "right" | "row";
  } | null>(null);
  const [browserSide, setBrowserSide] = createSignal<"left" | "right" | null>(null);
  const [recentFolders, setRecentFolders] = createSignal<string[]>([]);
  const [toast, setToast] = createSignal<string | null>(null);
  let lastReportedTitle = "";
  let lastScannedLeft = "";
  let lastScannedRight = "";
  let sftpHintShown = false;

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const scanRealFolders = async (lDir: string, rDir: string, recursive = isRecursiveScan()) => {
    const l = lDir.trim();
    const r = rDir.trim();
    if (!l || !r) {
      notify(t("folder_diff.path_left_placeholder"));
      return;
    }
    try {
      const res = await callRustRpc<FolderDiffResult>("scan_folder_diff", {
        left_dir: l,
        right_dir: r,
        options: {
          mode: compareMode() === "hash" ? "content_hash" : "fast_metadata",
          ignore_case_names: false,
          exclude_globs: effectiveExcludeGlobs(),
          recursive,
        },
      });
      if (res) {
        lastScannedLeft = l;
        lastScannedRight = r;
        setFolderData(res);
        setScannedDirs(new Set<string>());
        setLeftInput(res.left_root);
        setRightInput(res.right_root);
        if ((isSftpUri(res.left_root) || isSftpUri(res.right_root)) && compareMode() === "hash" && !sftpHintShown) {
          sftpHintShown = true;
          notify(t("folder_diff.sftp_fast_hint"));
        }
        // By default: collapse all subfolders so only the current level is shown initially!
        if (!props.expandAll && !recursive) {
          const dirs = res.entries.filter((e) => e.is_dir).map((e) => e.relative_path);
          setCollapsedDirs(new Set(dirs));
        } else {
          setCollapsedDirs(new Set<string>());
        }
        // Prefer selecting the first modified/diff file automatically (like Beyond Compare)
        const firstDiffFile =
          res.entries.find((e) => !e.is_dir && e.status !== "equal") ??
          res.entries.find((e) => !e.is_dir) ??
          res.entries[0];
        if (firstDiffFile) {
          selectRow(firstDiffFile);
        } else {
          setSelectedRelPath(null);
          setSelectedItems([]);
        }
        const lBase = displayPathBaseName(res.left_root);
        const rBase = displayPathBaseName(res.right_root);
        const remotePrefix = isSftpUri(res.left_root) || isSftpUri(res.right_root) ? "🌐 " : "";
        const baseTitle =
          lBase === rBase
            ? lBase
            : lBase && rBase
            ? `${lBase} ↔ ${rBase}`
            : lBase || rBase;
        const folderTitle = baseTitle ? `${remotePrefix}${baseTitle}` : "";
        if (folderTitle && folderTitle !== lastReportedTitle) {
          lastReportedTitle = folderTitle;
          props.onUpdateTabTitle?.(`📁 ${folderTitle}`);
        }
      } else {
        notify(t("folder_diff.err_scan"));
      }
    } catch (err) {
      notify(err instanceof Error && err.message ? err.message : t("folder_diff.err_scan"));
    }
  };

  const fetchSubfolder = (subRel: string, recursive = false) =>
    callRustRpc<FolderSubtreeResult>("compare_subfolder", {
      left_dir: folderData().left_root,
      right_dir: folderData().right_root,
      sub_rel: subRel,
      options: {
        mode: compareMode() === "hash" ? "content_hash" : "fast_metadata",
        ignore_case_names: false,
        exclude_globs: effectiveExcludeGlobs(),
        recursive,
      },
    });

  const refreshSubfolder = async (
    subRel: string,
    recursive = false,
    silent = false
  ) => {
    if (!silent) {
      notify(t("folder_diff.scanning_subdir", { path: subRel }));
    }
    setScannedDirs((prev) => new Set(prev).add(subRel));
    try {
      const res = await fetchSubfolder(subRel, recursive);
      if (res) {
        setFolderData((prev) => {
          const updated = mergeSubtreeEntries(prev.entries, res);
          return {
            ...prev,
            entries: updated,
            stats: recomputeFolderStats(updated),
          };
        });

        // Expand the subfolder
        setCollapsedDirs((prev) => {
          const next = new Set(prev);
          next.delete(res.relative_path);
          // When scanning immediate children, collapse deeper nested subfolders by default
          for (const item of res.entries) {
            if (item.is_dir) {
              next.add(item.relative_path);
            }
          }
          return next;
        });

        if (!silent) {
          notify(
            t("folder_diff.scan_subdir_done", {
              path: res.relative_path,
              count: res.entries.length,
            })
          );
        }
      } else {
        setScannedDirs((prev) => {
          const next = new Set(prev);
          next.delete(subRel);
          return next;
        });
        if (!silent) notify(t("folder_diff.err_scan"));
      }
    } catch (err) {
      setScannedDirs((prev) => {
        const next = new Set(prev);
        next.delete(subRel);
        return next;
      });
      if (!silent) notify(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCompareSubfolder = (subRel: string, recursive = false) =>
    refreshSubfolder(subRel, recursive, false);

  const applySyncFolderResult = async (
    remoteRes: FolderDiffResult,
    affectedRelPaths: string | string[],
    dirActionPaths: string[] = []
  ) => {
    const prevScrollTop = treeBodyRef?.scrollTop ?? 0;
    const relList = Array.isArray(affectedRelPaths) ? affectedRelPaths : [affectedRelPaths];

    if (isRecursiveScan()) {
      setFolderData(remoteRes);
    } else {
      const dirsToRefresh = new Set<string>();
      for (const rel of relList) {
        const slashIdx = rel.lastIndexOf("/");
        const parentDir = slashIdx > 0 ? rel.slice(0, slashIdx) : "";
        if (parentDir && scannedDirs().has(parentDir) && !collapsedDirs().has(parentDir)) {
          dirsToRefresh.add(parentDir);
        }
      }
      for (const d of dirActionPaths) {
        if (scannedDirs().has(d) && !collapsedDirs().has(d)) {
          dirsToRefresh.add(d);
        }
      }

      const orderedDirs = Array.from(dirsToRefresh).sort(
        (a, b) => a.split("/").length - b.split("/").length
      );
      const refreshedSubtrees = (
        await Promise.all(orderedDirs.map((d) => fetchSubfolder(d, false).catch(() => null)))
      ).filter((s): s is FolderSubtreeResult => Boolean(s));

      let nextEntries: FolderEntryDto[] = [];
      const invalidatedSet = new Set(dirActionPaths);
      setFolderData((prev) => {
        let merged = mergeTopLevelPreservingSubtrees(
          prev.entries,
          remoteRes.entries,
          invalidatedSet
        );
        for (const sub of refreshedSubtrees) {
          merged = mergeSubtreeEntries(merged, sub);
        }
        nextEntries = merged;
        return {
          ...remoteRes,
          entries: merged,
          stats: recomputeFolderStats(merged),
        };
      });

      const validDirs = new Set(
        nextEntries.filter((e) => e.is_dir).map((e) => e.relative_path)
      );
      setScannedDirs((prev) => {
        const next = new Set<string>();
        for (const d of prev) {
          if (validDirs.has(d)) next.add(d);
        }
        return next;
      });
      setCollapsedDirs((prev) => {
        const next = new Set<string>();
        for (const d of prev) {
          if (validDirs.has(d)) next.add(d);
        }
        // Collapse newly discovered top-level or subtree directories that were never expanded
        for (const d of validDirs) {
          if (!prev.has(d) && !scannedDirs().has(d)) {
            next.add(d);
          }
        }
        return next;
      });
    }

    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (treeBodyRef) treeBodyRef.scrollTop = prevScrollTop;
      });
    }
  };

  const buildSiblingDiffFiles = (): SiblingDiffFileItem[] => {
    const lRoot = folderData().left_root;
    const rRoot = folderData().right_root;
    return visibleEntries()
      .filter((e) => !e.is_dir)
      .map((e) => ({
        relativePath: e.relative_path,
        leftFullPath:
          e.status === "right_only" ? "" : joinComparePath(lRoot, e.relative_path),
        rightFullPath:
          e.status === "left_only" ? "" : joinComparePath(rRoot, e.relative_path),
        status: e.status,
      }));
  };

  const openEntry = (entry: FolderEntryDto) => {
    if (!entry.is_dir) {
      const lRoot = folderData().left_root;
      const rRoot = folderData().right_root;
      const leftFullPath =
        entry.status === "right_only" ? "" : joinComparePath(lRoot, entry.relative_path);
      const rightFullPath =
        entry.status === "left_only" ? "" : joinComparePath(rRoot, entry.relative_path);
      props.onOpenFileDiff(
        leftFullPath,
        rightFullPath,
        entry.relative_path,
        buildSiblingDiffFiles()
      );
    } else {
      toggleDir(entry.relative_path);
    }
  };

  const isCellSelected = (side: "left" | "right", relPath: string) =>
    selectedItems().some((item) => item.side === side && item.relPath === relPath);

  const selectedFilePair = (): [SelectedCellItem, SelectedCellItem] | null => {
    const items = selectedItems();
    if (items.length !== 2) return null;
    return [items[0], items[1]];
  };

  const compareSelectedFiles = () => {
    const pair = selectedFilePair();
    if (!pair) {
      notify(t("folder_diff.no_file_selected"));
      return;
    }
    comparePairPaths(pair[0].side, pair[0].relPath, pair[1].side, pair[1].relPath);
  };

  const comparePairPaths = (
    leftSide: "left" | "right",
    leftRel: string,
    rightSide: "left" | "right",
    rightRel: string
  ) => {
    const lRoot = leftSide === "left" ? folderData().left_root : folderData().right_root;
    const rRoot = rightSide === "left" ? folderData().left_root : folderData().right_root;
    const leftFullPath = joinComparePath(lRoot, leftRel);
    const rightFullPath = joinComparePath(rRoot, rightRel);
    const lName = leftRel.split("/").pop() ?? leftRel;
    const rName = rightRel.split("/").pop() ?? rightRel;
    const displayTitle = lName === rName ? lName : `${lName} ↔ ${rName}`;
    props.onOpenFileDiff(
      leftFullPath,
      rightFullPath,
      displayTitle,
      buildSiblingDiffFiles()
    );
  };

  const selectRow = (entry: FolderEntryDto) => {
    setSelectedRelPath(entry.relative_path);
    if (entry.is_dir) {
      setSelectedItems([]);
      return;
    }
    const side = activeSide();
    if (side === "left" && entry.status !== "right_only") {
      setSelectedItems([{ side: "left", relPath: entry.relative_path }]);
    } else if (side === "right" && entry.status !== "left_only") {
      setSelectedItems([{ side: "right", relPath: entry.relative_path }]);
    } else if (entry.status !== "right_only") {
      setActiveSide("left");
      setSelectedItems([{ side: "left", relPath: entry.relative_path }]);
    } else {
      setActiveSide("right");
      setSelectedItems([{ side: "right", relPath: entry.relative_path }]);
    }
  };

  const selectCell = (side: "left" | "right", entry: FolderEntryDto, e?: MouseEvent) => {
    const missingOnSide =
      side === "left" ? entry.status === "right_only" : entry.status === "left_only";
    const pending = pendingCompareSource();
    if (pending && !entry.is_dir && !missingOnSide) {
      setPendingCompareSource(null);
      comparePairPaths(pending.side, pending.relPath, side, entry.relative_path);
      return;
    }
    setSelectedRelPath(entry.relative_path);
    setActiveSide(side);
    if (entry.is_dir || missingOnSide) {
      if (!(e?.ctrlKey || e?.metaKey)) {
        setSelectedItems([]);
      }
      return;
    }
    const target: SelectedCellItem = { side, relPath: entry.relative_path };
    if (e?.ctrlKey || e?.metaKey) {
      setSelectedItems((prev) => {
        const exists = prev.some(
          (item) => item.side === side && item.relPath === entry.relative_path
        );
        return exists
          ? prev.filter(
              (item) => !(item.side === side && item.relPath === entry.relative_path)
            )
          : [...prev, target];
      });
    } else {
      setSelectedItems([target]);
    }
  };

  const selectLeftCell = (entry: FolderEntryDto, e?: MouseEvent) =>
    selectCell("left", entry, e);

  const selectRightCell = (entry: FolderEntryDto, e?: MouseEvent) =>
    selectCell("right", entry, e);

  const clearCrossSelection = () => {
    setPendingCompareSource(null);
    setSelectedItems([]);
  };

  const handleLeftDblClick = (entry: FolderEntryDto) => {
    if (entry.is_dir) {
      toggleDir(entry.relative_path);
      return;
    }
    if (entry.status === "right_only") return;
    openEntry(entry);
  };

  const handleRightDblClick = (entry: FolderEntryDto) => {
    if (entry.is_dir) {
      toggleDir(entry.relative_path);
      return;
    }
    if (entry.status === "left_only") return;
    openEntry(entry);
  };

  const handleFolderKeyDown = (e: KeyboardEvent) => {
    if (props.isActive === false || e.defaultPrevented) return;
    const activeEl = document.activeElement;
    const isInputFocused =
      activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement;

    if (e.key === "Escape") {
      if (pendingCompareSource()) {
        e.preventDefault();
        e.stopPropagation();
        setPendingCompareSource(null);
        return;
      }
      if (contextMenu()) {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu(null);
        return;
      }
      if (browserSide()) {
        e.preventDefault();
        e.stopPropagation();
        setBrowserSide(null);
        return;
      }
      if (document.querySelector(".modal-backdrop")) {
        return;
      }
      if (isInputFocused) {
        e.preventDefault();
        e.stopPropagation();
        (activeEl as HTMLElement).blur();
        return;
      }
      if (e.shiftKey) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      props.onCloseOrExit?.();
      return;
    }

    if (isInputFocused || browserSide() || document.querySelector(".modal-backdrop")) {
      return;
    }

    if (e.key === "q" || (e.ctrlKey && e.key.toLowerCase() === "w")) {
      e.preventDefault();
      props.onCloseOrExit?.();
      return;
    }

    const list = visibleEntries();
    if (list.length === 0) return;
    const curIdx = list.findIndex((item) => item.relative_path === selectedRelPath());

    if (e.key === "ArrowDown" || e.key === "j" || (e.altKey && e.key === "ArrowDown")) {
      e.preventDefault();
      if (e.altKey) {
        // Jump to next modified/diff file
        for (let step = 1; step <= list.length; step++) {
          const cand = list[(Math.max(0, curIdx) + step) % list.length];
          if (!cand.is_dir && cand.status !== "equal") {
            selectRow(cand);
            return;
          }
        }
      }
      const nextIdx = Math.min(list.length - 1, curIdx + 1);
      selectRow(list[nextIdx]);
    } else if (e.key === "ArrowUp" || e.key === "k" || (e.altKey && e.key === "ArrowUp")) {
      e.preventDefault();
      if (e.altKey) {
        for (let step = 1; step <= list.length; step++) {
          const cand = list[(Math.max(0, curIdx) - step + list.length) % list.length];
          if (!cand.is_dir && cand.status !== "equal") {
            selectRow(cand);
            return;
          }
        }
      }
      const prevIdx = Math.max(0, curIdx - 1);
      selectRow(list[prevIdx]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (selectedFilePair()) {
        compareSelectedFiles();
        return;
      }
      if (curIdx >= 0) {
        openEntry(list[curIdx]);
      }
    } else if (e.key.toLowerCase() === "d" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setFilterStatus((prev) => (prev === "diffs" ? "all" : "diffs"));
    }
  };

  const updateFilterAndPersist = (next: FilterStatus) => {
    setFilterStatus(next);
    callRustRpc("update_user_preferences", { folder_filter_status: next }).catch(() => {});
  };

  const dismissMenu = () => setContextMenu(null);

  const applyFolderPreferences = (prefs: UserPreferencesDto, allowRescan: boolean) => {
    const prevGlobsKey = effectiveExcludeGlobs().join("\0");
    const prevMode = compareMode();

    if (prefs.folder_compare_mode === "hash" || prefs.folder_compare_mode === "fast") {
      setCompareMode(prefs.folder_compare_mode);
    }
    if (
      !allowRescan &&
      (prefs.folder_filter_status === "all" ||
        prefs.folder_filter_status === "diffs" ||
        prefs.folder_filter_status === "orphans" ||
        prefs.folder_filter_status === "equals")
    ) {
      setFilterStatus(prefs.folder_filter_status);
    }
    setPrefsExcludeGlobs(prefs.folder_exclude_globs ?? []);
    setRecentFolders(prefs.recent_folder_paths ?? []);

    if (allowRescan && leftInput().trim() && rightInput().trim()) {
      const nextGlobsKey = mergeFolderExcludeGlobs(
        prefs.folder_exclude_globs ?? [],
        props.filters
      ).join("\0");
      if (nextGlobsKey !== prevGlobsKey || compareMode() !== prevMode) {
        scanRealFolders(leftInput(), rightInput(), isRecursiveScan());
      }
    }
  };

  let folderMountedOnce = false;
  createEffect(() => {
    const prefs = props.userPrefs;
    if (!prefs) return;
    untrack(() => applyFolderPreferences(prefs, folderMountedOnce));
  });

  onMount(async () => {
    document.addEventListener("keydown", handleFolderKeyDown);
    window.addEventListener("click", dismissMenu);
    const prefs = props.userPrefs ?? (await callRustRpc<UserPreferencesDto>("get_user_preferences"));
    if (prefs) {
      applyFolderPreferences(prefs, false);
    }
    folderMountedOnce = true;
    if (props.initialLeftDir && props.initialRightDir) {
      scanRealFolders(props.initialLeftDir, props.initialRightDir);
    }
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleFolderKeyDown);
    window.removeEventListener("click", dismissMenu);
  });

  const toggleDir = async (relPath: string) => {
    const isCurrentlyCollapsed = collapsedDirs().has(relPath);
    if (isCurrentlyCollapsed) {
      // If expanding, check if its children are already loaded
      const prefix = relPath + "/";
      const hasChildren = folderData().entries.some((e) =>
        e.relative_path.startsWith(prefix)
      );
      if (!hasChildren && !scannedDirs().has(relPath)) {
        await handleCompareSubfolder(relPath, isRecursiveScan());
        return;
      }
    }
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  const expandAll = async () => {
    notify(t("folder_diff.expanding_all"));
    // If not in recursive full scan mode yet, trigger recursive scan to fetch all nested items
    if (!isRecursiveScan()) {
      setIsRecursiveScan(true);
      await scanRealFolders(leftInput(), rightInput(), true);
    }
    setCollapsedDirs(new Set<string>());
    notify(t("folder_diff.expanded_all"));
  };

  const collapseAll = () => {
    const dirs = folderData()
      .entries.filter((e) => e.is_dir)
      .map((e) => e.relative_path);
    setCollapsedDirs(new Set(dirs));
    notify(t("folder_diff.collapsed_all"));
  };

  const handleSwapFolders = () => {
    const l = leftInput();
    const r = rightInput();
    setLeftInput(r);
    setRightInput(l);
    if (l && r) {
      scanRealFolders(r, l);
    }
  };

  const visibleEntries = createMemo(() => {
    const collapsed = collapsedDirs();
    const filter = filterStatus();
    const q = searchQuery().trim().toLowerCase();

    return folderData().entries.filter((entry) => {
      for (const dirPath of collapsed) {
        if (
          entry.relative_path !== dirPath &&
          entry.relative_path.startsWith(dirPath + "/")
        ) {
          return false;
        }
      }

      if (q && !entry.relative_path.toLowerCase().includes(q)) {
        return false;
      }

      if (entry.is_dir) return true;

      if (filter === "diffs") {
        return entry.status !== "equal";
      }
      if (filter === "orphans") {
        return entry.status === "left_only" || entry.status === "right_only";
      }
      if (filter === "equals") {
        return entry.status === "equal";
      }
      return true;
    });
  });

  const handleCopyItem = async (
    direction: "left_to_right" | "right_to_left",
    targetPathOrList?: string | string[]
  ) => {
    const rawList = Array.isArray(targetPathOrList)
      ? targetPathOrList
      : [targetPathOrList ?? selectedRelPath() ?? ""];
    const relList = rawList.filter(Boolean);
    if (relList.length === 0) return;

    const entryMap = new Map(
      folderData().entries.map((e) => [e.relative_path, e])
    );
    const dirActionPaths = relList.filter((rel) => entryMap.get(rel)?.is_dir);
    const action =
      direction === "left_to_right" ? "copy_left_to_right" : "copy_right_to_left";

    let lastRemoteRes: FolderDiffResult | null = null;
    try {
      for (const rel of relList) {
        const remoteRes = await callRustRpc<FolderDiffResult>("sync_folder_item", {
          left_dir: folderData().left_root,
          right_dir: folderData().right_root,
          relative_path: rel,
          action,
          options: {
            mode: compareMode() === "hash" ? "content_hash" : "fast_metadata",
            ignore_case_names: false,
            exclude_globs: effectiveExcludeGlobs(),
            recursive: isRecursiveScan(),
          },
        });
        if (remoteRes) {
          lastRemoteRes = remoteRes;
        }
      }

      if (lastRemoteRes) {
        await applySyncFolderResult(lastRemoteRes, relList, dirActionPaths);
        if (relList.length === 1) {
          notify(
            direction === "left_to_right"
              ? t("folder_diff.copied_to_right_done", { path: relList[0] })
              : t("folder_diff.copied_to_left_done", { path: relList[0] })
          );
        } else {
          notify(
            direction === "left_to_right"
              ? t("folder_diff.batch_copied_to_right_done", { count: relList.length })
              : t("folder_diff.batch_copied_to_left_done", { count: relList.length })
          );
        }
        return;
      }
    } catch (err) {
      notify(
        t("folder_diff.sync_failed", {
          err: err instanceof Error ? err.message : String(err),
        })
      );
      return;
    }

    const relSet = new Set(relList);
    setFolderData((prev) => {
      const updated = prev.entries.map((item) => {
        if (!relSet.has(item.relative_path)) return item;
        const now = Date.now();
        if (direction === "left_to_right" && item.left_size !== null) {
          return {
            ...item,
            status: "equal" as FolderItemStatus,
            right_size: item.left_size,
            right_modified_ms: now,
          };
        }
        if (direction === "right_to_left" && item.right_size !== null) {
          return {
            ...item,
            status: "equal" as FolderItemStatus,
            left_size: item.right_size,
            left_modified_ms: now,
          };
        }
        return item;
      });
      return {
        ...prev,
        entries: updated,
        stats: recomputeFolderStats(updated),
      };
    });
  };

  const handleDeleteItem = async (
    side: "left" | "right",
    entryOrList: FolderEntryDto | FolderEntryDto[]
  ) => {
    const rawList = Array.isArray(entryOrList) ? entryOrList : [entryOrList];
    const targets = rawList.filter((entry) => {
      if (side === "left" && entry.status === "right_only") return false;
      if (side === "right" && entry.status === "left_only") return false;
      return true;
    });
    if (targets.length === 0) return;

    const confirmMsg =
      targets.length === 1
        ? side === "left"
          ? t("folder_diff.delete_left_confirm", { path: targets[0].relative_path })
          : t("folder_diff.delete_right_confirm", { path: targets[0].relative_path })
        : t("folder_diff.batch_delete_confirm", { count: targets.length });
    if (!window.confirm(confirmMsg)) return;

    const action = side === "left" ? "delete_left" : "delete_right";
    let lastRemoteRes: FolderDiffResult | null = null;
    try {
      for (const entry of targets) {
        const remoteRes = await callRustRpc<FolderDiffResult>("sync_folder_item", {
          left_dir: folderData().left_root,
          right_dir: folderData().right_root,
          relative_path: entry.relative_path,
          action,
          options: {
            mode: compareMode() === "hash" ? "content_hash" : "fast_metadata",
            ignore_case_names: false,
            exclude_globs: effectiveExcludeGlobs(),
            recursive: isRecursiveScan(),
          },
        });
        if (remoteRes) {
          lastRemoteRes = remoteRes;
        }
      }
      if (lastRemoteRes) {
        await applySyncFolderResult(
          lastRemoteRes,
          targets.map((e) => e.relative_path),
          targets.filter((e) => e.is_dir).map((e) => e.relative_path)
        );
        const stillExists = new Set(folderData().entries.map((e) => e.relative_path));
        if (selectedRelPath() && !stillExists.has(selectedRelPath()!)) {
          setSelectedRelPath(null);
        }
        setSelectedItems((prev) => prev.filter((item) => stillExists.has(item.relPath)));
        if (targets.length === 1) {
          notify(
            side === "left"
              ? t("folder_diff.deleted_left_done", { path: targets[0].relative_path })
              : t("folder_diff.deleted_right_done", { path: targets[0].relative_path })
          );
        } else {
          notify(t("folder_diff.batch_deleted_done", { count: targets.length }));
        }
      }
    } catch (err) {
      notify(
        t("folder_diff.sync_failed", {
          err: err instanceof Error ? err.message : String(err),
        })
      );
    }
  };

  return (
    <div class="view-container">
      {/* Folder Toolbar */}
      <div class="bc-toolbar">
        <div class="bc-toolbar-group">
          <button
            class={`bc-tool-btn ${filterStatus() === "all" ? "active" : ""}`}
            onClick={() => updateFilterAndPersist("all")}
          >
            {t("folder_diff.filter_all")}
          </button>
          <button
            class={`bc-tool-btn ${filterStatus() === "diffs" ? "active" : ""}`}
            onClick={() => updateFilterAndPersist("diffs")}
          >
            {t("folder_diff.filter_diffs")}
          </button>
          <button
            class={`bc-tool-btn ${filterStatus() === "orphans" ? "active" : ""}`}
            onClick={() => updateFilterAndPersist("orphans")}
          >
            {t("folder_diff.filter_orphans")}
          </button>
          <button
            class={`bc-tool-btn ${filterStatus() === "equals" ? "active" : ""}`}
            onClick={() => updateFilterAndPersist("equals")}
          >
            {t("folder_diff.filter_equals")}
          </button>
        </div>

        <div class="bc-toolbar-divider" />

        <div class="bc-toolbar-group">
          <button
            class="bc-tool-btn"
            onClick={() => scanRealFolders(leftInput(), rightInput(), isRecursiveScan())}
            title={t("folder_diff.scan_btn")}
          >
            🔄 {t("folder_diff.scan_btn")}
          </button>
          <button
            class={`bc-tool-btn ${!isRecursiveScan() ? "active" : ""}`}
            onClick={() => {
              setIsRecursiveScan(false);
              scanRealFolders(leftInput(), rightInput(), false);
            }}
            title={t("folder_diff.shallow_scan_tip")}
          >
            {t("folder_diff.shallow_scan")}
          </button>
          <button
            class={`bc-tool-btn ${isRecursiveScan() ? "active" : ""}`}
            onClick={() => {
              setIsRecursiveScan(true);
              scanRealFolders(leftInput(), rightInput(), true);
            }}
            title={t("folder_diff.recursive_scan_tip")}
          >
            {t("folder_diff.recursive_scan")}
          </button>
          <button class="bc-tool-btn" onClick={expandAll} title={t("folder_diff.expand_all_tip")}>
            {t("folder_diff.expand_all")}
          </button>
          <button class="bc-tool-btn" onClick={collapseAll} title={t("folder_diff.collapse_all_tip")}>
            {t("folder_diff.collapse_all")}
          </button>
          <button
            class={`bc-tool-btn ${compareMode() === "hash" ? "active" : ""}`}
            title={(isSftpUri(leftInput()) || isSftpUri(rightInput())) && compareMode() === "hash" ? t("folder_diff.sftp_fast_hint") : undefined}
            onClick={() => {
              const next = compareMode() === "hash" ? "fast" : "hash";
              setCompareMode(next);
              callRustRpc("update_user_preferences", {
                folder_compare_mode: next,
              }).catch(() => {});
              if (leftInput() && rightInput()) {
                scanRealFolders(leftInput(), rightInput());
              }
            }}
          >
            {t("folder_diff.mode_label", {
              mode: compareMode() === "hash" ? t("folder_diff.mode_hash") : t("folder_diff.mode_fast"),
            })}
          </button>
        </div>

        <div class="bc-toolbar-divider" />

        <div class="bc-toolbar-group">
          <button
            class={`bc-tool-btn ${selectedFilePair() ? "active" : ""}`}
            disabled={!selectedFilePair()}
            onClick={() => compareSelectedFiles()}
            title={t("folder_diff.compare_selected_tip")}
          >
            ⇄ {t("folder_diff.compare_selected")}
          </button>
        </div>

        <div class="bc-toolbar-divider" />

        <input
          class="folder-filter-input"
          placeholder={t("folder_diff.filter_placeholder")}
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
        />
      </div>

      {/* Folder Root Paths */}
      <div class="dual-path-bar">
        <div class="path-input-box">
          <span class="side-badge left">LEFT DIR</span>
          <Show when={isSftpUri(leftInput())}>
            <span class="meta-tag sftp-tag">{t("folder_diff.sftp_badge")}</span>
          </Show>
          <input
            class="path-text-input"
            list="mru-folder-paths"
            placeholder={t("folder_diff.path_left_placeholder")}
            value={leftInput()}
            onInput={(e) => setLeftInput(e.currentTarget.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && scanRealFolders(leftInput(), rightInput())
            }
            onBlur={() => {
              const l = leftInput().trim();
              const r = rightInput().trim();
              if (l && r && (l !== lastScannedLeft || r !== lastScannedRight)) {
                scanRealFolders(l, r);
              }
            }}
          />
          <button
            class="browse-btn"
            title={t("common.browse")}
            onClick={() => setBrowserSide("left")}
          >
            📂
          </button>
        </div>
        <div class="path-input-box">
          <span class="side-badge right">RIGHT DIR</span>
          <Show when={isSftpUri(rightInput())}>
            <span class="meta-tag sftp-tag">{t("folder_diff.sftp_badge")}</span>
          </Show>
          <input
            class="path-text-input"
            list="mru-folder-paths"
            placeholder={t("folder_diff.path_right_placeholder")}
            value={rightInput()}
            onInput={(e) => setRightInput(e.currentTarget.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && scanRealFolders(leftInput(), rightInput())
            }
            onBlur={() => {
              const l = leftInput().trim();
              const r = rightInput().trim();
              if (l && r && (l !== lastScannedLeft || r !== lastScannedRight)) {
                scanRealFolders(l, r);
              }
            }}
          />
          <datalist id="mru-folder-paths">
            <For each={recentFolders()}>{(p) => <option value={p} />}</For>
          </datalist>
          <button
            class="browse-btn"
            title={t("common.browse")}
            onClick={() => setBrowserSide("right")}
          >
            📂
          </button>
        </div>
      </div>

      {/* Side-by-Side Synchronized Folder TreeGrid */}
      <div class="folder-tree-container">
        <div class="folder-tree-header">
          <div class="folder-col-left">
            <span class="col-name">{t("folder_diff.col_name")}</span>
            <span class="col-size">{t("folder_diff.col_left_size")}</span>
            <span class="col-time">{t("folder_diff.col_modified")}</span>
          </div>
          <div class="folder-col-center" onClick={(e) => e.stopPropagation()}>{t("folder_diff.col_status")}</div>
          <div class="folder-col-right">
            <span class="col-name">{t("folder_diff.col_name")}</span>
            <span class="col-size">{t("folder_diff.col_right_size")}</span>
            <span class="col-time">{t("folder_diff.col_modified")}</span>
          </div>
        </div>

        <div class="folder-tree-body" ref={treeBodyRef} style={{ position: "relative" }}>
          <Show when={(folderData()?.entries?.length ?? 0) === 0}>
            <div class="empty-paste-overlay">
              <div class="paste-hint-card">
                <strong>{t("folder_diff.empty_title")}</strong>
                <span>
                  {t("folder_diff.empty_desc")}
                </span>
              </div>
            </div>
          </Show>

          <For each={visibleEntries()}>
            {(entry) => {
              return (
                <FolderRow
                  entry={entry}
                  isSelected={entry.is_dir && selectedRelPath() === entry.relative_path}
                  isLeftSelected={isCellSelected("left", entry.relative_path)}
                  isRightSelected={isCellSelected("right", entry.relative_path)}
                  isCollapsed={collapsedDirs().has(entry.relative_path)}
                  onSelectRow={() => selectRow(entry)}
                  onSelectLeft={(e) => selectLeftCell(entry, e)}
                  onSelectRight={(e) => selectRightCell(entry, e)}
                  onLeftDblClick={() => handleLeftDblClick(entry)}
                  onRightDblClick={() => handleRightDblClick(entry)}
                  onToggleDir={() => toggleDir(entry.relative_path)}
                  onOpenDiff={() => openEntry(entry)}
                  onOpenFolderDiff={
                    entry.is_dir && props.onOpenFolderDiff
                      ? () => {
                          props.onOpenFolderDiff?.(
                            joinComparePath(folderData().left_root, entry.relative_path),
                            joinComparePath(folderData().right_root, entry.relative_path),
                            entry.relative_path
                          );
                        }
                      : undefined
                  }
                  onContextMenu={(e, side) => {
                    e.preventDefault();
                    if (side === "left") {
                      if (!isCellSelected("left", entry.relative_path)) {
                        selectLeftCell(entry);
                      }
                    } else if (side === "right") {
                      if (!isCellSelected("right", entry.relative_path)) {
                        selectRightCell(entry);
                      }
                    } else {
                      selectRow(entry);
                    }
                    const x = Math.min(e.clientX, window.innerWidth - 240);
                    const y = Math.min(e.clientY, window.innerHeight - 300);
                    setContextMenu({ x, y, entry, side });
                  }}
                  onCopyRight={() => handleCopyItem("left_to_right", entry.relative_path)}
                  onCopyLeft={() => handleCopyItem("right_to_left", entry.relative_path)}
                />
              );
            }}
          </For>
        </div>
      </div>

      <Show when={contextMenu()}>
        {(menu) => (
          <div
            class="folder-context-menu"
            style={{
              position: "fixed",
              top: `${menu().y}px`,
              left: `${menu().x}px`,
              "z-index": 9999,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <Show when={menu().entry.is_dir}>
              <div
                class="ctx-item highlight"
                onClick={() => {
                  const rel = menu().entry.relative_path;
                  setContextMenu(null);
                  handleCompareSubfolder(rel, true);
                }}
              >
                <span>🔍 {t("folder_diff.subfolder_nested_compare")}</span>
              </div>
              <Show when={props.onOpenFolderDiff}>
                <div
                  class="ctx-item"
                  onClick={() => {
                    const rel = menu().entry.relative_path;
                    setContextMenu(null);
                    props.onOpenFolderDiff?.(
                      joinComparePath(folderData().left_root, rel),
                      joinComparePath(folderData().right_root, rel),
                      rel
                    );
                  }}
                >
                  <span>📂 {t("folder_diff.open_in_new_tab")}</span>
                </div>
              </Show>
              <div class="ctx-divider" />
              <div
                class="ctx-item"
                onClick={() => {
                  const rel = menu().entry.relative_path;
                  setContextMenu(null);
                  toggleDir(rel);
                }}
              >
                <span>
                  {collapsedDirs().has(menu().entry.relative_path)
                    ? t("folder_diff.expand_dir")
                    : t("folder_diff.collapse_dir")}
                </span>
              </div>
            </Show>
            <Show when={!menu().entry.is_dir}>
              <Show
                when={
                  (menu().side === "left" && menu().entry.status !== "right_only") ||
                  (menu().side === "right" && menu().entry.status !== "left_only")
                }
              >
                <div
                  class="ctx-item"
                  onClick={() => {
                    const m = menu();
                    setContextMenu(null);
                    setPendingCompareSource({
                      side: m.side === "right" ? "right" : "left",
                      relPath: m.entry.relative_path,
                    });
                    notify(
                      t("folder_diff.compare_to_hint", {
                        name: m.entry.relative_path.split("/").pop() ?? m.entry.relative_path,
                      })
                    );
                  }}
                >
                  <span>{t("folder_diff.compare_to_another")}</span>
                </div>
              </Show>

              {/* Quick Compare option whenever exactly 2 files are selected (same-side or cross-side) */}
              <Show when={selectedFilePair()}>
                {(pair) => (
                  <div
                    class="ctx-item highlight"
                    onClick={() => {
                      setContextMenu(null);
                      compareSelectedFiles();
                    }}
                  >
                    <span>{t("folder_diff.compare_both_selected", {
                      left: pair()[0].relPath.split("/").pop() ?? pair()[0].relPath,
                      right: pair()[1].relPath.split("/").pop() ?? pair()[1].relPath,
                    })}</span>
                  </div>
                )}
              </Show>

              <div class="ctx-divider" />
              <div
                class="ctx-item"
                onClick={() => {
                  const item = menu().entry;
                  setContextMenu(null);
                  openEntry(item);
                }}
              >
                <span>⇄ {t("folder_diff.open_text_diff")}</span>
              </div>
              <div class="ctx-divider" />
            </Show>
            {(() => {
              const hasLeftSel = selectedItems().some((i) => i.side === "left");
              const hasRightSel = selectedItems().some((i) => i.side === "right");
              const bothSidesSelected = hasLeftSel && hasRightSel;
              const entry = menu().entry;
              const side = menu().side;
              const targetSide: "left" | "right" | null =
                side === "left" && entry.status !== "right_only"
                  ? "left"
                  : side === "right" && entry.status !== "left_only"
                  ? "right"
                  : entry.status === "left_only"
                  ? "left"
                  : entry.status === "right_only"
                  ? "right"
                  : null;
              return (
                <>
                  <Show when={!bothSidesSelected && hasLeftSel && entry.status !== "right_only"}>
                    <div
                      class="ctx-item"
                      onClick={() => {
                        const rel = entry.relative_path;
                        const entryMap = new Map(
                          folderData().entries.map((e) => [e.relative_path, e])
                        );
                        const eligible = selectedItems()
                          .filter(
                            (i) =>
                              i.side === "left" &&
                              entryMap.get(i.relPath)?.status !== "right_only"
                          )
                          .map((i) => i.relPath);
                        const targets = resolveBatchTargetPaths(rel, eligible);
                        setContextMenu(null);
                        handleCopyItem("left_to_right", targets);
                      }}
                    >
                      <span>{t("folder_diff.copy_to_right_item")}</span>
                    </div>
                  </Show>
                  <Show when={!bothSidesSelected && hasRightSel && entry.status !== "left_only"}>
                    <div
                      class="ctx-item"
                      onClick={() => {
                        const rel = entry.relative_path;
                        const entryMap = new Map(
                          folderData().entries.map((e) => [e.relative_path, e])
                        );
                        const eligible = selectedItems()
                          .filter(
                            (i) =>
                              i.side === "right" &&
                              entryMap.get(i.relPath)?.status !== "left_only"
                          )
                          .map((i) => i.relPath);
                        const targets = resolveBatchTargetPaths(rel, eligible);
                        setContextMenu(null);
                        handleCopyItem("right_to_left", targets);
                      }}
                    >
                      <span>{t("folder_diff.copy_to_left_item")}</span>
                    </div>
                  </Show>
                  <Show when={targetSide !== null}>
                    <div
                      class="ctx-item"
                      onClick={() => {
                        const side = targetSide!;
                        const entryMap = new Map(
                          folderData().entries.map((e) => [e.relative_path, e])
                        );
                        const eligible = selectedItems()
                          .filter((i) => i.side === side)
                          .map((i) => i.relPath);
                        const targetPaths = resolveBatchTargetPaths(
                          entry.relative_path,
                          eligible
                        );
                        const targetEntries = targetPaths
                          .map((p) => entryMap.get(p))
                          .filter((e): e is FolderEntryDto => Boolean(e));
                        setContextMenu(null);
                        handleDeleteItem(
                          side,
                          targetEntries.length > 0 ? targetEntries : [entry]
                        );
                      }}
                    >
                      <span>{t("folder_diff.delete_selected_item")}</span>
                    </div>
                  </Show>
                </>
              );
            })()}
            <div class="ctx-divider" />
            <div
              class="ctx-item"
              onClick={() => {
                const rel = menu().entry.relative_path;
                setContextMenu(null);
                navigator.clipboard.writeText(rel);
                notify(t("folder_diff.copied_rel_path", { path: rel }));
              }}
            >
              <span>{t("folder_diff.copy_rel_path_item")}</span>
            </div>
            <div class="ctx-divider" />
            <div
              class="ctx-item"
              onClick={() => {
                setContextMenu(null);
                handleSwapFolders();
              }}
            >
              <span>{t("folder_diff.ctx_swap_dirs")}</span>
            </div>
            <div
              class="ctx-item"
              onClick={() => {
                setContextMenu(null);
                scanRealFolders(leftInput(), rightInput(), isRecursiveScan());
              }}
            >
              <span>{t("folder_diff.ctx_rescan")}</span>
            </div>
          </div>
        )}
      </Show>

      {/* Bottom Status Bar for Folder Diff */}
      <footer class="app-statusbar">
        <div class="statusbar-left">
          <span class="statusbar-item">
            {folderData().entries.length} 项
          </span>
        </div>
        <div class="statusbar-center">
          <span class="stat-pill mod">{t("folder_diff.stat_mod", { count: folderData().stats.modified_items })}</span>
          <span class="stat-pill ins">{t("folder_diff.stat_left", { count: folderData().stats.left_only_items })}</span>
          <span class="stat-pill del">{t("folder_diff.stat_right", { count: folderData().stats.right_only_items })}</span>
          <span class="stat-pill eq">{t("folder_diff.stat_same", { count: folderData().stats.equal_items })}</span>
        </div>
        <div class="statusbar-right">
          <button
            class="statusbar-exit-btn"
            onClick={props.onCloseOrExit}
            title={t("text_diff.exit_btn_tip")}
          >
            {t("text_diff.exit_btn")}
          </button>
        </div>
      </footer>

      <Show when={browserSide()}>
        {(side) => (
          <FileBrowserModal
            mode="folder"
            title={side() === "left" ? t("folder_diff.browse_left_title") : t("folder_diff.browse_right_title")}
            initialPath={side() === "left" ? leftInput() : rightInput()}
            onClose={() => setBrowserSide(null)}
            onSelect={(selectedDir) => {
              const isLeft = side() === "left";
              setBrowserSide(null);
              if (isLeft) {
                setLeftInput(selectedDir);
                if (rightInput().trim()) {
                  scanRealFolders(selectedDir, rightInput());
                }
              } else {
                setRightInput(selectedDir);
                if (leftInput().trim()) {
                  scanRealFolders(leftInput(), selectedDir);
                }
              }
            }}
          />
        )}
      </Show>

      <Show when={toast()}>
        <div class="floating-toast">{toast()}</div>
      </Show>
    </div>
  );
};

const FolderRow: Component<{
  entry: FolderEntryDto;
  isSelected: boolean;
  isLeftSelected: boolean;
  isRightSelected: boolean;
  isCollapsed: boolean;
  onSelectRow: () => void;
  onSelectLeft: (e: MouseEvent) => void;
  onSelectRight: (e: MouseEvent) => void;
  onToggleDir: () => void;
  onOpenDiff: () => void;
  onLeftDblClick: (e: MouseEvent) => void;
  onRightDblClick: (e: MouseEvent) => void;
  onOpenFolderDiff?: () => void;
  onContextMenu: (e: MouseEvent, side: "left" | "right" | "row") => void;
  onCopyRight: () => void;
  onCopyLeft: () => void;
}> = (props) => {
  const indentPx = () => `${props.entry.depth * 20 + 10}px`;
  const hasLeft = () => props.entry.status !== "right_only";
  const hasRight = () => props.entry.status !== "left_only";

  const handleRowDblClick = (e: MouseEvent) => {
    if (props.entry.is_dir && (e.ctrlKey || e.metaKey) && props.onOpenFolderDiff) {
      props.onOpenFolderDiff();
      return;
    }
    props.onOpenDiff();
  };

  return (
    <div
      class={`folder-row folder-status-${props.entry.status} ${
        props.isSelected ? "selected" : ""
      }`}
      onClick={props.onSelectRow}
      onDblClick={handleRowDblClick}
      onContextMenu={(e) => props.onContextMenu(e, "row")}
    >
      <div
        class={`folder-col-left ${props.isLeftSelected ? "selected-cell" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          props.onSelectLeft(e);
        }}
        onDblClick={(e) => {
          e.stopPropagation();
          props.onLeftDblClick(e);
        }}
        onContextMenu={(e) => {
          e.stopPropagation();
          props.onContextMenu(e, "left");
        }}
      >
        <span class="col-name" style={{ "padding-left": indentPx() }}>
          <Show when={props.entry.is_dir}>
            <button
              class="dir-caret-btn"
              onClick={(e) => {
                e.stopPropagation();
                props.onToggleDir();
              }}
            >
              {props.isCollapsed ? "▶" : "▼"}
            </button>
          </Show>
          <span class="entry-icon">{props.entry.is_dir ? "📁" : "📄"}</span>
          <span class={hasLeft() ? "entry-label" : "entry-missing"}>
            {hasLeft() ? props.entry.name : t("folder_diff.missing_tag")}
          </span>
          <Show when={props.entry.is_dir && props.onOpenFolderDiff}>
            <button
              class="dir-open-tab-btn"
              title={t("folder_diff.open_tab_tip")}
              onClick={(e) => {
                e.stopPropagation();
                props.onOpenFolderDiff?.();
              }}
            >
              📂
            </button>
          </Show>
          <Show when={props.entry.is_dir && props.entry.status === "unknown"}>
            <span class="uncompared-badge" title={t("folder_diff.uncompared_tip")}>
              {t("folder_diff.uncompared_tag")}
            </span>
          </Show>
        </span>
        <span class="col-size">{formatBytes(props.entry.left_size)}</span>
        <span class="col-time">{formatTime(props.entry.left_modified_ms)}</span>
      </div>

      <div class="folder-col-center" onClick={(e) => e.stopPropagation()}>
        <Show when={!props.entry.is_dir && props.entry.status !== "equal" && props.entry.status !== "right_only"}>
          <button
            class="gutter-copy-btn"
            title={t("folder_diff.copy_right_tip")}
            onClick={(e) => {
              e.stopPropagation();
              props.onCopyRight();
            }}
          >
            »
          </button>
        </Show>
        <span class="status-symbol">
          {props.entry.status === "equal"
            ? "="
            : props.entry.status === "modified"
            ? "≠"
            : props.entry.status === "left_only"
            ? "←"
            : props.entry.status === "right_only"
            ? "→"
            : "~"}
        </span>
        <Show when={!props.entry.is_dir && props.entry.status !== "equal" && props.entry.status !== "left_only"}>
          <button
            class="gutter-copy-btn"
            title={t("folder_diff.copy_left_tip")}
            onClick={(e) => {
              e.stopPropagation();
              props.onCopyLeft();
            }}
          >
            «
          </button>
        </Show>
      </div>

      <div
        class={`folder-col-right ${props.isRightSelected ? "selected-cell" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          props.onSelectRight(e);
        }}
        onDblClick={(e) => {
          e.stopPropagation();
          props.onRightDblClick(e);
        }}
        onContextMenu={(e) => {
          e.stopPropagation();
          props.onContextMenu(e, "right");
        }}
      >
        <span class="col-name" style={{ "padding-left": indentPx() }}>
          <span class="entry-icon">{props.entry.is_dir ? "📁" : "📄"}</span>
          <span class={hasRight() ? "entry-label" : "entry-missing"}>
            {hasRight() ? props.entry.name : t("folder_diff.missing_tag")}
          </span>
        </span>
        <span class="col-size">{formatBytes(props.entry.right_size)}</span>
        <span class="col-time">{formatTime(props.entry.right_modified_ms)}</span>
      </div>
    </div>
  );
};

function formatBytes(size: number | null): string {
  if (size === null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  const hours = d.getHours().toString().padStart(2, "0");
  const mins = d.getMinutes().toString().padStart(2, "0");
  const secs = d.getSeconds().toString().padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
}
