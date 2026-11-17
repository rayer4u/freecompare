import { Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { callRustRpc } from "../bridge";
import { t } from "../i18n";
import {
  buildSftpTestRpcArgs,
  buildSftpUri,
  isSftpUri,
  type ListSshConfigHostsResponse,
  maskSftpPassword,
  parseSftpUri,
  type SftpTestResultDto,
  type SshConfigHostDto,
} from "../utils/sftp";

export interface FsEntryDto {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface FsListResponse {
  current_dir: string;
  parent_dir: string | null;
  entries: FsEntryDto[];
}

interface FileBrowserModalProps {
  mode: "file" | "folder";
  title: string;
  initialPath?: string;
  onSelect: (selectedPath: string) => void;
  onClose: () => void;
}

export const FileBrowserModal: Component<FileBrowserModalProps> = (props) => {
  const initialIsSftp = isSftpUri(props.initialPath);
  const initialParsed = initialIsSftp
    ? parseSftpUri(props.initialPath ?? "")
    : { host: "", port: "", user: "", password: "", path: "/" };

  const [browserTab, setBrowserTab] = createSignal<"local" | "sftp">(
    initialIsSftp ? "sftp" : "local"
  );
  const [currentDir, setCurrentDir] = createSignal(props.initialPath ?? "");
  const [parentDir, setParentDir] = createSignal<string | null>(null);
  const [entries, setEntries] = createSignal<FsEntryDto[]>([]);
  const [selectedItem, setSelectedItem] = createSignal<FsEntryDto | null>(null);
  const [showHidden, setShowHidden] = createSignal(false);
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);
  const [statusMsg, setStatusMsg] = createSignal<string | null>(null);
  const [isBusy, setIsBusy] = createSignal(false);

  // SFTP profile / quick-connect state
  const [sshHosts, setSshHosts] = createSignal<SshConfigHostDto[]>([]);
  const [sftpHost, setSftpHost] = createSignal(initialParsed.host);
  const [sftpPort, setSftpPort] = createSignal(initialParsed.port);
  const [sftpUser, setSftpUser] = createSignal(initialParsed.user);
  const [sftpPassword, setSftpPassword] = createSignal(initialParsed.password);
  const [sftpKeyPath, setSftpKeyPath] = createSignal("");
  const [sftpPassphrase, setSftpPassphrase] = createSignal("");
  const [sftpRemotePath, setSftpRemotePath] = createSignal(initialParsed.path || "/");
  const [quickUriInput, setQuickUriInput] = createSignal(
    initialIsSftp ? (props.initialPath ?? "") : ""
  );
  const [showSftpForm, setShowSftpForm] = createSignal(true);

  let lastLoadedDir = (props.initialPath ?? "").trim();

  const syncQuickUriFromFields = () => {
    const uri = buildSftpUri({
      host: sftpHost(),
      port: sftpPort(),
      user: sftpUser(),
      password: sftpPassword(),
      path: sftpRemotePath(),
    });
    setQuickUriInput(uri);
    return uri;
  };

  const applyUriToFields = (rawUri: string) => {
    setQuickUriInput(rawUri);
    if (!isSftpUri(rawUri)) return;
    const parsed = parseSftpUri(rawUri);
    setSftpHost(parsed.host);
    setSftpPort(parsed.port);
    setSftpUser(parsed.user);
    setSftpPassword(parsed.password);
    setSftpRemotePath(parsed.path || "/");
  };

  const loadSshHosts = async () => {
    try {
      const res = await callRustRpc<ListSshConfigHostsResponse | SshConfigHostDto[]>(
        "list_ssh_config_hosts"
      );
      if (Array.isArray(res)) {
        setSshHosts(res);
      } else if (res && Array.isArray(res.hosts)) {
        setSshHosts(res.hosts);
      }
    } catch {
      // Ignore if ~/.ssh/config doesn't exist or RPC unavailable
    }
  };

  const loadDir = async (targetPath?: string) => {
    setErrorMsg(null);
    setStatusMsg(null);
    const trimmedTarget = targetPath?.trim() ?? "";
    if (targetPath !== undefined) {
      lastLoadedDir = trimmedTarget;
    }
    setIsBusy(true);
    try {
      const args: Record<string, unknown> = {
        dir_path: trimmedTarget ? trimmedTarget : null,
      };
      if (trimmedTarget && isSftpUri(trimmedTarget)) {
        if (sftpPassword()) args.password = sftpPassword();
        if (sftpKeyPath().trim()) args.private_key_path = sftpKeyPath().trim();
        if (sftpPassphrase()) args.passphrase = sftpPassphrase();
      }
      const res = await callRustRpc<FsListResponse>("list_local_dir", args);
      if (res) {
        lastLoadedDir = res.current_dir;
        setCurrentDir(res.current_dir);
        setParentDir(res.parent_dir);
        setEntries(res.entries);
        setSelectedItem(null);
        if (isSftpUri(res.current_dir)) {
          const parsed = parseSftpUri(res.current_dir);
          setSftpRemotePath(parsed.path || "/");
          setQuickUriInput(res.current_dir);
        }
      } else {
        setErrorMsg(t("file_browser.err_service"));
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  };

  const getTargetSftpUri = (): string => {
    const q = quickUriInput().trim();
    if (isSftpUri(q)) {
      const parsed = parseSftpUri(q);
      if (parsed.host) return q;
    }
    return syncQuickUriFromFields();
  };

  const handleTestSftp = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    const uri = getTargetSftpUri();
    if (!uri) {
      setErrorMsg(t("file_browser.sftp_missing_host"));
      return;
    }
    setStatusMsg(t("file_browser.sftp_testing"));
    setIsBusy(true);
    try {
      const res = await callRustRpc<SftpTestResultDto>(
        "test_sftp_connection",
        buildSftpTestRpcArgs({
          uri,
          host: sftpHost(),
          port: sftpPort(),
          user: sftpUser(),
          password: sftpPassword(),
          path: sftpRemotePath(),
          privateKeyPath: sftpKeyPath(),
          passphrase: sftpPassphrase(),
        })
      );
      if (res && res.ok) {
        if (res.resolved_uri) {
          setQuickUriInput(res.resolved_uri);
        }
        const info =
          res.message ||
          [
            res.user ? `${res.user}@${res.host}:${res.port}` : res.host,
            res.auth_method,
            res.remote_path,
          ]
            .filter(Boolean)
            .join(" · ") ||
          maskSftpPassword(uri);
        setStatusMsg(t("file_browser.sftp_test_ok", { info }));
      } else {
        setStatusMsg(null);
        setErrorMsg(
          t("file_browser.sftp_test_fail", {
            err: res?.message || t("file_browser.err_service"),
          })
        );
      }
    } catch (err) {
      setStatusMsg(null);
      setErrorMsg(
        t("file_browser.sftp_test_fail", {
          err: err instanceof Error ? err.message : String(err),
        })
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleConnectAndBrowseSftp = async (overrideUri?: string) => {
    const uri = overrideUri ?? getTargetSftpUri();
    if (!uri) {
      setErrorMsg(t("file_browser.sftp_missing_host"));
      return;
    }
    setQuickUriInput(uri);
    await loadDir(uri);
  };

  const handleSelectSshHostChip = async (h: SshConfigHostDto) => {
    setSftpHost(h.alias);
    const chipPort = h.port && h.port !== 22 ? String(h.port) : "";
    setSftpPort(chipPort);
    setSftpUser(h.user ?? "");
    setSftpPassword("");
    const remotePath = sftpRemotePath().trim() || "/";
    setSftpRemotePath(remotePath);
    const uri = buildSftpUri({
      host: h.alias,
      port: chipPort,
      user: h.user ?? "",
      password: "",
      path: remotePath,
    });
    setQuickUriInput(uri);
    await handleConnectAndBrowseSftp(uri);
  };

  const handleModalKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
  };

  onMount(() => {
    document.addEventListener("keydown", handleModalKeyDown, true);
    loadSshHosts();
    if (initialIsSftp) {
      loadDir(props.initialPath);
    } else {
      loadDir(props.initialPath);
    }
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleModalKeyDown, true);
  });

  const visibleEntries = () =>
    entries().filter((e) => {
      if (!showHidden() && e.name.startsWith(".")) return false;
      if (props.mode === "folder") return e.is_dir;
      return true;
    });

  const handleConfirm = () => {
    const sel = selectedItem();
    if (props.mode === "folder") {
      if (sel && sel.is_dir) {
        props.onSelect(sel.path);
      } else if (currentDir()) {
        props.onSelect(currentDir());
      }
    } else if (sel && !sel.is_dir) {
      props.onSelect(sel.path);
    }
  };

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div
        class="file-browser-dialog"
        style={{
          height: browserTab() === "sftp" && showSftpForm() ? "660px" : "540px",
          "max-height": "88vh",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <strong>📂 {props.title}</strong>
          <button class="modal-close-btn" onClick={props.onClose}>
            ×
          </button>
        </div>

        {/* Mode Switcher: Local Filesystem vs SFTP Remote */}
        <div class="modal-mode-tabs">
          <div class="bc-toolbar-group">
            <button
              class={`bc-tool-btn ${browserTab() === "local" ? "active" : ""}`}
              onClick={() => {
                setBrowserTab("local");
                setErrorMsg(null);
                setStatusMsg(null);
                if (isSftpUri(currentDir())) {
                  loadDir(undefined);
                }
              }}
            >
              {t("file_browser.tab_local")}
            </button>
            <button
              class={`bc-tool-btn ${browserTab() === "sftp" ? "active" : ""}`}
              onClick={() => {
                setBrowserTab("sftp");
                setShowSftpForm(true);
                setErrorMsg(null);
                setStatusMsg(null);
                if (sshHosts().length === 0) {
                  loadSshHosts();
                }
              }}
            >
              {t("file_browser.tab_sftp")}
            </button>
          </div>
          <Show when={browserTab() === "sftp"}>
            <button
              class="bc-tool-btn"
              onClick={() => setShowSftpForm((v) => !v)}
            >
              {showSftpForm() ? "▲" : "▼"} {t("file_browser.sftp_connected_badge")}
            </button>
          </Show>
        </div>

        {/* SFTP Quick Connect & ~/.ssh/config Profiles */}
        <Show when={browserTab() === "sftp" && showSftpForm()}>
          <div class="sftp-panel">
            <div class="sftp-ssh-hosts">
              <span class="sftp-section-label">{t("file_browser.ssh_hosts_title")}</span>
              <Show
                when={sshHosts().length > 0}
                fallback={
                  <span class="sftp-auth-hint">{t("file_browser.ssh_hosts_empty")}</span>
                }
              >
                <div class="sftp-host-chips">
                  <For each={sshHosts()}>
                    {(h) => (
                      <button
                        class={`sftp-host-chip ${sftpHost() === h.alias ? "active" : ""}`}
                        onClick={() => handleSelectSshHostChip(h)}
                        title={
                          [
                            h.host_name ? `HostName: ${h.host_name}` : null,
                            h.user ? `User: ${h.user}` : null,
                            h.port ? `Port: ${h.port}` : null,
                            h.identity_files?.length
                              ? `Keys: ${h.identity_files.join(", ")}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join("\n") || h.alias
                        }
                      >
                        <span>🔑 {h.alias}</span>
                        <Show when={h.host_name || h.user}>
                          <span class="sftp-host-chip-meta">
                            {h.user ? `${h.user}@` : ""}
                            {h.host_name || h.alias}
                            {h.port && h.port !== 22 ? `:${h.port}` : ""}
                          </span>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            <div class="sftp-field">
              <label>{t("file_browser.sftp_quick_uri")}</label>
              <input
                class="sftp-input"
                placeholder={t("file_browser.sftp_quick_uri_placeholder")}
                value={quickUriInput()}
                onInput={(e) => applyUriToFields(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && handleConnectAndBrowseSftp()}
              />
            </div>

            <div class="sftp-form-grid">
              <div class="sftp-field">
                <label>{t("file_browser.sftp_host")}</label>
                <input
                  class="sftp-input"
                  placeholder="10.0.0.1 / ssh-alias"
                  value={sftpHost()}
                  onInput={(e) => {
                    setSftpHost(e.currentTarget.value);
                    syncQuickUriFromFields();
                  }}
                  onKeyDown={(e) => e.key === "Enter" && handleConnectAndBrowseSftp()}
                />
              </div>
              <div class="sftp-field">
                <label>{t("file_browser.sftp_port")}</label>
                <input
                  class="sftp-input"
                  placeholder="22"
                  value={sftpPort()}
                  onInput={(e) => {
                    setSftpPort(e.currentTarget.value);
                    syncQuickUriFromFields();
                  }}
                />
              </div>
              <div class="sftp-field">
                <label>{t("file_browser.sftp_user")}</label>
                <input
                  class="sftp-input"
                  placeholder="(ssh config)"
                  value={sftpUser()}
                  onInput={(e) => {
                    setSftpUser(e.currentTarget.value);
                    syncQuickUriFromFields();
                  }}
                />
              </div>
              <div class="sftp-field">
                <label>{t("file_browser.sftp_path")}</label>
                <input
                  class="sftp-input"
                  placeholder="/"
                  value={sftpRemotePath()}
                  onInput={(e) => {
                    setSftpRemotePath(e.currentTarget.value);
                    syncQuickUriFromFields();
                  }}
                  onKeyDown={(e) => e.key === "Enter" && handleConnectAndBrowseSftp()}
                />
              </div>
            </div>

            <div class="sftp-auth-grid">
              <div class="sftp-field">
                <label>{t("file_browser.sftp_password")}</label>
                <input
                  class="sftp-input"
                  type="password"
                  placeholder="•••••••• (optional)"
                  value={sftpPassword()}
                  onInput={(e) => {
                    setSftpPassword(e.currentTarget.value);
                    syncQuickUriFromFields();
                  }}
                  onKeyDown={(e) => e.key === "Enter" && handleConnectAndBrowseSftp()}
                />
              </div>
              <div class="sftp-field">
                <label>{t("file_browser.sftp_key_path")}</label>
                <input
                  class="sftp-input"
                  placeholder="~/.ssh/id_ed25519"
                  value={sftpKeyPath()}
                  onInput={(e) => setSftpKeyPath(e.currentTarget.value)}
                />
              </div>
              <div class="sftp-field">
                <label>{t("file_browser.sftp_passphrase")}</label>
                <input
                  class="sftp-input"
                  type="password"
                  placeholder="•••••••• (optional)"
                  value={sftpPassphrase()}
                  onInput={(e) => setSftpPassphrase(e.currentTarget.value)}
                />
              </div>
            </div>

            <div class="sftp-actions-row">
              <span class="sftp-auth-hint">{t("file_browser.sftp_auth_hint")}</span>
              <div class="bc-toolbar-group">
                <button
                  class="bc-tool-btn"
                  disabled={isBusy()}
                  onClick={handleTestSftp}
                >
                  {t("file_browser.sftp_test_btn")}
                </button>
                <button
                  class="bc-tool-btn active"
                  disabled={isBusy()}
                  onClick={() => handleConnectAndBrowseSftp()}
                >
                  {t("file_browser.sftp_connect_btn")}
                </button>
              </div>
            </div>
          </div>
        </Show>

        <div class="modal-path-bar">
          <button
            class="bc-tool-btn"
            disabled={!parentDir() || isBusy()}
            onClick={() => parentDir() && loadDir(parentDir()!)}
            title={t("file_browser.up_tip")}
          >
            {t("file_browser.up")}
          </button>
          <Show when={isSftpUri(currentDir())}>
            <span class="meta-tag sftp-tag">SFTP</span>
          </Show>
          <input
            class="path-text-input modal-dir-input"
            value={currentDir()}
            onInput={(e) => setCurrentDir(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && loadDir(currentDir())}
            onBlur={() => {
              const cur = currentDir().trim();
              if (cur && cur !== lastLoadedDir) {
                loadDir(cur);
              }
            }}
          />
          <button class="bc-tool-btn" disabled={isBusy()} onClick={() => loadDir(currentDir())}>
            {t("file_browser.go")}
          </button>
          <label class="hidden-toggle">
            <input
              type="checkbox"
              checked={showHidden()}
              onChange={(e) => setShowHidden(e.currentTarget.checked)}
            />
            {t("file_browser.show_hidden")}
          </label>
        </div>

        <Show when={statusMsg()}>
          <div class="modal-success-banner">{statusMsg()}</div>
        </Show>

        <Show when={errorMsg()}>
          <div class="modal-error-banner">{errorMsg()}</div>
        </Show>

        <div class="modal-file-list">
          <For each={visibleEntries()}>
            {(item) => (
              <div
                class={`modal-file-row ${
                  selectedItem()?.path === item.path ? "selected" : ""
                }`}
                onClick={() => setSelectedItem(item)}
                onDblClick={() => {
                  if (item.is_dir) {
                    loadDir(item.path);
                  } else if (props.mode === "file") {
                    props.onSelect(item.path);
                  }
                }}
              >
                <span class="entry-icon">{item.is_dir ? "📁" : "📄"}</span>
                <span class="modal-file-name">{item.name}</span>
                <span class="modal-file-size">
                  {item.is_dir ? t("file_browser.folder_tag") : `${item.size} B`}
                </span>
              </div>
            )}
          </For>
        </div>

        <div class="modal-footer">
          <span class="modal-selection-hint">
            {props.mode === "folder"
              ? t("file_browser.sel_folder", {
                  path: maskSftpPassword(selectedItem()?.path ?? currentDir()),
                })
              : selectedItem()
              ? t("file_browser.sel_file", { name: selectedItem()?.name ?? "" })
              : t("file_browser.no_file")}
          </span>
          <div class="modal-footer-btns">
            <button class="bc-tool-btn" onClick={props.onClose}>
              {t("common.cancel")}
            </button>
            <button
              class="bc-tool-btn active"
              disabled={props.mode === "file" && (!selectedItem() || selectedItem()?.is_dir)}
              onClick={handleConfirm}
            >
              {t("file_browser.confirm_select")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
