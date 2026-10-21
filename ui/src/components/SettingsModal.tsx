import { Component, createSignal, For, onMount, Show } from "solid-js";
import { callRustRpc, UserPreferencesDto } from "../bridge";

interface SettingsModalProps {
  onClose: () => void;
  onPreferencesUpdated: (prefs: UserPreferencesDto) => void;
}

export const SettingsModal: Component<SettingsModalProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<"editor" | "diff" | "folder" | "git">("editor");
  const [prefs, setPrefs] = createSignal<UserPreferencesDto | null>(null);
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
    notify("已保存文件夹排除规则");
  };

  const handleInstallGit = async () => {
    const res = await callRustRpc<{ success: boolean; scope: string; exe: string }>(
      "install_git_integration"
    );
    if (res?.success) {
      notify(`✅ 已成功配置 Git (${res.scope}) 默认 difftool & mergetool`);
    } else {
      notify("配置 Git 失败，请检查终端权限");
    }
  };

  const handleClearHistory = async () => {
    if (!window.confirm("确定要清空最近打开文件与路径补全历史吗？")) return;
    await callRustRpc("clear_recent_sessions");
    await updateField("recent_left_paths", []);
    await updateField("recent_right_paths", []);
    await updateField("recent_folder_paths", []);
    notify("已清空所有最近历史与路径补全记录");
  };

  const handleResetDefaults = async () => {
    if (!window.confirm("确定要恢复全部设置为出厂默认值吗？")) return;
    const res = await callRustRpc<UserPreferencesDto>("reset_user_preferences");
    if (res) {
      setPrefs(res);
      setGlobsInput((res.folder_exclude_globs || []).join(", "));
      props.onPreferencesUpdated(res);
      notify("已恢复全部默认设置");
    }
  };

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div
        class="file-browser-dialog"
        style={{ "max-width": "680px", "max-height": "85vh", display: "flex", "flex-direction": "column" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <strong>⚙️ FreeCompare 偏好设置 (Settings)</strong>
          <button class="modal-close-btn" onClick={props.onClose}>
            ×
          </button>
        </div>

        <div style={{ display: "flex", flex: "1", "min-height": "0", "border-bottom": "1px solid var(--border-color)" }}>
          {/* Left Navigation Menu */}
          <div
            style={{
              width: "150px",
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
              🎨 外观与编辑器
            </button>
            <button
              class={`settings-nav-btn ${activeTab() === "diff" ? "active" : ""}`}
              onClick={() => setActiveTab("diff")}
            >
              ⇄ 对比与快捷键
            </button>
            <button
              class={`settings-nav-btn ${activeTab() === "folder" ? "active" : ""}`}
              onClick={() => setActiveTab("folder")}
            >
              📁 文件夹比对
            </button>
            <button
              class={`settings-nav-btn ${activeTab() === "git" ? "active" : ""}`}
              onClick={() => setActiveTab("git")}
            >
              🔧 Git 与系统
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
                      <h4 class="settings-title">主题与界面</h4>
                      <div class="settings-row">
                        <span>界面主题</span>
                        <div class="settings-pill-group">
                          <button
                            class={`mini-btn ${p().theme === "dark" ? "active" : ""}`}
                            onClick={() => updateField("theme", "dark")}
                          >
                            🌙 深色模式
                          </button>
                          <button
                            class={`mini-btn ${p().theme === "light" ? "active" : ""}`}
                            onClick={() => updateField("theme", "light")}
                          >
                            ☀️ 浅色模式
                          </button>
                        </div>
                      </div>

                      <div class="settings-row">
                        <span>代码字体大小 ({p().editor_font_size || 13}px)</span>
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
                        <span>Tab 制表符宽度</span>
                        <select
                          class="settings-select"
                          value={p().tab_width || 4}
                          onChange={(e) => updateField("tab_width", Number(e.currentTarget.value))}
                        >
                          <option value="2">2 个空格</option>
                          <option value="4">4 个空格 (默认)</option>
                          <option value="8">8 个空格</option>
                        </select>
                      </div>

                      <div class="settings-row">
                        <span>默认显示可见空白符 (· 空格 / → 制表符)</span>
                        <input
                          type="checkbox"
                          checked={p().show_whitespace_glyphs}
                          onChange={(e) => updateField("show_whitespace_glyphs", e.currentTarget.checked)}
                        />
                      </div>

                      <div class="settings-row">
                        <span>默认显示底部“当前行详情对比”放大镜栏</span>
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
                      <h4 class="settings-title">差异识别与定位行为</h4>
                      <div class="settings-row">
                        <span>打开文件时自动滚动定位到第 1 处差异块</span>
                        <input
                          type="checkbox"
                          checked={p().auto_jump_first_diff}
                          onChange={(e) => updateField("auto_jump_first_diff", e.currentTarget.checked)}
                        />
                      </div>

                      <div class="settings-row">
                        <span>差异块跳转到达末尾后循环回到开头 (Wrap Around)</span>
                        <input
                          type="checkbox"
                          checked={p().wrap_around_navigation}
                          onChange={(e) => updateField("wrap_around_navigation", e.currentTarget.checked)}
                        />
                      </div>

                      <div class="settings-row">
                        <span>存在未保存修改时，按 Esc / 关闭窗口前弹窗确认</span>
                        <input
                          type="checkbox"
                          checked={p().confirm_before_exit_dirty}
                          onChange={(e) => updateField("confirm_before_exit_dirty", e.currentTarget.checked)}
                        />
                      </div>

                      <div class="settings-row">
                        <span>文本对比默认“忽略空白字符差异”</span>
                        <input
                          type="checkbox"
                          checked={p().ignore_whitespace}
                          onChange={(e) => updateField("ignore_whitespace", e.currentTarget.checked)}
                        />
                      </div>

                      <div class="settings-row">
                        <span>文本对比默认“忽略英文字母大小写差异”</span>
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
                      <h4 class="settings-title">文件夹比对策略</h4>
                      <div class="settings-row">
                        <span>默认文件夹比对算法模式</span>
                        <div class="settings-pill-group">
                          <button
                            class={`mini-btn ${p().folder_compare_mode === "hash" ? "active" : ""}`}
                            onClick={() => updateField("folder_compare_mode", "hash")}
                          >
                            ⚡ BLAKE3 内容哈希 (精准)
                          </button>
                          <button
                            class={`mini-btn ${p().folder_compare_mode === "fast" ? "active" : ""}`}
                            onClick={() => updateField("folder_compare_mode", "fast")}
                          >
                            🚀 大小+修改时间 (快扫)
                          </button>
                        </div>
                      </div>

                      <div style={{ "margin-top": "12px" }}>
                        <span style={{ "font-size": "13px", "font-weight": "500" }}>
                          文件夹比对默认排除规则 (用逗号或分号分隔)：
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
                            💾 保存排除规则
                          </button>
                        </div>
                      </div>
                    </div>
                  </Show>

                  {/* Tab 4: Git & Reset */}
                  <Show when={activeTab() === "git"}>
                    <div class="settings-group">
                      <h4 class="settings-title">Git 工具链集成</h4>
                      <p style={{ "font-size": "12px", opacity: "0.8", "margin-bottom": "10px" }}>
                        将本机的 <code>fcompare</code> 注册为全局 Git 的 <code>difftool</code> 与 <code>mergetool</code>（完美接管 Git 内置的 Beyond Compare <code>bc</code> 驱动）。
                      </p>
                      <button class="bc-tool-btn active" onClick={handleInstallGit} style={{ padding: "6px 14px" }}>
                        🔗 一键注册并接管 Git difftool / mergetool
                      </button>

                      <h4 class="settings-title" style={{ "margin-top": "24px" }}>
                        缓存与历史清理
                      </h4>
                      <div style={{ display: "flex", gap: "10px" }}>
                        <button class="bc-tool-btn" onClick={handleClearHistory}>
                          🗑️ 清空路径输入历史与记录
                        </button>
                        <button class="bc-tool-btn" onClick={handleResetDefaults}>
                          🔄 恢复出厂默认设置
                        </button>
                      </div>
                    </div>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </div>

        <div class="modal-footer" style={{ "justify-content": "flex-end" }}>
          <button class="bc-tool-btn active" onClick={props.onClose}>
            完成并关闭
          </button>
        </div>

        <Show when={toast()}>
          <div class="floating-toast">{toast()}</div>
        </Show>
      </div>
    </div>
  );
};
