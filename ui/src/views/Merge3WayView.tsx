import { Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  callRustRpc,
  createBlankThreeWaySession,
  loadRealThreeWayFiles,
  resolveThreeWayHunk,
} from "../bridge";
import { FileBrowserModal } from "../components/FileBrowserModal";
import { ConflictResolution, ThreeWayDiffResult, ThreeWayRow } from "../types";

interface Merge3WayViewProps {
  sessionId: string;
  initialLeftPath?: string;
  initialBasePath?: string;
  initialRightPath?: string;
  initialOutputPath?: string;
  titles?: [string | null, string | null, string | null, string | null];
  onCloseOrExit?: () => void;
}

export const Merge3WayView: Component<Merge3WayViewProps> = (props) => {
  const initial = createBlankThreeWaySession(props.sessionId);
  const [summary, setSummary] = createSignal<ThreeWayDiffResult>(initial.summary);
  const [rows, setRows] = createSignal<ThreeWayRow[]>(initial.rows);

  const [leftPath, setLeftPath] = createSignal(props.initialLeftPath ?? "");
  const [basePath, setBasePath] = createSignal(props.initialBasePath ?? "");
  const [rightPath, setRightPath] = createSignal(props.initialRightPath ?? "");
  const [outputPath, setOutputPath] = createSignal(props.initialOutputPath ?? "");
  const [pickerTarget, setPickerTarget] = createSignal<
    "left" | "base" | "right" | null
  >(null);
  const [toast, setToast] = createSignal<string | null>(null);

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  };

  const handleLoadThreeWay = async (l?: string, b?: string, r?: string) => {
    const lp = (l ?? leftPath()).trim();
    const bp = (b ?? basePath()).trim();
    const rp = (r ?? rightPath()).trim();
    if (!lp || !bp || !rp) {
      notify("请先指定 Left、Base、Right 三个文件路径");
      return;
    }
    try {
      const loaded = await loadRealThreeWayFiles(
        props.sessionId,
        lp,
        bp,
        rp,
        outputPath().trim() || undefined
      );
      if (loaded) {
        setSummary(loaded.summary);
        setRows(loaded.rows);
        notify(`已加载三向合并: ${loaded.summary.hunks.length} 处变更块`);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  };

  const handleMergeKeyDown = (e: KeyboardEvent) => {
    const activeEl = document.activeElement;
    if (
      activeEl instanceof HTMLInputElement ||
      activeEl instanceof HTMLTextAreaElement ||
      pickerTarget()
    ) {
      return;
    }
    if (e.key === "Escape" || (e.ctrlKey && e.key.toLowerCase() === "w")) {
      e.preventDefault();
      props.onCloseOrExit?.();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      handleSaveMergedOutput(false);
    }
  };

  onMount(() => {
    window.addEventListener("keydown", handleMergeKeyDown);
    if (props.initialLeftPath && props.initialBasePath && props.initialRightPath) {
      handleLoadThreeWay(
        props.initialLeftPath,
        props.initialBasePath,
        props.initialRightPath
      );
    }
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleMergeKeyDown);
  });

  const handleResolve = (hunkId: number, resolution: ConflictResolution) => {
    const next = resolveThreeWayHunk(props.sessionId, hunkId, resolution);
    setSummary(next);
    notify(`已更新块 #${hunkId + 1} 合并策略 (${resolution})`);
  };

  const handleSaveMergedOutput = async (closeAfterSave = false) => {
    const content = summary().merged_lines.join("\n") + "\n";
    const target = outputPath().trim() || basePath().trim();
    if (target) {
      try {
        const res = await callRustRpc<{ saved: boolean }>("write_text_file", {
          path: target,
          content,
        });
        if (res?.saved) {
          await callRustRpc("set_process_exit_code", { code: 0 });
          notify(`已保存合并结果到: ${target} (Exit Code: 0)`);
          if (closeAfterSave) {
            await fetch("/api/shutdown", {
              method: "POST",
              body: "immediate",
            }).catch(() => {});
            setTimeout(() => window.close(), 120);
          }
          return;
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    try {
      await navigator.clipboard.writeText(content);
      notify("已拷贝合并结果全文到剪贴板");
    } catch {
      notify("请指定输出文件路径后保存");
    }
  };

  const handleAbortMerge = async () => {
    await callRustRpc("set_process_exit_code", { code: 1 });
    await fetch("/api/shutdown", {
      method: "POST",
      body: "immediate",
    }).catch(() => {});
    setTimeout(() => window.close(), 120);
  };

  return (
    <div class="view-container">
      {/* 3-Way Merge Toolbar */}
      <div class="bc-toolbar">
        <div class="bc-toolbar-group">
          <span class="merge-status-banner">
            {rows().length === 0
              ? "请选择 Left / Base / Right 三个文件开始三向合并"
              : summary().unresolved_conflicts > 0
              ? `⚠️ 剩余 ${summary().unresolved_conflicts} 处冲突待解决`
              : "✅ 所有冲突已解决，可安全保存输出"}
          </span>
        </div>

        <div class="bc-toolbar-divider" />

        <div class="bc-toolbar-group">
          <For each={summary().hunks}>
            {(hunk) => (
              <div class="hunk-resolve-pill">
                <span class="hunk-badge">
                  块 #{hunk.id + 1} ({hunk.status === "conflict" ? "冲突" : "自动"}):
                </span>
                <button
                  class={`mini-resolve-btn ${
                    hunk.resolution === "use_left" ? "active" : ""
                  }`}
                  onClick={() => handleResolve(hunk.id, "use_left")}
                >
                  Left
                </button>
                <button
                  class={`mini-resolve-btn ${
                    hunk.resolution === "use_base" ? "active" : ""
                  }`}
                  onClick={() => handleResolve(hunk.id, "use_base")}
                >
                  Base
                </button>
                <button
                  class={`mini-resolve-btn ${
                    hunk.resolution === "use_right" ? "active" : ""
                  }`}
                  onClick={() => handleResolve(hunk.id, "use_right")}
                >
                  Right
                </button>
                <button
                  class={`mini-resolve-btn ${
                    hunk.resolution === "use_both_left_first" ? "active" : ""
                  }`}
                  onClick={() => handleResolve(hunk.id, "use_both_left_first")}
                >
                  L+R
                </button>
              </div>
            )}
          </For>
        </div>

        <div class="bc-stats-pills">
          <button
            class="bc-tool-btn"
            onClick={() => handleSaveMergedOutput(false)}
          >
            💾 保存输出
          </button>
          <button
            class="bc-tool-btn active"
            onClick={() => handleSaveMergedOutput(true)}
            title="保存合并结果并以 Exit Code 0 退出 (Git Mergetool 成功)"
          >
            ✅ 完成合并退出 (Exit 0)
          </button>
          <button
            class="bc-tool-btn"
            onClick={handleAbortMerge}
            title="放弃合并并以 Exit Code 1 退出 (Git Mergetool 保留冲突)"
          >
            🚫 放弃合并 (Exit 1)
          </button>
        </div>
      </div>

      {/* 3-Way Path Bar */}
      <div
        class="dual-path-bar"
        style={{ "grid-template-columns": "1fr 1fr 1fr" }}
      >
        <div class="path-input-box">
          <span class="side-badge left">LEFT</span>
          <input
            class="path-text-input"
            placeholder="Left (本地修改文件)..."
            value={leftPath()}
            onInput={(e) => setLeftPath(e.currentTarget.value)}
          />
          <button class="browse-btn" onClick={() => setPickerTarget("left")}>
            📂 浏览
          </button>
        </div>

        <div class="path-input-box">
          <span class="side-badge">BASE</span>
          <input
            class="path-text-input"
            placeholder="Base (共同祖先文件)..."
            value={basePath()}
            onInput={(e) => setBasePath(e.currentTarget.value)}
          />
          <button class="browse-btn" onClick={() => setPickerTarget("base")}>
            📂 浏览
          </button>
        </div>

        <div class="path-input-box">
          <span class="side-badge right">RIGHT</span>
          <input
            class="path-text-input"
            placeholder="Right (远端文件)..."
            value={rightPath()}
            onInput={(e) => setRightPath(e.currentTarget.value)}
          />
          <button class="browse-btn" onClick={() => setPickerTarget("right")}>
            📂 浏览
          </button>
          <button class="browse-btn" onClick={() => handleLoadThreeWay()}>
            🔄 加载合并
          </button>
        </div>
      </div>

      {/* Top 3 Panes: Left (LOCAL) | Base (ANCESTOR) | Right (REMOTE) */}
      <div class="three-way-top-grid">
        <div class="three-way-col">
          <div class="three-way-col-header left">
            {props.titles?.[0] ?? "LEFT (本地修改 / LOCAL)"}
          </div>
          <div class="three-way-code-list">
            <For each={rows()}>
              {(row) => (
                <div class={`three-way-row status-3w-${row.status}`}>
                  <span class="line-num-gutter">{row.left_line_no ?? ""}</span>
                  <span class="line-code-content">{row.left_text ?? ""}</span>
                </div>
              )}
            </For>
          </div>
        </div>

        <div class="three-way-col">
          <div class="three-way-col-header base">
            {props.titles?.[2] ?? "BASE (共同祖先 / ANCESTOR)"}
          </div>
          <div class="three-way-code-list">
            <For each={rows()}>
              {(row) => (
                <div class={`three-way-row status-3w-${row.status}`}>
                  <span class="line-num-gutter">{row.base_line_no ?? ""}</span>
                  <span class="line-code-content">{row.base_text ?? ""}</span>
                </div>
              )}
            </For>
          </div>
        </div>

        <div class="three-way-col">
          <div class="three-way-col-header right">
            {props.titles?.[1] ?? "RIGHT (远端修改 / REMOTE)"}
          </div>
          <div class="three-way-code-list">
            <For each={rows()}>
              {(row) => (
                <div class={`three-way-row status-3w-${row.status}`}>
                  <span class="line-num-gutter">{row.right_line_no ?? ""}</span>
                  <span class="line-code-content">{row.right_text ?? ""}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>

      {/* Bottom 4th Pane: Merged Output */}
      <div class="three-way-output-pane">
        <div class="three-way-output-header">
          <span>📝 MERGED OUTPUT (合并结果输出窗格)</span>
          <input
            class="path-text-input"
            style={{ "max-width": "380px", border: "1px solid var(--border-color)", padding: "2px 8px" }}
            placeholder="可选: 输出保存文件路径 (默认覆盖 Base)"
            value={outputPath()}
            onInput={(e) => setOutputPath(e.currentTarget.value)}
          />
          <span class="output-line-count">共 {summary().merged_lines.length} 行</span>
        </div>
        <div class="three-way-output-body">
          <For each={summary().merged_lines}>
            {(line, idx) => {
              const isMarker =
                line.startsWith("<<<<<<<") ||
                line.startsWith("=======") ||
                line.startsWith(">>>>>>>");
              return (
                <div
                  class={`three-way-row ${
                    isMarker ? "conflict-marker-row" : ""
                  }`}
                >
                  <span class="line-num-gutter">{idx() + 1}</span>
                  <span class="line-code-content">{line}</span>
                </div>
              );
            }}
          </For>
        </div>
      </div>

      <Show when={pickerTarget()}>
        {(target) => (
          <FileBrowserModal
            mode="file"
            title={`选择 ${target().toUpperCase()} 文件`}
            onClose={() => setPickerTarget(null)}
            onSelect={(p) => {
              const t = target();
              setPickerTarget(null);
              if (t === "left") setLeftPath(p);
              if (t === "base") setBasePath(p);
              if (t === "right") setRightPath(p);
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
