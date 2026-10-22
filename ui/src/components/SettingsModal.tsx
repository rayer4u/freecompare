import { Component, createSignal, For, onMount, Show } from "solid-js";
import { AppInfoDto, callRustRpc, UserPreferencesDto } from "../bridge";
import { currentLocale, setLocale, t } from "../i18n";

interface SettingsModalProps {
  onClose: () => void;
  onPreferencesUpdated: (prefs: UserPreferencesDto) => void;
}

export const SettingsModal: Component<SettingsModalProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<"editor" | "diff" | "folder" | "git" | "about">("editor");
  const [prefs, setPrefs] = createSignal<UserPreferencesDto | null>(null);
  const [appInfo, setAppInfo] = createSignal<AppInfoDto | null>(null);
  const [globsInput, setGlobsInput] = createSignal("");
  const [toast, setToast] = createSignal<string | null>(null);

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  onMount(async () => {
    const data = await callRustRpc<UserPreferencesDto>("get_user_preferences");
    if (data) {
      setPrefs(data);
      setGlobsInput((data.folder_exclude_globs || []).join(", "));
    }
    const info = await callRustRpc<AppInfoDto>("get_app_info");
    if (info) {
      setAppInfo(info);
    }
  });

  const updateField = async <K extends keyof UserPreferencesDto>(key: K, val: UserPreferencesDto[K]) => {
    const cur = prefs();
    if (!cur) return;
    const next = { ...cur, [key]: val };
    setPrefs(next);
    const updated = await callRustRpc<UserPreferencesDto>("update_user_preferences", { [key]: val });
    if (updated) {
      props.onPreferencesUpdated(updated);
    }
  };

  const saveGlobs = async () => {
    const parsed = globsInput()
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    await updateField("folder_exclude_globs", parsed);
    notify(t("settings.globs_saved"));
  };

  const handleInstallGit = async () => {
    const res = await callRustRpc<{ success: boolean; scope: string; exe: string }>(
      "install_git_integration"
    );
    if (res?.success) {
      notify(t("settings.git_success", { scope: res.scope }));
    } else {
      notify(t("settings.git_fail"));
    }
  };

  const handleClearHistory = async () => {
    if (!window.confirm(t("settings.clear_history_confirm"))) return;
    await callRustRpc("clear_recent_sessions");
    await updateField("recent_left_paths", []);
    await updateField("recent_right_paths", []);
    await updateField("recent_folder_paths", []);
    notify(t("settings.clear_history_done"));
  };

  const handleResetDefaults = async () => {
    if (!window.confirm(t("settings.reset_confirm"))) return;
    const res = await callRustRpc<UserPreferencesDto>("reset_user_preferences");
    if (res) {
      setPrefs(res);
      setGlobsInput((res.folder_exclude_globs || []).join(", "));
      props.onPreferencesUpdated(res);
      notify(t("settings.reset_done"));
    }
  };

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div
        class="file-browser-dialog"
        style={{ "max-width": "700px", "max-height": "85vh", display: "flex", "flex-direction": "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <strong>{t("settings.modal_title")}</strong>
          <button class="modal-close-btn" onClick={props.onClose} title={t("common.close")}>
            ×
          </button>
        </div>

        <div style={{ display: "flex", flex: "1", "min-height": "0", "border-bottom": "1px solid var(--border-color)" }}>
          {/* Left Navigation Menu */}
          <div
            style={{
              width: "160px",
              "border-right": "1px solid var(--border-color)",
              background: "var(--bg-panel)",
              padding: "8px 0",
              display: "flex",
              "flex-direction": "column",
              gap: "4px",
            }}
          >
            <button
              class={`settings-nav-btn ${activeTab() === "editor" ? "active" : ""}`}
              onClick={() => setActiveTab("editor")}
            >
              {t("settings.tab_editor")}
            </button>
            <button
              class={`settings-nav-btn ${activeTab() === "diff" ? "active" : ""}`}
              onClick={() => setActiveTab("diff")}
            >
              {t("settings.tab_diff")}
            </button>
            <button
              class={`settings-nav-btn ${activeTab() === "folder" ? "active" : ""}`}
              onClick={() => setActiveTab("folder")}
            >
              {t("settings.tab_folder")}
            </button>
            <button
              class={`settings-nav-btn ${activeTab() === "git" ? "active" : ""}`}
              onClick={() => setActiveTab("git")}
            >
              {t("settings.tab_git")}
            </button>
            <button
              class={`settings-nav-btn ${activeTab() === "about" ? "active" : ""}`}
              onClick={() => setActiveTab("about")}
            >
              {t("settings.tab_about")}
            </button>
          </div>

          {/* Right Setting Body */}
          <div style={{ flex: "1", padding: "16px 20px", "overflow-y": "auto" }}>
            <Show when={prefs()}>
              {(p) => (
                <>
                  {/* Tab 1: Editor & Appearance */}
                  <Show when={activeTab() === "editor"}>
                    <div class="settings-group">
                      <h4 class="settings-title">{t("settings.language_title")}</h4>
                      <p style={{ "font-size": "12px", opacity: "0.8", "margin-bottom": "8px" }}>
                        {t("settings.language_desc")}
                      </p>
                      <div class="settings-pill-group" style={{ "margin-bottom": "16px" }}>
                        <button
                          class={`mini-btn ${currentLocale() === "zh-CN" ? "active" : ""}`}
                          onClick={() => {
                            setLocale("zh-CN");
                            updateField("language", "zh-CN");
                          }}
                        >
                          {t("settings.lang_zh")}
                        </button>
                        <button
                          class={`mini-btn ${currentLocale() === "en-US" ? "active" : ""}`}
                          onClick={() => {
                            setLocale("en-US");
                            updateField("language", "en-US");
                          }}
                        >
                          {t("settings.lang_en")}
                        </button>
                      </div>

                      <h4 class="settings-title">{t("settings.theme_title")}</h4>
                      <div class="settings-row">
                        <span>{t("settings.theme_title")}</span>
                        <div class="settings-pill-group">
                          <button
                            class={`mini-btn ${p().theme === "dark" ? "active" : ""}`}
                            onClick={() => updateField("theme", "dark")}
                          >
                            {t("settings.theme_dark")}
                          </button>
                          <button
                            class={`mini-btn ${p().theme === "light" ? "active" : ""}`}
                            onClick={() => updateField("theme", "light")}
                          >
                            {t("settings.theme_light")}
                          </button>
                        </div>
                      </div>

                      <div class="settings-row">
                        <span>{t("settings.font_size")} ({p().editor_font_size || 13}px)</span>
                        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                          <input
                            type="range"
                            min="10"
                            max="24"
                            value={p().editor_font_size || 13}
                            onInput={(e) => updateField("editor_font_size", Number(e.currentTarget.value))}
                          />
                          <span style={{ "font-family": "monospace", "min-width": "36px" }}>
                            {p().editor_font_size || 13}px
                          </span>
                        </div>
                      </div>

                      <div class="settings-row">
                        <span>{t("settings.tab_width")}</span>
                        <select
                          class="settings-select"
                          value={p().tab_width || 4}
                          onChange={(e) => updateField("tab_width", Number(e.currentTarget.value))}
                        >
                          <option value="2">2</option>
                          <option value="4">4</option>
                          <option value="8">8</option>
                        </select>
                      </div>

                      <div class="settings-row">
                        <span>{t("settings.show_whitespace")}</span>
                        <input
                          type="checkbox"
                          checked={p().show_whitespace_glyphs}
                          onChange={(e) => updateField("show_whitespace_glyphs", e.currentTarget.checked)}
                        />
                      </div>

                      <div class="settings-row">
                        <span>{t("settings.line_inspector")}</span>
                        <input
                          type="checkbox"
                          checked={p().show_line_inspector}
                          onChange={(e) => updateField("show_line_inspector", e.currentTarget.checked)}
                        />
                      </div>
                    </div>
                  </Show>

                  {/* Tab 2: Diff & Navigation */}
                  <Show when={activeTab() === "diff"}>
                    <div class="settings-group">
                      <h4 class="settings-title">{t("settings.tab_diff")}</h4>
                      <div class="settings-row">
                        <span>{t("settings.auto_jump")}</span>
                        <input
                          type="checkbox"
                          checked={p().auto_jump_first_diff}
                          onChange={(e) => updateField("auto_jump_first_diff", e.currentTarget.checked)}
                        />
                      </div>

                      <div class="settings-row">
                        <span>{t("settings.wrap_around")}</span>
                        <input
                          type="checkbox"
                          checked={p().wrap_around_navigation}
                          onChange={(e) => updateField("wrap_around_navigation", e.currentTarget.checked)}
                        />
                      </div>

                      <div class="settings-row">
                        <span>{t("settings.confirm_exit_dirty")}</span>
                        <input
                          type="checkbox"
                          checked={p().confirm_before_exit_dirty}
                          onChange={(e) => updateField("confirm_before_exit_dirty", e.currentTarget.checked)}
                        />
                      </div>

                      <div class="settings-row">
                        <span>{t("text_diff.ignore_whitespace_tip")}</span>
                        <input
                          type="checkbox"
                          checked={p().ignore_whitespace}
                          onChange={(e) => updateField("ignore_whitespace", e.currentTarget.checked)}
                        />
                      </div>

                      <div class="settings-row">
                        <span>{t("text_diff.ignore_case_tip")}</span>
                        <input
                          type="checkbox"
                          checked={p().ignore_case}
                          onChange={(e) => updateField("ignore_case", e.currentTarget.checked)}
                        />
                      </div>
                    </div>
                  </Show>

                  {/* Tab 3: Folder Compare */}
                  <Show when={activeTab() === "folder"}>
                    <div class="settings-group">
                      <h4 class="settings-title">{t("settings.tab_folder")}</h4>
                      <div class="settings-row">
                        <span>{t("settings.folder_mode")}</span>
                        <div class="settings-pill-group">
                          <button
                            class={`mini-btn ${p().folder_compare_mode === "hash" ? "active" : ""}`}
                            onClick={() => updateField("folder_compare_mode", "hash")}
                          >
                            ⚡ {t("folder_diff.mode_hash")}
                          </button>
                          <button
                            class={`mini-btn ${p().folder_compare_mode === "fast" ? "active" : ""}`}
                            onClick={() => updateField("folder_compare_mode", "fast")}
                          >
                            🚀 {t("folder_diff.mode_fast")}
                          </button>
                        </div>
                      </div>

                      <div style={{ "margin-top": "12px" }}>
                        <span style={{ "font-size": "13px", "font-weight": "500" }}>
                          {t("settings.folder_exclude")}
                        </span>
                        <textarea
                          class="path-text-input"
                          style={{
                            width: "100%",
                            height: "70px",
                            "margin-top": "6px",
                            padding: "6px 8px",
                            border: "1px solid var(--border-color)",
                            "font-family": "monospace",
                            "font-size": "12px",
                          }}
                          value={globsInput()}
                          onInput={(e) => setGlobsInput(e.currentTarget.value)}
                          placeholder=".git, node_modules, target, .DS_Store, *.log"
                        />
                        <div style={{ "margin-top": "6px", display: "flex", "justify-content": "flex-end" }}>
                          <button class="bc-tool-btn" onClick={saveGlobs}>
                            {t("settings.save_globs")}
                          </button>
                        </div>
                      </div>
                    </div>
                  </Show>

                  {/* Tab 4: Git & Reset */}
                  <Show when={activeTab() === "git"}>
                    <div class="settings-group">
                      <h4 class="settings-title">{t("settings.git_title")}</h4>
                      <p style={{ "font-size": "12px", opacity: "0.8", "margin-bottom": "10px" }}>
                        {t("settings.git_desc")}
                      </p>
                      <button class="bc-tool-btn active" onClick={handleInstallGit} style={{ padding: "6px 14px" }}>
                        {t("settings.git_install_btn")}
                      </button>

                      <h4 class="settings-title" style={{ "margin-top": "24px" }}>
                        {t("settings.history_title")}
                      </h4>
                      <div style={{ display: "flex", gap: "10px", "flex-wrap": "wrap" }}>
                        <button class="bc-tool-btn" onClick={handleClearHistory}>
                          {t("settings.clear_history_btn")}
                        </button>
                        <button class="bc-tool-btn" onClick={handleResetDefaults}>
                          {t("settings.reset_defaults_btn")}
                        </button>
                      </div>
                    </div>
                  </Show>

                  {/* Tab 5: About & Diagnostics */}
                  <Show when={activeTab() === "about"}>
                    <div class="settings-group">
                      <h4 class="settings-title">{t("about.modal_title")}</h4>
                      <Show
                        when={appInfo()}
                        fallback={<p style={{ "font-size": "12px", opacity: "0.8" }}>{t("about.loading")}</p>}
                      >
                        {(info) => (
                          <div style={{ display: "flex", "flex-direction": "column", gap: "12px", "margin-top": "12px" }}>
                            <div>
                              <div style={{ "font-size": "12px", color: "var(--text-secondary)", "margin-bottom": "4px" }}>
                                {t("about.version")}
                              </div>
                              <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                                <span style={{ "font-weight": "bold", "font-size": "14px" }}>v{info().version}</span>
                                <span class="about-tag">
                                  {info().build_profile === "release" ? t("about.release") : t("about.debug")}
                                </span>
                              </div>
                            </div>

                            <div>
                              <div style={{ "font-size": "12px", color: "var(--text-secondary)", "margin-bottom": "4px" }}>
                                {t("about.git_hash")}
                              </div>
                              <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                                <code class="about-code-block" style={{ "max-width": "120px" }}>
                                  {info().git_hash_short}
                                </code>
                                <button
                                  class="about-copy-btn"
                                  onClick={async () => {
                                    await navigator.clipboard.writeText(info().git_hash);
                                    notify(t("about.copied_hash"));
                                  }}
                                >
                                  {t("about.copy_hash")}
                                </button>
                                <Show when={info().git_dirty}>
                                  <span class="about-dirty-tag">{t("about.dirty_badge")}</span>
                                </Show>
                              </div>
                            </div>

                            <div>
                              <div style={{ "font-size": "12px", color: "var(--text-secondary)", "margin-bottom": "4px" }}>
                                {t("about.binary_path")}
                              </div>
                              <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                                <code class="about-code-block binary-path-block" style={{ flex: "1" }}>
                                  {info().binary_path}
                                </code>
                                <button
                                  class="about-copy-btn"
                                  onClick={async () => {
                                    await navigator.clipboard.writeText(info().binary_path);
                                    notify(t("about.copied_path"));
                                  }}
                                >
                                  {t("about.copy_path")}
                                </button>
                              </div>
                            </div>

                            <div>
                              <div style={{ "font-size": "12px", color: "var(--text-secondary)", "margin-bottom": "4px" }}>
                                {t("about.target_arch")}
                              </div>
                              <span style={{ "font-family": "monospace", "font-size": "12.5px" }}>
                                {info().target_triple}
                              </span>
                            </div>

                            <div style={{ "margin-top": "10px" }}>
                              <button
                                class="bc-tool-btn"
                                onClick={async () => {
                                  const text = [
                                    `Application: ${info().name}`,
                                    `Version: v${info().version}`,
                                    `Git Commit: ${info().git_hash}${info().git_dirty ? " (dirty)" : ""}`,
                                    `Binary Executable: ${info().binary_path}`,
                                    `Target Triple: ${info().target_triple}`,
                                    `Build Profile: ${info().build_profile}`,
                                  ].join("\n");
                                  await navigator.clipboard.writeText(text);
                                  notify(t("about.copied_all"));
                                }}
                              >
                                {t("about.copy_all")}
                              </button>
                            </div>
                          </div>
                        )}
                      </Show>
                    </div>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </div>

        <div class="modal-footer" style={{ "justify-content": "flex-end" }}>
          <button class="bc-tool-btn active" onClick={props.onClose}>
            {t("settings.done_close")}
          </button>
        </div>

        <Show when={toast()}>
          <div class="floating-toast">{toast()}</div>
        </Show>
      </div>
    </div>
  );
};
