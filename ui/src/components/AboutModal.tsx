import { Component, createSignal, onMount, Show } from "solid-js";
import { AppInfoDto, callRustRpc } from "../bridge";
import { t } from "../i18n";

interface AboutModalProps {
  onClose: () => void;
}

export const AboutModal: Component<AboutModalProps> = (props) => {
  const [appInfo, setAppInfo] = createSignal<AppInfoDto | null>(null);
  const [toast, setToast] = createSignal<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  onMount(async () => {
    const info = await callRustRpc<AppInfoDto>("get_app_info");
    if (info) {
      setAppInfo(info);
    }
  });

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${t("common.copied")} ${label}`);
    } catch {
      showToast(t("common.copy_failed"));
    }
  };

  const copyAllInfo = async () => {
    const info = appInfo();
    if (!info) return;
    const text = [
      `Application: ${info.name}`,
      `Version: v${info.version}`,
      `Git Commit: ${info.git_hash}${info.git_dirty ? " (dirty)" : ""}`,
      `Binary Executable: ${info.binary_path}`,
      `Target Triple: ${info.target_triple}`,
      `Build Profile: ${info.build_profile}`,
    ].join("\n");
    await copyText(text, t("about.copied_all"));
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      props.onClose();
    }
  };

  return (
    <div
      class="modal-backdrop"
      onClick={props.onClose}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      ref={(el) => setTimeout(() => el?.focus(), 50)}
    >
      <div
        class="file-browser-dialog about-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <div class="about-header-title">
            <span class="about-header-icon">⚡</span>
            <strong>{t("about.modal_title")}</strong>
            <Show when={appInfo()}>
              {(info) => (
                <span class="about-version-badge">v{info().version}</span>
              )}
            </Show>
          </div>
          <button
            class="modal-close-btn"
            onClick={props.onClose}
            title={t("about.close")}
          >
            ×
          </button>
        </div>

        <div class="about-modal-body">
          <div class="about-hero-section">
            <div class="about-hero-icon">⚡</div>
            <div class="about-hero-title">{t("about.app_title")}</div>
            <div class="about-hero-subtitle">
              {t("about.subtitle")}
            </div>
          </div>

          <Show
            when={appInfo()}
            fallback={<div class="about-loading">{t("about.loading")}</div>}
          >
            {(info) => (
              <div class="about-info-table">
                <div class="about-info-row">
                  <span class="about-label">{t("about.version")}</span>
                  <div class="about-val-group">
                    <span class="about-val-text font-bold">
                      v{info().version}
                    </span>
                    <span class="about-tag">
                      {info().build_profile === "release"
                        ? t("about.release")
                        : t("about.debug")}
                    </span>
                  </div>
                </div>

                <div class="about-info-row">
                  <span class="about-label">{t("about.git_hash")}</span>
                  <div class="about-val-group">
                    <code class="about-code-block" title={info().git_hash}>
                      {info().git_hash_short}
                    </code>
                    <button
                      class="about-copy-btn"
                      onClick={() => copyText(info().git_hash, t("about.copied_hash"))}
                      title={t("about.copy_hash")}
                    >
                      {t("about.copy_hash")}
                    </button>
                    <Show when={info().git_dirty}>
                      <span class="about-dirty-tag" title={t("about.dirty_title")}>
                        {t("about.dirty_badge")}
                      </span>
                    </Show>
                  </div>
                </div>

                <div class="about-info-row full-width">
                  <span class="about-label">{t("about.full_commit")}</span>
                  <div class="about-val-group">
                    <code class="about-code-block select-all">
                      {info().git_hash}
                    </code>
                  </div>
                </div>

                <div class="about-info-row full-width">
                  <span class="about-label">
                    {t("about.binary_path")}
                  </span>
                  <div class="about-val-group">
                    <code
                      class="about-code-block binary-path-block select-all"
                      title={info().binary_path}
                    >
                      {info().binary_path}
                    </code>
                    <button
                      class="about-copy-btn"
                      onClick={() =>
                        copyText(info().binary_path, t("about.copied_path"))
                      }
                      title={t("about.copy_path")}
                    >
                      {t("about.copy_path")}
                    </button>
                  </div>
                </div>

                <div class="about-info-row">
                  <span class="about-label">{t("about.target_arch")}</span>
                  <div class="about-val-group">
                    <span class="about-val-text font-mono">
                      {info().target_triple}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </Show>
        </div>

        <div class="about-modal-footer">
          <Show when={toast()}>
            <span class="about-toast-msg">✅ {toast()}</span>
          </Show>
          <div class="about-footer-spacer" />
          <button
            class="modal-select-btn"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--border-color)", color: "var(--text-primary)" }}
            onClick={copyAllInfo}
            title={t("about.copy_all_tooltip")}
          >
            {t("about.copy_all")}
          </button>
          <button class="modal-select-btn" onClick={props.onClose}>
            {t("about.close")}
          </button>
        </div>
      </div>
    </div>
  );
};
