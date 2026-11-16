import { Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  callRustRpc,
  createBlankThreeWaySession,
  loadRealThreeWayFiles,
  resolveThreeWayHunk,
  saveThreeWayMerged,
  UserPreferencesDto,
} from "../bridge";
import { FileBrowserModal } from "../components/FileBrowserModal";
import {
  ConflictResolution,
  ThreeWayDiffResult,
  ThreeWayHunk,
  ThreeWayRow,
} from "../types";
import { t } from "../i18n";
import { computeThreeWayNavTarget } from "../utils/preferences";

const THREE_WAY_ROW_HEIGHT = 24;

interface Merge3WayViewProps {
  sessionId: string;
  isActive?: boolean;
  initialLeftPath?: string;
  initialBasePath?: string;
  initialRightPath?: string;
  initialOutputPath?: string;
  titles?: [string | null, string | null, string | null, string | null];
  userPrefs?: UserPreferencesDto | null;
  collectWindowGeometry?: (immediate?: boolean) => Record<string, unknown>;
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
  const [activeHunkId, setActiveHunkId] = createSignal<number | null>(null);
  const [toast, setToast] = createSignal<string | null>(null);
  let lastReportedTitle = "";
  let lastLoadedKey = "";

  let leftScrollRef: HTMLDivElement | undefined;
  let baseScrollRef: HTMLDivElement | undefined;
  let rightScrollRef: HTMLDivElement | undefined;
  let scrollSyncLock: "left" | "base" | "right" | null = null;
  let scrollLockTimer: number | undefined;

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  };

  const syncScrollFrom = (source: "left" | "base" | "right", el: HTMLDivElement) => {
    if (scrollSyncLock !== null && scrollSyncLock !== source) return;
    scrollSyncLock = source;
    if (scrollLockTimer !== undefined) {
      window.clearTimeout(scrollLockTimer);
    }
    scrollLockTimer = window.setTimeout(() => {
      scrollSyncLock = null;
    }, 24);

    const targets = [
      source !== "left" ? leftScrollRef : undefined,
      source !== "base" ? baseScrollRef : undefined,
      source !== "right" ? rightScrollRef : undefined,
    ];
    for (const target of targets) {
      if (!target) continue;
      if (target.scrollTop !== el.scrollTop) {
        target.scrollTop = el.scrollTop;
      }
      if (target.scrollLeft !== el.scrollLeft) {
        target.scrollLeft = el.scrollLeft;
      }
    }
  };

  const scrollToHunk = (hunk: ThreeWayHunk) => {
    setActiveHunkId(hunk.id);
    const targetTop = Math.max(0, hunk.virtual_start * THREE_WAY_ROW_HEIGHT - 48);
    scrollSyncLock = "left";
    if (scrollLockTimer !== undefined) {
      window.clearTimeout(scrollLockTimer);
    }
    scrollLockTimer = window.setTimeout(() => {
      scrollSyncLock = null;
    }, 40);

    for (const ref of [leftScrollRef, baseScrollRef, rightScrollRef]) {
      if (ref) {
        ref.scrollTop = targetTop;
      }
    }
  };

  const jumpToConflict = (delta: number) => {
    const hunks = summary().hunks;
    if (hunks.length === 0) return;
    const wrapAround = props.userPrefs?.wrap_around_navigation ?? true;
    const { targetHunk, boundary } = computeThreeWayNavTarget(
      hunks,
      activeHunkId(),
      delta,
      wrapAround
    );
    if (boundary === "first") {
      notify(t("merge_3way.reached_first_conflict"));
      return;
    }
    if (boundary === "last") {
      notify(t("merge_3way.reached_last_conflict"));
      return;
    }
    if (targetHunk) {
      scrollToHunk(targetHunk);
    }
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
        lastLoadedKey = `${lp}\0${bp}\0${rp}`;
        setSummary(loaded.summary);
        setRows(loaded.rows);
        const firstConflict =
          loaded.summary.hunks.find((h) => h.status === "conflict") ??
          loaded.summary.hunks[0] ??
          null;
        setActiveHunkId(firstConflict ? firstConflict.id : null);
        if (firstConflict && (props.userPrefs?.auto_jump_first_diff ?? true)) {
          setTimeout(() => scrollToHunk(firstConflict), 0);
        }
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
    if (props.isActive === false || e.defaultPrevented) return;
    const activeEl = document.activeElement;
    const isInputFocused =
      activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement;

    if (e.key === "Escape") {
      if (pickerTarget()) {
        e.preventDefault();
        e.stopPropagation();
        setPickerTarget(null);
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

    if (isInputFocused || pickerTarget() || document.querySelector(".modal-backdrop")) {
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
      e.preventDefault();
      props.onCloseOrExit?.();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      handleSaveMergedOutput(false);
      return;
    }
    if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      jumpToConflict(1);
      return;
    }
    if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      jumpToConflict(-1);
      return;
    }
    if (e.key === "F7") {
      e.preventDefault();
      jumpToConflict(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === "n" || e.key === "j") {
      e.preventDefault();
      jumpToConflict(1);
      return;
    }
    if (e.key === "p" || e.key === "N" || e.key === "k") {
      e.preventDefault();
      jumpToConflict(-1);
    }
  };

  onMount(() => {
    document.addEventListener("keydown", handleMergeKeyDown);
    if (props.initialLeftPath && props.initialBasePath && props.initialRightPath) {
      handleLoadThreeWay(
        props.initialLeftPath,
        props.initialBasePath,
        props.initialRightPath
      );
    }
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleMergeKeyDown);
    if (scrollLockTimer !== undefined) {
      window.clearTimeout(scrollLockTimer);
    }
  });

  const handleResolve = (hunkId: number, resolution: ConflictResolution) => {
    const next = resolveThreeWayHunk(props.sessionId, hunkId, resolution);
    setSummary(next);
    notify(t("merge_3way.updated_hunk", { id: hunkId + 1, res: resolution }));
  };

  const handleSaveMergedOutput = async (closeAfterSave = false) => {
    const unresolved = summary().unresolved_conflicts;
    if (
      unresolved > 0 &&
      !window.confirm(t("merge_3way.unresolved_save_confirm", { count: unresolved }))
    ) {
      return;
    }

    const content = summary().merged_lines.join("\n") + "\n";
    const target = outputPath().trim() || basePath().trim();

    const shutdownWithGeometry = async () => {
      const payload = JSON.stringify(
        props.collectWindowGeometry
          ? props.collectWindowGeometry(true)
          : { immediate: true }
      );
      await fetch("/api/shutdown", {
        method: "POST",
        body: payload,
      }).catch(() => {});
      setTimeout(() => window.close(), 120);
    };

    try {
      const backendSave = await saveThreeWayMerged(
        props.sessionId,
        target || undefined
      );
      if (backendSave.usedBackend && backendSave.saved) {
        notify(
          t("merge_3way.saved_success", {
            path: target || basePath().trim() || leftPath().trim(),
          })
        );
        if (closeAfterSave) {
          await shutdownWithGeometry();
        }
        return;
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
      return;
    }

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
            await shutdownWithGeometry();
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
    const payload = JSON.stringify(
      props.collectWindowGeometry
        ? props.collectWindowGeometry(true)
        : { immediate: true }
    );
    await fetch("/api/shutdown", {
      method: "POST",
      body: payload,
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
          <button
            class="bc-tool-btn"
            onClick={() => jumpToConflict(-1)}
            disabled={summary().hunks.length === 0}
            title={t("merge_3way.prev_conflict_tip")}
          >
            {t("merge_3way.prev_conflict")}
          </button>
          <button
            class="bc-tool-btn"
            onClick={() => jumpToConflict(1)}
            disabled={summary().hunks.length === 0}
            title={t("merge_3way.next_conflict_tip")}
          >
            {t("merge_3way.next_conflict")}
          </button>
        </div>

        <div class="bc-toolbar-divider" />

        <div class="bc-toolbar-group">
          <For each={summary().hunks}>
            {(hunk) => (
              <div
                class={`hunk-resolve-pill ${activeHunkId() === hunk.id ? "active" : ""}`}
                onClick={() => scrollToHunk(hunk)}
                title={t("merge_3way.hunk_pill_tip")}
              >
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
                  onClick={(e) => {
                    e.stopPropagation();
                    scrollToHunk(hunk);
                    handleResolve(hunk.id, "use_left");
                  }}
                >
                  Left
                </button>
                <button
                  class={`mini-resolve-btn ${
                    hunk.resolution === "use_base" ? "active" : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    scrollToHunk(hunk);
                    handleResolve(hunk.id, "use_base");
                  }}
                >
                  Base
                </button>
                <button
                  class={`mini-resolve-btn ${
                    hunk.resolution === "use_right" ? "active" : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    scrollToHunk(hunk);
                    handleResolve(hunk.id, "use_right");
                  }}
                >
                  Right
                </button>
                <button
                  class={`mini-resolve-btn ${
                    hunk.resolution === "use_both_left_first" ? "active" : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    scrollToHunk(hunk);
                    handleResolve(hunk.id, "use_both_left_first");
                  }}
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
            onKeyDown={(e) => e.key === "Enter" && handleLoadThreeWay()}
            onBlur={() => {
              const lp = leftPath().trim();
              const bp = basePath().trim();
              const rp = rightPath().trim();
              if (lp && bp && rp && `${lp}\0${bp}\0${rp}` !== lastLoadedKey) {
                handleLoadThreeWay(lp, bp, rp);
              }
            }}
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
            onKeyDown={(e) => e.key === "Enter" && handleLoadThreeWay()}
            onBlur={() => {
              const lp = leftPath().trim();
              const bp = basePath().trim();
              const rp = rightPath().trim();
              if (lp && bp && rp && `${lp}\0${bp}\0${rp}` !== lastLoadedKey) {
                handleLoadThreeWay(lp, bp, rp);
              }
            }}
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
            onKeyDown={(e) => e.key === "Enter" && handleLoadThreeWay()}
            onBlur={() => {
              const lp = leftPath().trim();
              const bp = basePath().trim();
              const rp = rightPath().trim();
              if (lp && bp && rp && `${lp}\0${bp}\0${rp}` !== lastLoadedKey) {
                handleLoadThreeWay(lp, bp, rp);
              }
            }}
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
          <div
            ref={leftScrollRef}
            class="three-way-code-list"
            style={{
              "font-size": `${props.userPrefs?.editor_font_size ?? 12.5}px`,
              "tab-size": props.userPrefs?.tab_width ?? 4,
            }}
            onScroll={(e) => syncScrollFrom("left", e.currentTarget)}
          >
            <div class="three-way-rows-inner">
              <For each={rows()}>
                {(row) => (
                  <div
                    class={`three-way-row status-3w-${row.status} ${
                      row.hunk_id !== null && row.hunk_id === activeHunkId()
                        ? "three-way-row-active"
                        : ""
                    }`}
                  >
                    <span class="line-num-gutter">{row.left_line_no ?? ""}</span>
                    <span class="line-code-content">{row.left_text ?? ""}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>

        <div class="three-way-col">
          <div class="three-way-col-header base">
            {props.titles?.[2] ?? t("merge_3way.base_default")}
          </div>
          <div
            ref={baseScrollRef}
            class="three-way-code-list"
            style={{
              "font-size": `${props.userPrefs?.editor_font_size ?? 12.5}px`,
              "tab-size": props.userPrefs?.tab_width ?? 4,
            }}
            onScroll={(e) => syncScrollFrom("base", e.currentTarget)}
          >
            <div class="three-way-rows-inner">
              <For each={rows()}>
                {(row) => (
                  <div
                    class={`three-way-row status-3w-${row.status} ${
                      row.hunk_id !== null && row.hunk_id === activeHunkId()
                        ? "three-way-row-active"
                        : ""
                    }`}
                  >
                    <span class="line-num-gutter">{row.base_line_no ?? ""}</span>
                    <span class="line-code-content">{row.base_text ?? ""}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>

        <div class="three-way-col">
          <div class="three-way-col-header right">
            {props.titles?.[1] ?? t("merge_3way.theirs_default")}
          </div>
          <div
            ref={rightScrollRef}
            class="three-way-code-list"
            style={{
              "font-size": `${props.userPrefs?.editor_font_size ?? 12.5}px`,
              "tab-size": props.userPrefs?.tab_width ?? 4,
            }}
            onScroll={(e) => syncScrollFrom("right", e.currentTarget)}
          >
            <div class="three-way-rows-inner">
              <For each={rows()}>
                {(row) => (
                  <div
                    class={`three-way-row status-3w-${row.status} ${
                      row.hunk_id !== null && row.hunk_id === activeHunkId()
                        ? "three-way-row-active"
                        : ""
                    }`}
                  >
                    <span class="line-num-gutter">{row.right_line_no ?? ""}</span>
                    <span class="line-code-content">{row.right_text ?? ""}</span>
                  </div>
                )}
              </For>
            </div>
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
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
            }}
            onBlur={(e) => setOutputPath(e.currentTarget.value.trim())}
          />
          <span class="output-line-count">{t("merge_3way.line_count", { count: summary().merged_lines.length })}</span>
        </div>
        <div
          class="three-way-output-body"
          style={{
            "font-size": `${props.userPrefs?.editor_font_size ?? 12.5}px`,
            "tab-size": props.userPrefs?.tab_width ?? 4,
          }}
        >
          <div class="three-way-rows-inner">
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
              if (leftPath().trim() && basePath().trim() && rightPath().trim()) {
                handleLoadThreeWay();
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
