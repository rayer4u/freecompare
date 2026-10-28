import { Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  callRustRpc,
  createBlankFolderDiff,
  recomputeFolderStats,
  UserPreferencesDto,
} from "../bridge";
import { FileBrowserModal } from "../components/FileBrowserModal";
import { t } from "../i18n";
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

export const FolderDiffView: Component<FolderDiffViewProps> = (props) => {
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
  const [compareMode, setCompareMode] = createSignal<"hash" | "fast">("hash");
  const [isRecursiveScan, setIsRecursiveScan] = createSignal(Boolean(props.expandAll));
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
    entry: FolderEntryDto;
  } | null>(null);
  const [browserSide, setBrowserSide] = createSignal<"left" | "right" | null>(null);
  const [recentFolders, setRecentFolders] = createSignal<string[]>([]);
  const [toast, setToast] = createSignal<string | null>(null);
  let lastReportedTitle = "";

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
          exclude_globs: [".git", "node_modules", "target", ".DS_Store"],
          recursive,
        },
      });
      if (res) {
        setFolderData(res);
        setScannedDirs(new Set<string>());
        setLeftInput(res.left_root);
        setRightInput(res.right_root);
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
          setSelectedRelPath(firstDiffFile.relative_path);
        }
        const lClean = res.left_root.replace(/[/\\]+$/, "");
        const rClean = res.right_root.replace(/[/\\]+$/, "");
        const lBase = lClean ? lClean.split(/[/\\]/).pop() || lClean : "";
        const rBase = rClean ? rClean.split(/[/\\]/).pop() || rClean : "";
        const folderTitle =
          lBase === rBase
            ? lBase
            : lBase && rBase
            ? `${lBase} ↔ ${rBase}`
            : lBase || rBase;
        if (folderTitle && folderTitle !== lastReportedTitle) {
          lastReportedTitle = folderTitle;
          props.onUpdateTabTitle?.(`📁 ${folderTitle}`);
        }
      } else {
        notify(t("folder_diff.err_scan"));
      }
    } catch {
      notify(t("folder_diff.err_scan"));
    }
  };

  const handleCompareSubfolder = async (subRel: string, recursive = false) => {
    notify(t("folder_diff.scanning_subdir", { path: subRel }));
    setScannedDirs((prev) => new Set(prev).add(subRel));
    try {
      const res = await callRustRpc<FolderSubtreeResult>("compare_subfolder", {
        left_dir: folderData().left_root,
        right_dir: folderData().right_root,
        sub_rel: subRel,
        options: {
          mode: compareMode() === "hash" ? "content_hash" : "fast_metadata",
          ignore_case_names: false,
          exclude_globs: [".git", "node_modules", "target", ".DS_Store"],
          recursive,
        },
      });
      if (res) {
        setFolderData((prev) => {
          const cleanRel = res.relative_path;
          const prefix = cleanRel + "/";
          const parentIdx = prev.entries.findIndex((e) => e.relative_path === cleanRel);
          if (parentIdx < 0) return prev;

          const updated = [...prev.entries];
          // Update parent folder status
          updated[parentIdx] = { ...updated[parentIdx], status: res.status };

          // Remove any previously cached children under this folder
          let removeCount = 0;
          for (let i = parentIdx + 1; i < updated.length; i++) {
            if (updated[i].relative_path.startsWith(prefix)) {
              removeCount++;
            } else {
              break;
            }
          }
          updated.splice(parentIdx + 1, removeCount, ...res.entries);

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

        notify(
          t("folder_diff.scan_subdir_done", {
            path: res.relative_path,
            count: res.entries.length,
          })
        );
      } else {
        notify(t("folder_diff.err_scan"));
        setCollapsedDirs((prev) => {
          const next = new Set(prev);
          next.delete(subRel);
          return next;
        });
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
      setCollapsedDirs((prev) => {
        const next = new Set(prev);
        next.delete(subRel);
        return next;
      });
    }
  };

  const buildSiblingDiffFiles = (): SiblingDiffFileItem[] => {
    const lRoot = folderData().left_root.replace(/\/$/, "");
    const rRoot = folderData().right_root.replace(/\/$/, "");
    return visibleEntries()
      .filter((e) => !e.is_dir)
      .map((e) => ({
        relativePath: e.relative_path,
        leftFullPath:
          e.status === "right_only" ? "" : `${lRoot}/${e.relative_path}`,
        rightFullPath:
          e.status === "left_only" ? "" : `${rRoot}/${e.relative_path}`,
        status: e.status,
      }));
  };

  const openEntry = (entry: FolderEntryDto) => {
    if (!entry.is_dir) {
      const lRoot = folderData().left_root.replace(/\/$/, "");
      const rRoot = folderData().right_root.replace(/\/$/, "");
      const leftFullPath =
        entry.status === "right_only" ? "" : `${lRoot}/${entry.relative_path}`;
      const rightFullPath =
        entry.status === "left_only" ? "" : `${rRoot}/${entry.relative_path}`;
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

  const handleFolderKeyDown = (e: KeyboardEvent) => {
    if (props.isActive === false) return;
    const activeEl = document.activeElement;
    if (
      activeEl instanceof HTMLInputElement ||
      activeEl instanceof HTMLTextAreaElement ||
      browserSide()
    ) {
      return;
    }

    if (e.key === "Escape" || e.key === "q" || (e.ctrlKey && e.key.toLowerCase() === "w")) {
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
            setSelectedRelPath(cand.relative_path);
            return;
          }
        }
      }
      const nextIdx = Math.min(list.length - 1, curIdx + 1);
      setSelectedRelPath(list[nextIdx].relative_path);
    } else if (e.key === "ArrowUp" || e.key === "k" || (e.altKey && e.key === "ArrowUp")) {
      e.preventDefault();
      if (e.altKey) {
        for (let step = 1; step <= list.length; step++) {
          const cand = list[(Math.max(0, curIdx) - step + list.length) % list.length];
          if (!cand.is_dir && cand.status !== "equal") {
            setSelectedRelPath(cand.relative_path);
            return;
          }
        }
      }
      const prevIdx = Math.max(0, curIdx - 1);
      setSelectedRelPath(list[prevIdx].relative_path);
    } else if (e.key === "Enter" || e.key === " ") {
      if (curIdx >= 0) {
        e.preventDefault();
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

  onMount(async () => {
    window.addEventListener("keydown", handleFolderKeyDown);
    window.addEventListener("click", dismissMenu);
    const prefs = await callRustRpc<UserPreferencesDto>("get_user_preferences");
    if (prefs) {
      if (prefs.folder_compare_mode === "hash" || prefs.folder_compare_mode === "fast") {
        setCompareMode(prefs.folder_compare_mode);
      }
      if (
        prefs.folder_filter_status === "all" ||
        prefs.folder_filter_status === "diffs" ||
        prefs.folder_filter_status === "orphans" ||
        prefs.folder_filter_status === "equals"
      ) {
        setFilterStatus(prefs.folder_filter_status);
      }
      setRecentFolders(prefs.recent_folder_paths ?? []);
    }
    if (props.initialLeftDir && props.initialRightDir) {
      scanRealFolders(props.initialLeftDir, props.initialRightDir);
    }
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleFolderKeyDown);
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
    targetPath?: string
  ) => {
    const rel = targetPath ?? selectedRelPath();
    if (!rel) return;

    const action =
      direction === "left_to_right" ? "copy_left_to_right" : "copy_right_to_left";
    const remoteRes = await callRustRpc<FolderDiffResult>("sync_folder_item", {
      left_dir: folderData().left_root,
      right_dir: folderData().right_root,
      relative_path: rel,
      action,
      options: {
        mode: compareMode() === "hash" ? "content_hash" : "fast_metadata",
        ignore_case_names: false,
        exclude_globs: [".git", "node_modules", "target", ".DS_Store"],
      },
    }).catch(() => null);

    if (remoteRes) {
      setFolderData(remoteRes);
      notify(
        direction === "left_to_right"
          ? t("folder_diff.copied_to_right_done", { path: rel })
          : t("folder_diff.copied_to_left_done", { path: rel })
      );
      return;
    }

    setFolderData((prev) => {
      const updated = prev.entries.map((item) => {
        if (item.relative_path !== rel) return item;
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
              if (leftInput().trim() && rightInput().trim()) {
                scanRealFolders(leftInput(), rightInput());
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
              if (leftInput().trim() && rightInput().trim()) {
                scanRealFolders(leftInput(), rightInput());
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
          <div class="folder-col-center">{t("folder_diff.col_status")}</div>
          <div class="folder-col-right">
            <span class="col-name">{t("folder_diff.col_name")}</span>
            <span class="col-size">{t("folder_diff.col_right_size")}</span>
            <span class="col-time">{t("folder_diff.col_modified")}</span>
          </div>
        </div>

        <div class="folder-tree-body" style={{ position: "relative" }}>
          <Show when={folderData().entries.length === 0}>
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
            {(entry) => (
              <FolderRow
                entry={entry}
                isSelected={selectedRelPath() === entry.relative_path}
                isCollapsed={collapsedDirs().has(entry.relative_path)}
                onSelect={() => setSelectedRelPath(entry.relative_path)}
                onToggleDir={() => toggleDir(entry.relative_path)}
                onOpenDiff={() => openEntry(entry)}
                onOpenFolderDiff={
                  entry.is_dir && props.onOpenFolderDiff
                    ? () => {
                        const lRoot = folderData().left_root.replace(/\/$/, "");
                        const rRoot = folderData().right_root.replace(/\/$/, "");
                        props.onOpenFolderDiff?.(
                          `${lRoot}/${entry.relative_path}`,
                          `${rRoot}/${entry.relative_path}`,
                          entry.relative_path
                        );
                      }
                    : undefined
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelectedRelPath(entry.relative_path);
                  const x = Math.min(e.clientX, window.innerWidth - 220);
                  const y = Math.min(e.clientY, window.innerHeight - 250);
                  setContextMenu({ x, y, entry });
                }}
                onCopyRight={() => handleCopyItem("left_to_right", entry.relative_path)}
                onCopyLeft={() => handleCopyItem("right_to_left", entry.relative_path)}
              />
            )}
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
                    const lRoot = folderData().left_root.replace(/\/$/, "");
                    const rRoot = folderData().right_root.replace(/\/$/, "");
                    const rel = menu().entry.relative_path;
                    setContextMenu(null);
                    props.onOpenFolderDiff?.(
                      `${lRoot}/${rel}`,
                      `${rRoot}/${rel}`,
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
              <div
                class="ctx-item highlight"
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
            <div
              class="ctx-item"
              onClick={() => {
                const rel = menu().entry.relative_path;
                setContextMenu(null);
                handleCopyItem("left_to_right", rel);
              }}
            >
              <span>{t("folder_diff.copy_to_right_item")}</span>
            </div>
            <div
              class="ctx-item"
              onClick={() => {
                const rel = menu().entry.relative_path;
                setContextMenu(null);
                handleCopyItem("right_to_left", rel);
              }}
            >
              <span>{t("folder_diff.copy_to_left_item")}</span>
            </div>
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
                scanRealFolders(leftInput(), rightInput());
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
  isCollapsed: boolean;
  onSelect: () => void;
  onToggleDir: () => void;
  onOpenDiff: () => void;
  onOpenFolderDiff?: () => void;
  onContextMenu: (e: MouseEvent) => void;
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
      onClick={props.onSelect}
      onDblClick={handleRowDblClick}
      onContextMenu={props.onContextMenu}
    >
      <div class="folder-col-left">
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

      <div class="folder-col-center">
        <Show when={!props.entry.is_dir && props.entry.status !== "equal"}>
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
        <Show when={!props.entry.is_dir && props.entry.status !== "equal"}>
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

      <div class="folder-col-right">
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
