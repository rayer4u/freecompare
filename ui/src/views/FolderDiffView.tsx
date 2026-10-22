import { Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  callRustRpc,
  createBlankFolderDiff,
  recomputeFolderStats,
  UserPreferencesDto,
} from "../bridge";
import { FileBrowserModal } from "../components/FileBrowserModal";
import {
  FolderDiffResult,
  FolderEntryDto,
  FolderItemStatus,
  FolderSubtreeResult,
  SiblingDiffFileItem,
} from "../types";

interface FolderDiffViewProps {
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

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const scanRealFolders = async (lDir: string, rDir: string, recursive = isRecursiveScan()) => {
    const l = lDir.trim();
    const r = rDir.trim();
    if (!l || !r) {
      notify("请先输入或浏览选择左侧与右侧文件夹路径");
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
        notify(
          recursive
            ? `已递归扫描目录: 共 ${res.stats.total_items} 个文件`
            : `已扫描当前层: 共 ${res.entries.length} 个项目 (子文件夹可右键嵌套比较)`
        );
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCompareSubfolder = async (subRel: string) => {
    notify(`正在嵌套比较目录: ${subRel}...`);
    try {
      const res = await callRustRpc<FolderSubtreeResult>("compare_subfolder", {
        left_dir: folderData().left_root,
        right_dir: folderData().right_root,
        sub_rel: subRel,
        options: {
          mode: compareMode() === "hash" ? "content_hash" : "fast_metadata",
          ignore_case_names: false,
          exclude_globs: [".git", "node_modules", "target", ".DS_Store"],
          recursive: true,
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
          return next;
        });

        notify(`已完成 ${res.relative_path} 的嵌套比较: 发现 ${res.entries.length} 个子项`);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  };

  const buildSiblingDiffFiles = (): SiblingDiffFileItem[] => {
    const lRoot = folderData().left_root.replace(/\/$/, "");
    const rRoot = folderData().right_root.replace(/\/$/, "");
    return visibleEntries()
      .filter((e) => !e.is_dir)
      .map((e) => ({
        relativePath: e.relative_path,
        leftFullPath: `${lRoot}/${e.relative_path}`,
        rightFullPath: `${rRoot}/${e.relative_path}`,
        status: e.status,
      }));
  };

  const openEntry = (entry: FolderEntryDto) => {
    if (!entry.is_dir) {
      const lRoot = folderData().left_root.replace(/\/$/, "");
      const rRoot = folderData().right_root.replace(/\/$/, "");
      props.onOpenFileDiff(
        `${lRoot}/${entry.relative_path}`,
        `${rRoot}/${entry.relative_path}`,
        entry.relative_path,
        buildSiblingDiffFiles()
      );
    } else {
      toggleDir(entry.relative_path);
    }
  };

  const handleFolderKeyDown = (e: KeyboardEvent) => {
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
      if (!hasChildren) {
        await handleCompareSubfolder(relPath);
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
    // If some folders are uncompared, trigger recursive scan to ensure all subfolders are compared & expanded
    const hasUncompared = folderData().entries.some(
      (e) => e.is_dir && e.status === "unknown"
    );
    if (hasUncompared) {
      setIsRecursiveScan(true);
      await scanRealFolders(leftInput(), rightInput(), true);
    }
    setCollapsedDirs(new Set<string>());
  };

  const collapseAll = () => {
    const dirs = folderData()
      .entries.filter((e) => e.is_dir)
      .map((e) => e.relative_path);
    setCollapsedDirs(new Set(dirs));
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
          ? `已复制文件到右侧目录: ${rel}`
          : `已复制文件到左侧目录: ${rel}`
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
            ✱ 全部项
          </button>
          <button
            class={`bc-tool-btn ${filterStatus() === "diffs" ? "active" : ""}`}
            onClick={() => updateFilterAndPersist("diffs")}
          >
            ≠ 仅差异
          </button>
          <button
            class={`bc-tool-btn ${filterStatus() === "orphans" ? "active" : ""}`}
            onClick={() => updateFilterAndPersist("orphans")}
          >
            ◐ 仅孤立项
          </button>
          <button
            class={`bc-tool-btn ${filterStatus() === "equals" ? "active" : ""}`}
            onClick={() => updateFilterAndPersist("equals")}
          >
            ＝ 仅相同
          </button>
        </div>

        <div class="bc-toolbar-divider" />

        <div class="bc-toolbar-group">
          <button
            class={`bc-tool-btn ${!isRecursiveScan() ? "active" : ""}`}
            onClick={() => {
              setIsRecursiveScan(false);
              scanRealFolders(leftInput(), rightInput(), false);
            }}
            title="默认模式：仅比较当前层目录，子文件夹不自动递归展开"
          >
            📁 仅当前层
          </button>
          <button
            class={`bc-tool-btn ${isRecursiveScan() ? "active" : ""}`}
            onClick={() => {
              setIsRecursiveScan(true);
              scanRealFolders(leftInput(), rightInput(), true);
            }}
            title="递归扫描全部嵌套子文件夹"
          >
            🔍 嵌套比较全部
          </button>
          <button class="bc-tool-btn" onClick={expandAll} title="展开全部子文件夹">
            ⊞ 展开全部
          </button>
          <button class="bc-tool-btn" onClick={collapseAll} title="折叠全部子文件夹">
            ⊟ 折叠全部
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
            ⚡ 模式: {compareMode() === "hash" ? "BLAKE3 哈希" : "元数据快扫"}
          </button>
          <button
            class="bc-tool-btn accent-right"
            disabled={!selectedRelPath()}
            onClick={() => handleCopyItem("left_to_right")}
          >
            复制到右 »
          </button>
          <button
            class="bc-tool-btn accent-left"
            disabled={!selectedRelPath()}
            onClick={() => handleCopyItem("right_to_left")}
          >
            « 复制到左
          </button>
          <button class="bc-tool-btn" onClick={handleSwapFolders}>
            ⇄ 交换左右
          </button>
        </div>

        <div class="bc-toolbar-divider" />

        <input
          class="folder-filter-input"
          placeholder="过滤文件名或路径..."
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
        />

        <div class="bc-stats-pills">
          <span class="stat-pill mod">差异文件: {folderData().stats.modified_items}</span>
          <span class="stat-pill ins">左独有: {folderData().stats.left_only_items}</span>
          <span class="stat-pill del">右独有: {folderData().stats.right_only_items}</span>
          <span class="stat-pill eq">相同: {folderData().stats.equal_items}</span>
        </div>
      </div>

      {/* Folder Root Paths */}
      <div class="dual-path-bar">
        <div class="path-input-box">
          <span class="side-badge left">LEFT DIR</span>
          <input
            class="path-text-input"
            list="mru-folder-paths"
            placeholder="输入或浏览选择左侧文件夹路径..."
            value={leftInput()}
            onInput={(e) => setLeftInput(e.currentTarget.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && scanRealFolders(leftInput(), rightInput())
            }
          />
          <button class="browse-btn" onClick={() => setBrowserSide("left")}>
            📂 浏览...
          </button>
        </div>
        <div class="path-input-box">
          <span class="side-badge right">RIGHT DIR</span>
          <input
            class="path-text-input"
            list="mru-folder-paths"
            placeholder="输入或浏览选择右侧文件夹路径..."
            value={rightInput()}
            onInput={(e) => setRightInput(e.currentTarget.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && scanRealFolders(leftInput(), rightInput())
            }
          />
          <datalist id="mru-folder-paths">
            <For each={recentFolders()}>{(p) => <option value={p} />}</For>
          </datalist>
          <button class="browse-btn" onClick={() => setBrowserSide("right")}>
            📂 浏览...
          </button>
          <button
            class="browse-btn"
            onClick={() => scanRealFolders(leftInput(), rightInput())}
          >
            🔄 开始对比
          </button>
        </div>
      </div>

      {/* Side-by-Side Synchronized Folder TreeGrid */}
      <div class="folder-tree-container">
        <div class="folder-tree-header">
          <div class="folder-col-left">
            <span class="col-name">左侧名称 (双击文件打开文本对比)</span>
            <span class="col-size">大小</span>
            <span class="col-time">修改时间</span>
          </div>
          <div class="folder-col-center">操作</div>
          <div class="folder-col-right">
            <span class="col-name">右侧名称</span>
            <span class="col-size">大小</span>
            <span class="col-time">修改时间</span>
          </div>
        </div>

        <div class="folder-tree-body" style={{ position: "relative" }}>
          <Show when={folderData().entries.length === 0}>
            <div class="empty-paste-overlay">
              <div class="paste-hint-card">
                <strong>尚未加载对比文件夹</strong>
                <span>
                  请在上方输入左右文件夹路径，或点击 <kbd>📂 浏览...</kbd> 选择本地目录进行对比
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
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelectedRelPath(entry.relative_path);
                  setContextMenu({ x: e.clientX, y: e.clientY, entry });
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
                  handleCompareSubfolder(rel);
                }}
              >
                <span>🔍 嵌套比较此文件夹 (递归对比)</span>
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
                  <span>📂 在新标签页中打开</span>
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
                    ? "⊞ 展开此文件夹"
                    : "⊟ 折叠此文件夹"}
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
                <span>⇄ 打开文本对比 (Enter / 双击)</span>
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
              <span>» 复制到右侧</span>
            </div>
            <div
              class="ctx-item"
              onClick={() => {
                const rel = menu().entry.relative_path;
                setContextMenu(null);
                handleCopyItem("right_to_left", rel);
              }}
            >
              <span>« 复制到左侧</span>
            </div>
            <div class="ctx-divider" />
            <div
              class="ctx-item"
              onClick={() => {
                const rel = menu().entry.relative_path;
                setContextMenu(null);
                navigator.clipboard.writeText(rel);
                notify(`已复制相对路径: ${rel}`);
              }}
            >
              <span>📋 复制相对路径</span>
            </div>
          </div>
        )}
      </Show>

      <Show when={browserSide()}>
        {(side) => (
          <FileBrowserModal
            mode="folder"
            title={side() === "left" ? "选择左侧文件夹" : "选择右侧文件夹"}
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
  onContextMenu: (e: MouseEvent) => void;
  onCopyRight: () => void;
  onCopyLeft: () => void;
}> = (props) => {
  const indentPx = () => `${props.entry.depth * 20 + 10}px`;
  const hasLeft = () => props.entry.status !== "right_only";
  const hasRight = () => props.entry.status !== "left_only";

  return (
    <div
      class={`folder-row folder-status-${props.entry.status} ${
        props.isSelected ? "selected" : ""
      }`}
      onClick={props.onSelect}
      onDblClick={props.onOpenDiff}
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
            {hasLeft() ? props.entry.name : "— (不存在)"}
          </span>
          <Show when={props.entry.is_dir && props.entry.status === "unknown"}>
            <span class="uncompared-badge" title="未嵌套比较，右键选择“嵌套比较”或点击展开">
              未嵌套比较
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
            title="复制到右侧"
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
            title="复制到左侧"
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
            {hasRight() ? props.entry.name : "— (不存在)"}
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
  return `${(size / 1024).toFixed(1)} KB`;
}

function formatTime(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}
