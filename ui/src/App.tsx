import { Component, createSignal, For, Match, onMount, Switch } from "solid-js";
import { callRustRpc, StartupLaunchSessionDto } from "./bridge";
import { SessionTabKind, WorkspaceTab } from "./types";
import { HomeView } from "./views/HomeView";
import { TextDiffView } from "./views/TextDiffView";
import { FolderDiffView } from "./views/FolderDiffView";
import { Merge3WayView } from "./views/Merge3WayView";

export const App: Component = () => {
  const [theme, setTheme] = createSignal<"dark" | "light">("dark");
  // Start cleanly on the Home tab without any pre-populated fake demo tabs!
  const [tabs, setTabs] = createSignal<WorkspaceTab[]>([
    { id: "tab-home", title: "🏠 新建会话", kind: "home" },
  ]);

  const [activeTabId, setActiveTabId] = createSignal<string>("tab-home");
  let tabCounter = 1;

  const launchSession = (
    kind: SessionTabKind,
    title: string,
    leftPath?: string,
    rightPath?: string,
    basePath?: string
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
    const nextTab: WorkspaceTab = {
      id,
      title: prefix + title,
      kind,
      leftPath,
      rightPath,
      basePath,
    };
    setTabs((prev) => [...prev, nextTab]);
    setActiveTabId(id);
  };

  onMount(async () => {
    const heartbeatTimer = window.setInterval(() => {
      fetch("/api/heartbeat", { method: "POST" }).catch(() => {});
    }, 1500);

    const handlePageHide = () => {
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/shutdown", "bye");
      } else {
        fetch("/api/shutdown", { method: "POST", keepalive: true }).catch(() => {});
      }
    };
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handlePageHide);

    const startup = await callRustRpc<StartupLaunchSessionDto | null>(
      "get_startup_session"
    );
    if (startup && startup.kind) {
      if (startup.kind === "folder_compare") {
        launchSession("folder", startup.title, startup.left_path, startup.right_path);
      } else if (startup.kind === "two_way_text") {
        launchSession("two_way", startup.title, startup.left_path, startup.right_path);
      } else if (startup.kind === "three_way_merge") {
        launchSession(
          "three_way",
          startup.title,
          startup.left_path,
          startup.right_path,
          startup.base_path ?? undefined
        );
      }
    }

    return () => {
      window.clearInterval(heartbeatTimer);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handlePageHide);
    };
  });

  const closeTab = (id: string, e: MouseEvent) => {
    e.stopPropagation();
    const list = tabs();
    if (list.length <= 1) return;
    const idx = list.findIndex((t) => t.id === id);
    const filtered = list.filter((t) => t.id !== id);
    setTabs(filtered);
    if (activeTabId() === id) {
      const nextActive = filtered[Math.max(0, idx - 1)];
      setActiveTabId(nextActive.id);
    }
  };

  const activeTab = () => tabs().find((t) => t.id === activeTabId()) ?? tabs()[0];

  return (
    <div class={`app-root theme-${theme()}`}>
      <header class="app-tabbar">
        <div
          class="brand-logo"
          onClick={() => setActiveTabId("tab-home")}
          title="返回新建会话主页"
        >
          <span class="brand-icon">⚡</span>
          <span class="brand-text">FreeCompare</span>
        </div>

        <div class="tabs-scroll-strip">
          <For each={tabs()}>
            {(tab) => (
              <div
                class={`workspace-tab ${activeTabId() === tab.id ? "active" : ""}`}
                onClick={() => setActiveTabId(tab.id)}
              >
                <span class="tab-title">{tab.title}</span>
                {tab.id !== "tab-home" && (
                  <button
                    class="tab-close-btn"
                    onClick={(e) => closeTab(tab.id, e)}
                    title="关闭标签页"
                  >
                    ×
                  </button>
                )}
              </div>
            )}
          </For>
          <button
            class="new-tab-plus-btn"
            onClick={() => launchSession("two_way", `文本比较 #${tabCounter}`)}
            title="新建空白文本比较标签页"
          >
            +
          </button>
        </div>

        <div class="app-header-right">
          <span class="shortcut-hint">
            Ctrl+V 粘贴 · Ctrl+A 全选单侧 · Ctrl+C 拷出 · Alt+↑/↓ 跳差异
          </span>
          <button
            class="theme-toggle-btn"
            onClick={() => setTheme(theme() === "dark" ? "light" : "dark")}
          >
            {theme() === "dark" ? "☀️ 浅色主题" : "🌙 深色主题"}
          </button>
        </div>
      </header>

      <main class="app-main-stage">
        <Switch>
          <Match when={activeTab().kind === "home"}>
            <HomeView
              onLaunchSession={(kind, title, l, r, b) =>
                launchSession(kind, title, l, r, b)
              }
            />
          </Match>
          <Match when={activeTab().kind === "two_way"}>
            <TextDiffView
              sessionId={activeTab().id}
              initialLeftPath={activeTab().leftPath}
              initialRightPath={activeTab().rightPath}
            />
          </Match>
          <Match when={activeTab().kind === "folder"}>
            <FolderDiffView
              initialLeftDir={activeTab().leftPath}
              initialRightDir={activeTab().rightPath}
              onOpenFileDiff={(leftFullPath, rightFullPath, relPath) =>
                launchSession(
                  "two_way",
                  relPath.split("/").pop() ?? relPath,
                  leftFullPath,
                  rightFullPath
                )
              }
            />
          </Match>
          <Match when={activeTab().kind === "three_way"}>
            <Merge3WayView
              sessionId={activeTab().id}
              initialLeftPath={activeTab().leftPath}
              initialBasePath={activeTab().basePath}
              initialRightPath={activeTab().rightPath}
            />
          </Match>
        </Switch>
      </main>
    </div>
  );
};
