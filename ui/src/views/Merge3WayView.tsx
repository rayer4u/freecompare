import { Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  callRustRpc,
  createBlankThreeWaySession,
  loadRealThreeWayFiles,
  resolveThreeWayHunk,
} from "../bridge";
import { FileBrowserModal } from "../components/FileBrowserModal";
import { ConflictResolution, ThreeWayDiffResult, ThreeWayRow } from "../types";
import { t } from "../i18n";

interface Merge3WayViewProps {
  sessionId: string;
  isActive?: boolean;
  initialLeftPath?: string;
  initialBasePath?: string;
  initialRightPath?: string;
  initialOutputPath?: string;
  titles?: [string | null, string | null, string | null, string | null];
  onCloseOrExit?: () => void;
  onUpdateTabTitle?: (newTitle: string) => void;
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
  let lastReportedTitle = "";

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  };

  const handleLoadThreeWay = async (l?: string, b?: string, r?: string) => {
    const lp = (l ?? leftPath()).trim();
    const bp = (b ?? basePath()).trim();
    const rp = (r ?? rightPath()).trim();
    if (!lp || !bp || !rp) {
      notify(t("merge_3way.missing_paths"));
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
        const fileBase =
          bp.split(/[/\\]/).pop() ||
          lp.split(/[/\\]/).pop() ||
          rp.split(/[/\\]/).pop();
        if (fileBase && fileBase !== lastReportedTitle) {
          lastReportedTitle = fileBase;
          props.onUpdateTabTitle?.(`⑃ ${fileBase}`);
        }
        notify(t("merge_3way.loaded_hunks", { count: loaded.summary.hunks.length }));
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  };

  const handleMergeKeyDown = (e: KeyboardEvent) => {
    if (props.isActive === false) return;
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
    notify(t("merge_3way.updated_hunk", { id: hunkId + 1, res: resolution }));
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
          notify(t("merge_3way.saved_success", { path: target }));
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
      notify(t("merge_3way.copied_clipboard"));
    } catch {
      notify(t("merge_3way.specify_output"));
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
              ? t("merge_3way.select_paths_notice")
              : summary().unresolved_conflicts > 0
              ? t("merge_3way.unresolved_notice", { count: summary().unresolved_conflicts })
              : t("merge_3way.resolved_notice")}
          </span>
        </div>

        <div class="bc-toolbar-divider" />

        <div class="bc-toolbar-group">
          <For each={summary().hunks}>
            {(hunk) => (
              <div class="hunk-resolve-pill">
                <span class="hunk-badge">
                  {t("merge_3way.hunk_label", {
                    id: hunk.id + 1,
                    status: hunk.status === "conflict" ? t("merge_3way.status_conflict") : t("merge_3way.status_auto"),
                  })}
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
            onClick={() => handleLoadThreeWay()}
            title={t("merge_3way.load_btn")}
          >
            {t("merge_3way.load_btn")}
          </button>
          <button
            class="bc-tool-btn"
            onClick={() => handleSaveMergedOutput(false)}
          >
            {t("merge_3way.save_merged")}
          </button>
          <button
            class="bc-tool-btn active"
            onClick={() => handleSaveMergedOutput(true)}
            title="Exit 0"
          >
            ✅ {t("common.ok")} (Exit 0)
          </button>
          <button
            class="bc-tool-btn"
            onClick={handleAbortMerge}
            title="Exit 1"
          >
            🚫 {t("common.cancel")} (Exit 1)
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
            placeholder={t("merge_3way.pick_left")}
            value={leftPath()}
            onInput={(e) => setLeftPath(e.currentTarget.value)}
          />
          <button
            class="browse-btn"
            title={t("common.browse")}
            onClick={() => setPickerTarget("left")}
          >
            📂
          </button>
        </div>

        <div class="path-input-box">
          <span class="side-badge">BASE</span>
          <input
            class="path-text-input"
            placeholder={t("merge_3way.pick_base")}
            value={basePath()}
            onInput={(e) => setBasePath(e.currentTarget.value)}
          />
          <button
            class="browse-btn"
            title={t("common.browse")}
            onClick={() => setPickerTarget("base")}
          >
            📂
          </button>
        </div>

        <div class="path-input-box">
          <span class="side-badge right">RIGHT</span>
          <input
            class="path-text-input"
            placeholder={t("merge_3way.pick_right")}
            value={rightPath()}
            onInput={(e) => setRightPath(e.currentTarget.value)}
          />
          <button
            class="browse-btn"
            title={t("common.browse")}
            onClick={() => setPickerTarget("right")}
          >
            📂
          </button>
        </div>
      </div>

      {/* Top 3 Panes: Left (LOCAL) | Base (ANCESTOR) | Right (REMOTE) */}
      <div class="three-way-top-grid">
        <div class="three-way-col">
          <div class="three-way-col-header left">
            {props.titles?.[0] ?? t("merge_3way.ours_default")}
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
            {props.titles?.[2] ?? t("merge_3way.base_default")}
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
            {props.titles?.[1] ?? t("merge_3way.theirs_default")}
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
          <span>{t("merge_3way.merged_output_header")}</span>
          <input
            class="path-text-input"
            style={{ "max-width": "380px", border: "1px solid var(--border-color)", padding: "2px 8px" }}
            placeholder={t("merge_3way.pick_output")}
            value={outputPath()}
            onInput={(e) => setOutputPath(e.currentTarget.value)}
          />
          <span class="output-line-count">{t("merge_3way.line_count", { count: summary().merged_lines.length })}</span>
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
