import { Component, createSignal, For, onMount, Show } from "solid-js";
import { callRustRpc, SessionRecordDto } from "../bridge";
import { SessionTabKind } from "../types";

interface HomeViewProps {
  onLaunchSession: (
    kind: SessionTabKind,
    title: string,
    leftPath?: string,
    rightPath?: string,
    basePath?: string
  ) => void;
}

export const HomeView: Component<HomeViewProps> = (props) => {
  const [recentRecords, setRecentRecords] = createSignal<SessionRecordDto[]>([]);

  const loadRecent = async () => {
    const records = await callRustRpc<SessionRecordDto[]>("get_recent_sessions");
    if (records) {
      setRecentRecords(records);
    }
  };

  onMount(() => {
    loadRecent();
  });

  const handleClearRecent = async () => {
    await callRustRpc("clear_recent_sessions");
    setRecentRecords([]);
  };

  return (
    <div class="home-dashboard">
      <div class="home-hero">
        <div class="hero-badge">FreeCompare Desktop — Cross-Platform Diff & Merge</div>
        <h1>新建比较会话 (New Session)</h1>
        <p>
          点击下方卡片新建空白比较视图（支持直接粘贴文本或浏览选择本地文件/目录），或通过命令行{" "}
          <code>fcompare left/ right/</code> 直接唤起。
        </p>
      </div>

      {/* Primary Session Cards */}
      <div class="session-cards-grid">
        <div
          class="session-card card-text"
          onClick={() => props.onLaunchSession("two_way", "文本比较 (Text Compare)")}
        >
          <div class="card-icon">⇄</div>
          <h3>文本比较 (Text Compare)</h3>
          <p>
            新建空白双栏文本比较视图：可直接按 <kbd>Ctrl+V</kbd> 粘贴剪贴板文字对比，也可点击浏览选择本地文件对比与双向合并。
          </p>
          <span class="card-action-link">新建空白文本比较 →</span>
        </div>

        <div
          class="session-card card-folder"
          onClick={() => props.onLaunchSession("folder", "文件夹比较 (Folder Compare)")}
        >
          <div class="card-icon">📁</div>
          <h3>文件夹比较 (Folder Compare)</h3>
          <p>
            新建文件夹比较与同步视图：浏览选择两个本地目录进行 BLAKE3 哈希或时间戳比对，支持过滤、左右复制同步与双击文件穿透对比。
          </p>
          <span class="card-action-link">新建文件夹比较 →</span>
        </div>

        <div
          class="session-card card-merge"
          onClick={() => props.onLaunchSession("three_way", "文本合并 (Text Merge)")}
        >
          <div class="card-icon">⑃</div>
          <h3>文本合并 (3-Way Text Merge)</h3>
          <p>
            新建三向合并视图（Left / Base / Right + Output）：选择三个分支文件自动合并非冲突块，支持一键解决冲突并保存输出。
          </p>
          <span class="card-action-link">新建三向合并 →</span>
        </div>
      </div>

      {/* Real Recent Saved Sessions */}
      <div class="recent-sessions-panel">
        <div
          style={{
            display: "flex",
            "justify-content": "space-between",
            "align-items": "center",
            "margin-bottom": "12px",
          }}
        >
          <h4>🕘 历史对比会话记录 (Recent Sessions)</h4>
          <Show when={recentRecords().length > 0}>
            <button class="bc-tool-btn" onClick={handleClearRecent}>
              清空历史记录
            </button>
          </Show>
        </div>

        <Show
          when={recentRecords().length > 0}
          fallback={
            <div class="recent-item" style={{ cursor: "default", opacity: 0.7 }}>
              <span>暂无历史会话记录。当您对比过本地文件或文件夹后，会自动保存在此处方便一键恢复。</span>
            </div>
          }
        >
          <div class="recent-list">
            <For each={recentRecords()}>
              {(r) => {
                const kind: SessionTabKind =
                  r.kind === "folder_compare"
                    ? "folder"
                    : r.kind === "three_way_merge"
                    ? "three_way"
                    : "two_way";
                const badge =
                  kind === "folder"
                    ? "文件夹比较"
                    : kind === "three_way"
                    ? "三向合并"
                    : "文本比较";
                return (
                  <div
                    class="recent-item"
                    onClick={() =>
                      props.onLaunchSession(
                        kind,
                        r.title,
                        r.left_path,
                        r.right_path,
                        r.base_path ?? undefined
                      )
                    }
                  >
                    <span class={`recent-badge kind-${kind}`}>{badge}</span>
                    <div class="recent-meta">
                      <strong>{r.title}</strong>
                      <span>
                        {r.left_path} ↔ {r.right_path}
                      </span>
                    </div>
                    <button class="recent-open-btn">重新打开</button>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};
