import { Component, createSignal, onMount, Show } from "solid-js";
import { AppInfoDto, callRustRpc } from "../bridge";

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
      showToast(`已复制 ${label}`);
    } catch {
      showToast("复制失败，请手动选中复制");
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
    await copyText(text, "全部诊断信息");
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
            <strong>关于 FreeCompare</strong>
            <Show when={appInfo()}>
              {(info) => (
                <span class="about-version-badge">v{info().version}</span>
              )}
            </Show>
          </div>
          <button
            class="modal-close-btn"
            onClick={props.onClose}
            title="关闭 (Esc)"
          >
            ×
          </button>
        </div>

        <div class="about-modal-body">
          <div class="about-hero-section">
            <div class="about-hero-icon">⚡</div>
            <div class="about-hero-title">FreeCompare Desktop</div>
            <div class="about-hero-subtitle">
              跨平台原生高保真代码审查、差异对比与三方合并工具
            </div>
          </div>

          <Show
            when={appInfo()}
            fallback={<div class="about-loading">正在读取版本信息...</div>}
          >
            {(info) => (
              <div class="about-info-table">
                <div class="about-info-row">
                  <span class="about-label">应用版本</span>
                  <div class="about-val-group">
                    <span class="about-val-text font-bold">
                      v{info().version}
                    </span>
                    <span class="about-tag">
                      {info().build_profile === "release"
                        ? "正式版 Release"
                        : "调试版 Debug"}
                    </span>
                  </div>
                </div>

                <div class="about-info-row">
                  <span class="about-label">Git 提交 Hash</span>
                  <div class="about-val-group">
                    <code class="about-code-block" title={info().git_hash}>
                      {info().git_hash_short}
                    </code>
                    <button
                      class="about-copy-btn"
                      onClick={() => copyText(info().git_hash, "Git Commit Hash")}
                      title="复制完整 Git Commit Hash"
                    >
                      📋 复制 Hash
                    </button>
                    <Show when={info().git_dirty}>
                      <span class="about-dirty-tag" title="本地工作区有未提交改动">
                        dirty
                      </span>
                    </Show>
                  </div>
                </div>

                <div class="about-info-row full-width">
                  <span class="about-label">完整 Commit Hash</span>
                  <div class="about-val-group">
                    <code class="about-code-block select-all">
                      {info().git_hash}
                    </code>
                  </div>
                </div>

                <div class="about-info-row full-width">
                  <span class="about-label">
                    🎯 正在运行的二进制程序 (Binary Path)
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
                        copyText(info().binary_path, "可执行文件路径")
                      }
                      title="复制二进制文件完整路径"
                    >
                      📋 复制路径
                    </button>
                  </div>
                </div>

                <div class="about-info-row">
                  <span class="about-label">目标平台架构</span>
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
            title="复制全部环境与版本信息到剪贴板，方便诊断排错"
          >
            📋 复制全部信息
          </button>
          <button class="modal-select-btn" onClick={props.onClose}>
            关闭 (Esc)
          </button>
        </div>
      </div>
    </div>
  );
};
