import { Component, createSignal, For, onMount, Show } from "solid-js";
import { callRustRpc, SessionRecordDto } from "../bridge";
import { SessionTabKind } from "../types";
import { t } from "../i18n";

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
        <div class="hero-badge">{t("home.badge")}</div>
        <h1>{t("home.title")}</h1>
        <p>{t("home.subtitle")}</p>
      </div>

      {/* Primary Session Cards */}
      <div class="session-cards-grid">
        <div
          class="session-card card-text"
          onClick={() => props.onLaunchSession("two_way", t("home.card_text_title"))}
        >
          <div class="card-icon">⇄</div>
          <h3>{t("home.card_text_title")}</h3>
          <p>{t("home.card_text_desc")}</p>
          <span class="card-action-link">{t("home.card_text_action")}</span>
        </div>

        <div
          class="session-card card-folder"
          onClick={() => props.onLaunchSession("folder", t("home.card_folder_title"))}
        >
          <div class="card-icon">📁</div>
          <h3>{t("home.card_folder_title")}</h3>
          <p>{t("home.card_folder_desc")}</p>
          <span class="card-action-link">{t("home.card_folder_action")}</span>
        </div>

        <div
          class="session-card card-merge"
          onClick={() => props.onLaunchSession("three_way", t("home.card_merge_title"))}
        >
          <div class="card-icon">⑃</div>
          <h3>{t("home.card_merge_title")}</h3>
          <p>{t("home.card_merge_desc")}</p>
          <span class="card-action-link">{t("home.card_merge_action")}</span>
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
          <h4>{t("home.recent_title")}</h4>
          <Show when={(recentRecords()?.length ?? 0) > 0}>
            <button class="bc-tool-btn" onClick={handleClearRecent}>
              {t("home.clear_history")}
            </button>
          </Show>
        </div>

        <Show
          when={(recentRecords()?.length ?? 0) > 0}
          fallback={
            <div class="recent-item" style={{ cursor: "default", opacity: 0.7 }}>
              <span>{t("home.empty_recent")}</span>
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
                    ? t("home.card_folder_title")
                    : kind === "three_way"
                    ? t("home.card_merge_title")
                    : t("home.card_text_title");
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
                    <button class="recent-open-btn">{t("home.reopen")}</button>
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
