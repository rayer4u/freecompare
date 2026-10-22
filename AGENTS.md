# FreeCompare 开发与 Agent 协作规范 (AGENTS.md)

本文件定义了 Agent 在参与 FreeCompare 项目架构设计、代码编写与功能演进时必须严格遵守的架构原则、防坑准则与工程规范，避免后续方案出现考虑不全或平台断层。

---

## 1. 跨平台第一原则 (Cross-Platform First)

FreeCompare 的核心定位是全平台（Linux、macOS、Windows）单二进制原生工具，严禁做出单平台偏向假设：

1. **零外部胶水依赖**：
   - 严禁引入外部系统脚本或未打包的第三方 CLI 依赖（如 `bash`、`zsh`、`jq`、`cmp`、`mktemp`、`python3` 等）。
   - 所有逻辑（包括数据解析、临时文件生成、比对计算、AI 拦截守卫等）必须使用纯 Rust 或前端 TypeScript 自身完整闭环实现。
2. **命令与钩子统一**：
   - 任何面向 Antigravity (agy) 或外部系统的集成，必须封装为 `fcompare <subcommand>`（如 `fcompare guard`），禁止在 hooks 中直接调用 `.sh` 或 `.bat`。
3. **路径归一化 (`expand_path`)**：
   - 所有的磁盘文件与目录读取，底层必须经由 `expand_path` 处理，同时兼容 Unix `$HOME` 与 Windows `%USERPROFILE%`，支持 `~` 家目录缩写展开，以及 `\` / `/` 斜杠路径规整。

---

## 2. 数据层与视图滤镜解耦原则 (Data vs. View Decoupling)

严禁在获取原始文件内容时借道包含 UI 过滤器的逻辑：

1. **独立读文件 RPC**：
   - 单侧或双侧加载文件内容必须走专用的 `read_text_file` 接口，严禁借用 `open_two_way_files` 自比来提取行内容。
2. **严防滤镜置空 Bug**：
   - 当用户在 UI 开启了“≠ 仅差异”(`show_only_diffs: true`) 时，比对引擎会过滤掉所有相同行；底层加载文件绝对不可受此状态污染，必须保证完整大文件（哪怕上万行）全量保真载入。

---

## 3. 交互与状态控制闭环原则 (Interaction Completeness)

所有面向用户的审查、对比与合并操作，必须遵循双向完备性与明确的状态码退出规范：

1. **审查操作双向闭环**：
   - 任何审查或确认界面必须提供对称的操作通道，不仅有“通过/保存”，必须有显式的“拒绝/放弃”操作（如 UI 上的 `✅ 通过审查` 与 `❌ 拒绝修改`）。
2. **退出码 (Exit Code) 契约**：
   - `Exit Code 0`：明确表示审查通过、合并完成且已保存、或操作无误放行；
   - `Exit Code != 0` (如 `1`)：明确表示用户取消、中断或拒绝变更。
3. **快捷键对称与防呆**：
   - 支持键盘快捷操作（如 `Esc` 通过并退出，`Shift + Esc` 拒绝并退出）；
   - 路径与文本输入框除了监听敲击回车（`Enter`），必须同时监听失焦（`onBlur`），避免用户鼠标点击切换后因未敲回车导致内容不生效。

---

## 4. 单二进制自包含分发 (Self-Contained Distribution)

1. **构建内嵌机制**：
   - 前端资源编译产物（`ui/dist`）必须在编译期通过 `crates/cli/build.rs` 嵌入二进制，保证产物拷贝即可运行。
2. **联动构建纪律**：
   - 一旦修改了 `ui/src/` 中的代码，在测试或发布前必须先执行 `npm --prefix ui run build`，再运行 `cargo check` / `cargo test`。

---

## 5. 审查守卫与安全隔离边界 (Guard & Safety Sandbox)

1. **内部系统文件自动放行**：
   - 审查拦截必须对 `.git/`、`.agents/`、`.gemini/`、`.system_generated/`、临时日志目录设置强制放行白名单，严防守卫修改自身配置时引发递归死锁。
2. **标准流纯净性**：
   - `fcompare guard` 等协议子命令的标准输出 (`stdout`) 必须仅包含机器可解析的标准 JSON 响应，所有提示、UI 启动信息与排错日志必须全部重定向到 `stderr`。
