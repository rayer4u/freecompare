import { Component, createSignal, For, onMount, Show } from "solid-js";
import { callRustRpc } from "../bridge";

export interface FsEntryDto {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface FsListResponse {
  current_dir: string;
  parent_dir: string | null;
  entries: FsEntryDto[];
}

interface FileBrowserModalProps {
  mode: "file" | "folder";
  title: string;
  initialPath?: string;
  onSelect: (selectedPath: string) => void;
  onClose: () => void;
}

export const FileBrowserModal: Component<FileBrowserModalProps> = (props) => {
  const [currentDir, setCurrentDir] = createSignal(props.initialPath ?? "");
  const [parentDir, setParentDir] = createSignal<string | null>(null);
  const [entries, setEntries] = createSignal<FsEntryDto[]>([]);
  const [selectedItem, setSelectedItem] = createSignal<FsEntryDto | null>(null);
  const [showHidden, setShowHidden] = createSignal(false);
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);

  const loadDir = async (targetPath?: string) => {
    setErrorMsg(null);
    try {
      const res = await callRustRpc<FsListResponse>("list_local_dir", {
        dir_path: targetPath ?? null,
      });
      if (res) {
        setCurrentDir(res.current_dir);
        setParentDir(res.parent_dir);
        setEntries(res.entries);
        setSelectedItem(null);
      } else {
        setErrorMsg("无法连接本地文件系统服务");
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  onMount(() => {
    loadDir(props.initialPath);
  });

  const visibleEntries = () =>
    entries().filter((e) => {
      if (!showHidden() && e.name.startsWith(".")) return false;
      if (props.mode === "folder") return e.is_dir;
      return true;
    });

  const handleConfirm = () => {
    const sel = selectedItem();
    if (props.mode === "folder") {
      if (sel && sel.is_dir) {
        props.onSelect(sel.path);
      } else if (currentDir()) {
        props.onSelect(currentDir());
      }
    } else if (sel && !sel.is_dir) {
      props.onSelect(sel.path);
    }
  };

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="file-browser-dialog" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <strong>📂 {props.title}</strong>
          <button class="modal-close-btn" onClick={props.onClose}>
            ×
          </button>
        </div>

        <div class="modal-path-bar">
          <button
            class="bc-tool-btn"
            disabled={!parentDir()}
            onClick={() => parentDir() && loadDir(parentDir()!)}
            title="返回上级目录"
          >
            ⬆ 上级
          </button>
          <input
            class="path-text-input modal-dir-input"
            value={currentDir()}
            onInput={(e) => setCurrentDir(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && loadDir(currentDir())}
          />
          <button class="bc-tool-btn" onClick={() => loadDir(currentDir())}>
            前往
          </button>
          <label class="hidden-toggle">
            <input
              type="checkbox"
              checked={showHidden()}
              onChange={(e) => setShowHidden(e.currentTarget.checked)}
            />
            显示隐藏文件
          </label>
        </div>

        <Show when={errorMsg()}>
          <div class="modal-error-banner">{errorMsg()}</div>
        </Show>

        <div class="modal-file-list">
          <For each={visibleEntries()}>
            {(item) => (
              <div
                class={`modal-file-row ${
                  selectedItem()?.path === item.path ? "selected" : ""
                }`}
                onClick={() => setSelectedItem(item)}
                onDblClick={() => {
                  if (item.is_dir) {
                    loadDir(item.path);
                  } else if (props.mode === "file") {
                    props.onSelect(item.path);
                  }
                }}
              >
                <span class="entry-icon">{item.is_dir ? "📁" : "📄"}</span>
                <span class="modal-file-name">{item.name}</span>
                <span class="modal-file-size">
                  {item.is_dir ? "文件夹" : `${item.size} B`}
                </span>
              </div>
            )}
          </For>
        </div>

        <div class="modal-footer">
          <span class="modal-selection-hint">
            {props.mode === "folder"
              ? `当前选择目录: ${selectedItem()?.path ?? currentDir()}`
              : `当前选择文件: ${selectedItem()?.name ?? "(未选择文件，双击文件夹可进入)"}`}
          </span>
          <div class="modal-footer-btns">
            <button class="bc-tool-btn" onClick={props.onClose}>
              取消
            </button>
            <button
              class="bc-tool-btn active"
              disabled={props.mode === "file" && (!selectedItem() || selectedItem()!.is_dir)}
              onClick={handleConfirm}
            >
              确定选择
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
