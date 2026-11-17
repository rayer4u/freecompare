import { Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { AppInfoDto, callRustRpc, UserPreferencesDto } from "../bridge";
import { currentLocale, setLocale, t } from "../i18n";
import { parseGlobsInput } from "../utils/preferences";
import {
  buildSaveSftpSiteRpcArgs,
  buildSftpSiteDisplayUri,
  buildSftpTestRpcArgs,
  type DeleteSftpSiteResponse,
  type ListSftpSitesResponse,
  type SaveSftpSiteResponse,
  type SftpSiteDto,
  type SftpTestResultDto,
} from "../utils/sftp";

interface SettingsModalProps {
  onClose: () => void;
  onPreferencesUpdated: (prefs: UserPreferencesDto) => void;
}

export const SettingsModal: Component<SettingsModalProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<"editor" | "diff" | "folder" | "sftp" | "git" | "about">("editor");
  const [prefs, setPrefs] = createSignal<UserPreferencesDto | null>(null);
  const [appInfo, setAppInfo] = createSignal<AppInfoDto | null>(null);
  const [globsInput, setGlobsInput] = createSignal("");
  const [toast, setToast] = createSignal<string | null>(null);

  // SFTP Site Management state
  const [sftpSites, setSftpSites] = createSignal<SftpSiteDto[]>([]);
  const [editingSiteId, setEditingSiteId] = createSignal<string | null>(null);
  const [siteName, setSiteName] = createSignal("");
  const [siteHost, setSiteHost] = createSignal("");
  const [sitePort, setSitePort] = createSignal("");
  const [siteUser, setSiteUser] = createSignal("");
  const [siteRemotePath, setSiteRemotePath] = createSignal("/");
  const [siteKeyPath, setSiteKeyPath] = createSignal("");
  const [sitePassword, setSitePassword] = createSignal("");
  const [sitePassphrase, setSitePassphrase] = createSignal("");
  const [siteRememberPwd, setSiteRememberPwd] = createSignal(true);
  const [clearSavedPassword, setClearSavedPassword] = createSignal(false);
  const [clearSavedPassphrase, setClearSavedPassphrase] = createSignal(false);
  const [sftpBusy, setSftpBusy] = createSignal(false);
  const [sftpStatus, setSftpStatus] = createSignal<string | null>(null);
  const [sftpError, setSftpError] = createSignal<string | null>(null);

  const editingSite = () => sftpSites().find((s) => s.id === editingSiteId()) ?? null;

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const handleModalKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
  };

  onMount(async () => {
    document.addEventListener("keydown", handleModalKeyDown, true);
    const data = await callRustRpc<UserPreferencesDto>("get_user_preferences");
    if (data) {
      setPrefs(data);
      setGlobsInput((data.folder_exclude_globs || []).join(", "));
    }
    const info = await callRustRpc<AppInfoDto>("get_app_info");
    if (info) {
      setAppInfo(info);
    }
    await loadSftpSites();
  });

  const loadSftpSites = async () => {
    try {
      const res = await callRustRpc<ListSftpSitesResponse | SftpSiteDto[]>("list_sftp_sites");
      if (Array.isArray(res)) {
        setSftpSites(res);
      } else if (res && Array.isArray(res.sites)) {
        setSftpSites(res.sites);
      }
    } catch {
      // ignore
    }
  };

  const resetSftpForm = () => {
    setEditingSiteId(null);
    setSiteName("");
    setSiteHost("");
    setSitePort("");
    setSiteUser("");
    setSiteRemotePath("/");
    setSiteKeyPath("");
    setSitePassword("");
    setSitePassphrase("");
    setSiteRememberPwd(true);
    setClearSavedPassword(false);
    setClearSavedPassphrase(false);
    setSftpStatus(null);
    setSftpError(null);
  };

  const selectSiteForEdit = (site: SftpSiteDto) => {
    setEditingSiteId(site.id);
    setSiteName(site.name);
    setSiteHost(site.host);
    setSitePort(site.port ? String(site.port) : "");
    setSiteUser(site.user ?? "");
    setSiteRemotePath(site.remote_path || "/");
    setSiteKeyPath(site.private_key_path ?? "");
    setSitePassword("");
    setSitePassphrase("");
    setSiteRememberPwd(site.remember_password);
    setClearSavedPassword(false);
    setClearSavedPassphrase(false);
    setSftpStatus(null);
    setSftpError(null);
  };

  const handleSaveSftpSite = async () => {
    setSftpError(null);
    setSftpStatus(null);
    if (!siteHost().trim()) {
      setSftpError(t("file_browser.sftp_missing_host"));
      return;
    }
    setSftpBusy(true);
    try {
      const args = buildSaveSftpSiteRpcArgs({
        id: editingSiteId(),
        name: siteName(),
        host: siteHost(),
        port: sitePort(),
        user: siteUser(),
        remotePath: siteRemotePath(),
        privateKeyPath: siteKeyPath(),
        rememberPassword: siteRememberPwd(),
        password: sitePassword(),
        passphrase: sitePassphrase(),
        clearPassword: clearSavedPassword(),
        clearPassphrase: clearSavedPassphrase(),
      });
      const res = await callRustRpc<SaveSftpSiteResponse>("save_sftp_site", args);
      if (res?.site) {
        await loadSftpSites();
        selectSiteForEdit(res.site);
        const msg = t("file_browser.site_saved", { name: res.site.name });
        setSftpStatus(msg);
        notify(msg);
      }
    } catch (err) {
      setSftpError(err instanceof Error ? err.message : String(err));
    } finally {
      setSftpBusy(false);
    }
  };

  const handleDeleteSftpSite = async (site: SftpSiteDto) => {
    if (!window.confirm(t("settings.sftp_site_delete_confirm", { name: site.name }))) return;
    setSftpError(null);
    setSftpStatus(null);
    try {
      const res = await callRustRpc<DeleteSftpSiteResponse>("delete_sftp_site", { id: site.id });
      if (res?.deleted) {
        if (editingSiteId() === site.id) {
          resetSftpForm();
        }
        await loadSftpSites();
        notify(t("file_browser.site_deleted", { name: site.name }));
      }
    } catch (err) {
      setSftpError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTestSftpSite = async () => {
    setSftpError(null);
    setSftpStatus(null);
    if (!siteHost().trim()) {
      setSftpError(t("file_browser.sftp_missing_host"));
      return;
    }
    setSftpStatus(t("file_browser.sftp_testing"));
    setSftpBusy(true);
    try {
      const uri = buildSftpSiteDisplayUri({
        host: siteHost().trim(),
        port: sitePort().trim() ? Number.parseInt(sitePort().trim(), 10) : null,
        user: siteUser().trim() || null,
        remote_path: siteRemotePath().trim() || "/",
      });
      const res = await callRustRpc<SftpTestResultDto>(
        "test_sftp_connection",
        buildSftpTestRpcArgs({
          siteId: editingSiteId() || undefined,
          uri,
          host: siteHost(),
          port: sitePort(),
          user: siteUser(),
          password: sitePassword(),
          path: siteRemotePath(),
          privateKeyPath: siteKeyPath(),
          passphrase: sitePassphrase(),
        })
      );
      if (res?.ok) {
        const info =
          res.message ||
          [res.user ? `${res.user}@${res.host}:${res.port}` : res.host, res.auth_method, res.remote_path]
            .filter(Boolean)
            .join(" · ");
        setSftpStatus(t("file_browser.sftp_test_ok", { info }));
      } else {
        setSftpStatus(null);
        setSftpError(t("file_browser.sftp_test_fail", { err: res?.message || t("file_browser.err_service") }));
      }
    } catch (err) {
      setSftpStatus(null);
      setSftpError(
        t("file_browser.sftp_test_fail", { err: err instanceof Error ? err.message : String(err) })
      );
    } finally {
      setSftpBusy(false);
    }
  };

  onCleanup(() => {
    document.removeEventListener("keydown", handleModalKeyDown, true);
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

  const saveGlobs = async (silentIfUnchanged = false) => {
    const parsed = parseGlobsInput(globsInput());
    const existing = prefs()?.folder_exclude_globs ?? [];
    const unchanged =
      parsed.length === existing.length &&
      parsed.every((val, i) => val === existing[i]);
    if (silentIfUnchanged && unchanged) return;
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
              class={`settings-nav-btn ${activeTab() === "sftp" ? "active" : ""}`}
              onClick={() => setActiveTab("sftp")}
            >
              {t("settings.tab_sftp")}
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
                        <span>{t("settings.syntax_hl")}</span>
                        <input
                          type="checkbox"
                          checked={p().syntax_highlighting}
                          onChange={(e) => updateField("syntax_highlighting", e.currentTarget.checked)}
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
                          onBlur={() => saveGlobs(true)}
                          placeholder=".git, node_modules, target, .DS_Store, *.log"
                        />
                        <div style={{ "margin-top": "6px", display: "flex", "justify-content": "flex-end" }}>
                          <button class="bc-tool-btn" onClick={() => saveGlobs(false)}>
                            {t("settings.save_globs")}
                          </button>
                        </div>
                      </div>
                    </div>
                  </Show>

                  {/* Tab 4: SFTP Sites */}
                  <Show when={activeTab() === "sftp"}>
                    <div class="settings-group">
                      <div class="sftp-sites-header" style={{ "margin-bottom": "6px" }}>
                        <h4 class="settings-title" style={{ margin: 0 }}>{t("settings.sftp_sites_title")}</h4>
                        <button class="bc-tool-btn" onClick={resetSftpForm}>
                          {t("file_browser.site_new_btn")}
                        </button>
                      </div>
                      <p style={{ "font-size": "12px", opacity: "0.8", "margin-bottom": "10px" }}>
                        {t("settings.sftp_sites_desc")}
                      </p>

                      <Show
                        when={sftpSites().length > 0}
                        fallback={
                          <div class="sftp-auth-hint" style={{ "margin-bottom": "12px" }}>
                            {t("file_browser.sites_empty")}
                          </div>
                        }
                      >
                        <div class="sftp-host-chips" style={{ "margin-bottom": "12px", "max-height": "110px" }}>
                          <For each={sftpSites()}>
                            {(site) => (
                              <div
                                class={`sftp-host-chip sftp-site-chip-wrap ${
                                  editingSiteId() === site.id ? "active" : ""
                                }`}
                                onClick={() => selectSiteForEdit(site)}
                                title={buildSftpSiteDisplayUri(site)}
                              >
                                <span>
                                  {site.has_password || site.has_passphrase ? "🔒" : "🌐"} {site.name}
                                </span>
                                <span class="sftp-host-chip-meta">
                                  {site.user ? `${site.user}@` : ""}
                                  {site.host}
                                  {site.port && site.port !== 22 ? `:${site.port}` : ""}
                                </span>
                                <button
                                  class="sftp-site-delete-btn"
                                  title={t("file_browser.site_delete_tip")}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteSftpSite(site);
                                  }}
                                >
                                  ×
                                </button>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>

                      <div style={{ display: "flex", "flex-direction": "column", gap: "8px", "border-top": "1px solid var(--border-color)", "padding-top": "12px" }}>
                        <div class="sftp-field">
                          <label>{t("file_browser.site_name")}</label>
                          <input
                            class="sftp-input"
                            placeholder={t("file_browser.site_name_placeholder")}
                            value={siteName()}
                            onInput={(e) => setSiteName(e.currentTarget.value)}
                          />
                        </div>

                        <div class="sftp-form-grid">
                          <div class="sftp-field">
                            <label>{t("file_browser.sftp_host")}</label>
                            <input
                              class="sftp-input"
                              placeholder="10.0.0.1 / ssh-alias"
                              value={siteHost()}
                              onInput={(e) => setSiteHost(e.currentTarget.value)}
                            />
                          </div>
                          <div class="sftp-field">
                            <label>{t("file_browser.sftp_port")}</label>
                            <input
                              class="sftp-input"
                              placeholder="22"
                              value={sitePort()}
                              onInput={(e) => setSitePort(e.currentTarget.value)}
                            />
                          </div>
                          <div class="sftp-field">
                            <label>{t("file_browser.sftp_user")}</label>
                            <input
                              class="sftp-input"
                              placeholder="(ssh config)"
                              value={siteUser()}
                              onInput={(e) => setSiteUser(e.currentTarget.value)}
                            />
                          </div>
                          <div class="sftp-field">
                            <label>{t("file_browser.sftp_path")}</label>
                            <input
                              class="sftp-input"
                              placeholder="/"
                              value={siteRemotePath()}
                              onInput={(e) => setSiteRemotePath(e.currentTarget.value)}
                            />
                          </div>
                        </div>

                        <div class="sftp-auth-grid">
                          <div class="sftp-field">
                            <div class="sftp-field-label-row">
                              <label>{t("file_browser.sftp_password")}</label>
                              <Show when={editingSite()?.has_password && !clearSavedPassword()}>
                                <button
                                  type="button"
                                  class="sftp-clear-btn"
                                  onClick={() => {
                                    setClearSavedPassword(true);
                                    setSitePassword("");
                                  }}
                                >
                                  {t("file_browser.sftp_clear_saved_pwd")}
                                </button>
                              </Show>
                            </div>
                            <input
                              class="sftp-input"
                              type="password"
                              placeholder={
                                editingSite()?.has_password && !clearSavedPassword()
                                  ? t("file_browser.sftp_password_saved_placeholder")
                                  : "•••••••• (optional)"
                              }
                              value={sitePassword()}
                              onInput={(e) => {
                                setSitePassword(e.currentTarget.value);
                                if (e.currentTarget.value) setClearSavedPassword(false);
                              }}
                            />
                          </div>
                          <div class="sftp-field">
                            <label>{t("file_browser.sftp_key_path")}</label>
                            <input
                              class="sftp-input"
                              placeholder="~/.ssh/id_ed25519"
                              value={siteKeyPath()}
                              onInput={(e) => setSiteKeyPath(e.currentTarget.value)}
                            />
                          </div>
                          <div class="sftp-field">
                            <label>{t("file_browser.sftp_passphrase")}</label>
                            <input
                              class="sftp-input"
                              type="password"
                              placeholder={
                                editingSite()?.has_passphrase && !clearSavedPassphrase()
                                  ? t("file_browser.sftp_password_saved_placeholder")
                                  : "•••••••• (optional)"
                              }
                              value={sitePassphrase()}
                              onInput={(e) => {
                                setSitePassphrase(e.currentTarget.value);
                                if (e.currentTarget.value) setClearSavedPassphrase(false);
                              }}
                            />
                          </div>
                        </div>

                        <div class="sftp-remember-row">
                          <label class="hidden-toggle">
                            <input
                              type="checkbox"
                              checked={siteRememberPwd()}
                              onChange={(e) => setSiteRememberPwd(e.currentTarget.checked)}
                            />
                            {t("file_browser.sftp_remember_password")}
                          </label>
                        </div>

                        <Show when={sftpStatus()}>
                          <div class="modal-success-banner">{sftpStatus()}</div>
                        </Show>
                        <Show when={sftpError()}>
                          <div class="modal-error-banner">{sftpError()}</div>
                        </Show>

                        <div class="sftp-actions-row">
                          <span class="sftp-auth-hint">{t("file_browser.sftp_auth_hint")}</span>
                          <div class="bc-toolbar-group">
                            <button class="bc-tool-btn" disabled={sftpBusy()} onClick={handleTestSftpSite}>
                              {t("file_browser.sftp_test_btn")}
                            </button>
                            <button class="bc-tool-btn active" disabled={sftpBusy()} onClick={handleSaveSftpSite}>
                              {editingSiteId() ? t("file_browser.site_update_btn") : t("file_browser.site_save_btn")}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </Show>

                  {/* Tab 5: Git & Reset */}
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
