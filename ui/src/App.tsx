import { Component, createEffect, createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import { createStore } from "solid-js/store";
import { callRustRpc, StartupLaunchSessionDto, UserPreferencesDto } from "./bridge";
import { SessionTabKind, WorkspaceTab } from "./types";
import { HomeView } from "./views/HomeView";
import { TextDiffView } from "./views/TextDiffView";
import { FolderDiffView } from "./views/FolderDiffView";
import { Merge3WayView } from "./views/Merge3WayView";
import { SettingsModal } from "./components/SettingsModal";
import { AboutModal } from "./components/AboutModal";
import { currentLocale, setLocale, toggleLocale, t } from "./i18n";

export const App: Component = () => {
  const [theme, setTheme] = createSignal<"dark" | "light">("dark");
  const [showSettings, setShowSettings] = createSignal(false);
  const [showAbout, setShowAbout] = createSignal(false);
  // Start cleanly on the Home tab without any pre-populated fake demo tabs!
  const [tabs, setTabs] = createStore<WorkspaceTab[]>([
    { id: "tab-home", title: "🏠 新建会话", kind: "home" },
  ]);

  const [activeTabId, setActiveTabId] = createSignal<string>("tab-home");
  const activeTab = () => tabs.find((t) => t.id === activeTabId()) ?? tabs[0];
  let tabCounter = 1;

  const launchSession = (
    kind: SessionTabKind,
    title: string,
    leftPath?: string,
    rightPath?: string,
    basePath?: string,
    extra?: Partial<WorkspaceTab>
  ) => {
    const id = `tab-${kind}-${tabCounter++}`;
    const prefix =
      kind === "two_way"
        ? "⇄ "
        : kind === "folder"
        ? "📁 "
        : kind === "three_way"
        ? "⑃ "
        : "🏠 ";
    const fullTitle = title.startsWith(prefix) ? title : prefix + title;
    const nextTab: WorkspaceTab = {
      id,
      title: fullTitle,
      kind,
      leftPath,
      rightPath,
      basePath,
      ...extra,
    };
    setTabs([...tabs, nextTab]);
    setActiveTabId(id);
  };

  const updateTabTitle = (tabId: string, newTitle: string) => {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx !== -1 && tabs[idx].title !== newTitle) {
      setTabs(idx, "title", newTitle);
    }
  };

  const collectWindowGeometry = (immediate = false) => {
    const w = Math.max(640, window.outerWidth || window.innerWidth || 1440);
    const h = Math.max(480, window.outerHeight || window.innerHeight || 900);
    const x = typeof window.screenX === "number" ? window.screenX : 0;
    const y = typeof window.screenY === "number" ? window.screenY : 0;
    const availW = window.screen?.availWidth || 1920;
    const availH = window.screen?.availHeight || 1080;
    const maximized = w >= availW - 16 && h >= availH - 32;
    return {
      immediate,
      window_width: w,
      window_height: h,
      window_x: x,
      window_y: y,
      window_maximized: maximized,
    };
  };

  onMount(async () => {
    let lastGeomKey = "";
    const syncWindowGeometry = () => {
      const geom = collectWindowGeometry(false);
      const key = `${geom.window_width}x${geom.window_height}@${geom.window_x},${geom.window_y}:${geom.window_maximized}`;
      if (key !== lastGeomKey) {
        lastGeomKey = key;
        callRustRpc("update_user_preferences", geom).catch(() => {});
      }
    };

    const heartbeatTimer = window.setInterval(() => {
      fetch("/api/heartbeat", { method: "POST" }).catch(() => {});
      syncWindowGeometry();
    }, 1500);

    let resizeDebounce: number | undefined;
    const handleResize = () => {
      if (resizeDebounce) window.clearTimeout(resizeDebounce);
      resizeDebounce = window.setTimeout(syncWindowGeometry, 250);
    };
    window.addEventListener("resize", handleResize);

    const handleGlobalShortcuts = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setShowSettings((v) => !v);
      }
    };
    window.addEventListener("keydown", handleGlobalShortcuts);

    const handlePageHide = () => {
      const payload = JSON.stringify(collectWindowGeometry(false));
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/shutdown", payload);
      } else {
        fetch("/api/shutdown", {
          method: "POST",
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    };
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handlePageHide);

    const prefs = await callRustRpc<UserPreferencesDto>("get_user_preferences");
    if (prefs?.theme === "light" || prefs?.theme === "dark") {
      setTheme(prefs.theme);
    }
    if (prefs?.language === "zh-CN" || prefs?.language === "en-US") {
      setLocale(prefs.language, false);
    }
    if (prefs && !prefs.window_maximized) {
      try {
        if (prefs.window_width >= 640 && prefs.window_height >= 480) {
          window.resizeTo(prefs.window_width, prefs.window_height);
        }
        if (prefs.window_x !== null && prefs.window_y !== null) {
          window.moveTo(prefs.window_x, prefs.window_y);
        }
      } catch {
        // Ignore if browser security restricts window.moveTo/resizeTo
      }
    }

    const startup = await callRustRpc<StartupLaunchSessionDto | null>(
      "get_startup_session"
    );
    if (startup && startup.kind) {
      const extra: Partial<WorkspaceTab> = {
        outputPath: startup.output_path ?? undefined,
        titles: startup.titles,
        readonly: startup.readonly,
        expandAll: startup.expand_all,
        filters: startup.filters,
        reviewMode: startup.review_mode,
      };
      if (startup.kind === "folder_compare") {
        launchSession(
          "folder",
          startup.title,
          startup.left_path || undefined,
          startup.right_path || undefined,
          undefined,
          extra
        );
      } else if (startup.kind === "two_way_text") {
        launchSession(
          "two_way",
          startup.title,
          startup.left_path || undefined,
          startup.right_path || undefined,
          undefined,
          extra
        );
      } else if (startup.kind === "three_way_merge") {
        launchSession(
          "three_way",
          startup.title,
          startup.left_path || undefined,
          startup.right_path || undefined,
          startup.base_path ?? undefined,
          extra
        );
      }
    }

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

      if (e.key === "Escape") {
        const tab = activeTab();
        const inReview = Boolean(
          tab?.reviewMode ||
          tab?.titles?.[0]?.includes("当前文件") ||
          tab?.titles?.[1]?.includes("AI 拟修改") ||
          tab?.title?.includes("AI 拟修改")
        );
        if (inReview) {
          e.preventDefault();
          if (e.shiftKey) {
            handleRejectActiveSession();
          } else {
            handleApproveActiveSession();
          }
        }
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);

    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
      window.clearInterval(heartbeatTimer);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handlePageHide);
    };
  });

  const closeTab = (id: string, e: MouseEvent) => {
    e.stopPropagation();
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const filtered = tabs.filter((t) => t.id !== id);
    setTabs(filtered);
    if (activeTabId() === id) {
      const nextActive = filtered[Math.max(0, idx - 1)];
      setActiveTabId(nextActive.id);
    }
  };

  /**
   * Handles Beyond Compare's signature `Esc` / `Ctrl+W` / `q` action:
   * - If the user opened a child file tab from Folder Compare (`git difftool -d`), close the child tab and return to the Folder Compare tab!
   * - Otherwise (e.g. single-file `git difftool` or top-level window), immediately terminate `fcompare` so Git launches the next changed file!
   */
  const handleCloseOrExitActiveSession = async () => {
    const current = activeTab();
    // If there is a parent Folder Compare tab and we are inside a Two-Way file tab opened from it, pop back to Folder tab
    const folderTab = tabs.find((t) => t.kind === "folder");
    if (current.kind === "two_way" && folderTab && tabs.length > 2) {
      const filtered = tabs.filter((t) => t.id !== current.id);
      setTabs(filtered);
      setActiveTabId(folderTab.id);
      return;
    }

    // Otherwise exit the process & close window immediately (saving window geometry in the same call) so `git difftool` advances to the next file!
    await fetch("/api/shutdown", {
      method: "POST",
      body: JSON.stringify(collectWindowGeometry(true)),
    }).catch(() => {});
    window.close();
  };

  const handleApproveActiveSession = async () => {
    await callRustRpc("set_process_exit_code", { code: 0 });
    await fetch("/api/shutdown", {
      method: "POST",
      body: JSON.stringify(collectWindowGeometry(true)),
    }).catch(() => {});
    window.close();
  };

  const handleRejectActiveSession = async () => {
    await callRustRpc("set_process_exit_code", { code: 1 });
    await fetch("/api/shutdown", {
      method: "POST",
      body: JSON.stringify(collectWindowGeometry(true)),
    }).catch(() => {});
    window.close();
  };

  const isReviewActive = createMemo(() => {
    const tab = activeTab();
    if (!tab) return false;
    if (tab.reviewMode) return true;
    const t0 = tab.titles?.[0] ?? "";
    const t1 = tab.titles?.[1] ?? "";
    const title = tab.title ?? "";
    const lp = tab.leftPath ?? "";
    const rp = tab.rightPath ?? "";
    return (
      title.includes("AI 拟修改") ||
      title.includes("Proposed") ||
      title.includes("当前文件") ||
      t0.includes("当前文件") ||
      t1.includes("AI 拟修改") ||
      lp.includes("fcompare-guard") ||
      rp.includes("fcompare-guard") ||
      lp.includes("CURRENT_") ||
      rp.includes("PROPOSED_")
    );
  });

  const activeTabDisplayTitle = createMemo(() => {
    const tab = activeTab();
    if (!tab) return "";
    return tab.id === "tab-home" ? t("header.new_session") : tab.title;
  });

  createEffect(() => {
    const cur = activeTabDisplayTitle();
    document.title = cur ? `${cur} — FreeCompare` : "FreeCompare";
  });

  return (
    <div class={`app-root theme-${theme()}`}>
      {/* Unified Top Tabbar: No redundant brand-logo, no extra stacked bar */}
      <header class="app-tabbar">
        <div class="tabs-scroll-strip">
          <For each={tabs}>
            {(tab) => (
              <div
                class={`workspace-tab ${activeTabId() === tab.id ? "active" : ""}`}
                onClick={() => setActiveTabId(tab.id)}
                title={tab.id === "tab-home" ? t("header.new_session") : tab.title}
              >
                <span class="tab-title">
                  {tab.id === "tab-home" ? `🏠 ${t("header.new_session")}` : tab.title}
                </span>
                {tab.id !== "tab-home" && (
                  <button
                    class="tab-close-btn"
                    onClick={(e) => closeTab(tab.id, e)}
                    title={t("header.close_tab")}
                  >
                    ×
                  </button>
                )}
              </div>
            )}
          </For>
          <button
            class="new-tab-plus-btn"
            onClick={() => launchSession("two_way", t("header.new_tab_title", { id: tabCounter }))}
            title={t("header.new_tab_tooltip")}
          >
            +
          </button>
        </div>

        <div class="app-header-right">
          <Show when={isReviewActive()}>
            <div class="header-review-group">
              <span class="header-review-tag">{t("header.review_mode")}</span>
              <button
                class="header-review-btn approve"
                onClick={handleApproveActiveSession}
                title={t("header.approve_tooltip")}
              >
                {t("header.approve")}
              </button>
              <button
                class="header-review-btn reject"
                onClick={handleRejectActiveSession}
                title={t("header.reject_tooltip")}
              >
                {t("header.reject")}
              </button>
            </div>
          </Show>

          <button
            class="header-mini-btn"
            onClick={toggleLocale}
            title={t("header.lang_tooltip")}
          >
            {currentLocale() === "zh-CN" ? "中" : "EN"}
          </button>
          <button
            class="header-mini-btn"
            onClick={() => {
              const next = theme() === "dark" ? "light" : "dark";
              setTheme(next);
              callRustRpc("update_user_preferences", { theme: next }).catch(() => {});
            }}
            title={theme() === "dark" ? t("header.theme_dark") : t("header.theme_light")}
          >
            {theme() === "dark" ? "🌙" : "☀️"}
          </button>
          <button
            class="header-mini-btn"
            onClick={() => setShowSettings(true)}
            title={t("header.settings_tooltip")}
          >
            ⚙️
          </button>
          <button
            class="header-mini-btn"
            onClick={() => setShowAbout(true)}
            title={t("header.about_tooltip")}
          >
            ℹ️
          </button>
        </div>
      </header>

      <main class="app-main-stage">
        <For each={tabs}>
          {(tab) => (
            <div
              class="tab-content-wrapper"
              style={{
                display: tab.id === activeTabId() ? "contents" : "none",
              }}
            >
              <Show when={tab.kind === "home"}>
                <HomeView
                  onLaunchSession={(kind, title, l, r, b) =>
                    launchSession(kind, title, l, r, b)
                  }
                />
              </Show>
              <Show when={tab.kind === "two_way"}>
                <TextDiffView
                  sessionId={tab.id}
                  isActive={tab.id === activeTabId()}
                  initialLeftPath={tab.leftPath}
                  initialRightPath={tab.rightPath}
                  leftTitle={tab.titles?.[0] ?? undefined}
                  rightTitle={tab.titles?.[1] ?? undefined}
                  leftReadonly={tab.readonly?.[0]}
                  rightReadonly={tab.readonly?.[1]}
                  siblingFiles={tab.siblingFiles}
                  reviewMode={tab.reviewMode}
                  onCloseOrExit={handleCloseOrExitActiveSession}
                  onUpdateTabTitle={(newTitle) => {
                    const full = newTitle.startsWith("⇄ ") ? newTitle : "⇄ " + newTitle;
                    updateTabTitle(tab.id, full);
                  }}
                />
              </Show>
              <Show when={tab.kind === "folder"}>
                <FolderDiffView
                  isActive={tab.id === activeTabId()}
                  initialLeftDir={tab.leftPath}
                  initialRightDir={tab.rightPath}
                  expandAll={tab.expandAll}
                  onCloseOrExit={handleCloseOrExitActiveSession}
                  onOpenFileDiff={(leftFullPath, rightFullPath, relPath, siblingFiles) =>
                    launchSession(
                      "two_way",
                      relPath.split("/").pop() ?? relPath,
                      leftFullPath,
                      rightFullPath,
                      undefined,
                      { siblingFiles }
                    )
                  }
                  onOpenFolderDiff={(leftFullPath, rightFullPath, relPath) =>
                    launchSession(
                      "folder",
                      relPath.split("/").pop() ?? relPath,
                      leftFullPath,
                      rightFullPath
                    )
                  }
                  onUpdateTabTitle={(newTitle) => {
                    const full = newTitle.startsWith("📁 ") ? newTitle : "📁 " + newTitle;
                    updateTabTitle(tab.id, full);
                  }}
                />
              </Show>
              <Show when={tab.kind === "three_way"}>
                <Merge3WayView
                  sessionId={tab.id}
                  isActive={tab.id === activeTabId()}
                  initialLeftPath={tab.leftPath}
                  initialBasePath={tab.basePath}
                  initialRightPath={tab.rightPath}
                  initialOutputPath={tab.outputPath}
                  titles={tab.titles}
                  onCloseOrExit={handleCloseOrExitActiveSession}
                  onUpdateTabTitle={(newTitle) => {
                    const full = newTitle.startsWith("⑃ ") ? newTitle : "⑃ " + newTitle;
                    updateTabTitle(tab.id, full);
                  }}
                />
              </Show>
            </div>
          )}
        </For>
      </main>

      <Show when={showSettings()}>
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onPreferencesUpdated={(p) => {
            if (p.theme === "dark" || p.theme === "light") {
              setTheme(p.theme);
            }
          }}
        />
      </Show>

      <Show when={showAbout()}>
        <AboutModal onClose={() => setShowAbout(false)} />
      </Show>
    </div>
  );
};
