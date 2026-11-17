# FreeCompare 工程规范与 Agent 实战手册 (AGENTS.md)

本文件面向参与 FreeCompare 开发的 Agent，聚焦**架构边界、标准命令、实战防坑与硬性红线**。

---

## 1. 仓库地图与职责边界

| 路径 | 职责 |
| :--- | :--- |
| `crates/core` | 纯 Rust 核心引擎：`buffer.rs`（Rope + 编码/换行符 + `expand_path`）、`diff/`（双向/三向算法）、`folder.rs`（目录比对与同步）、`cli_args.rs`（BC/Git 参数兼容）。 |
| `src-tauri/src/lib.rs` | 统一后端 `AppBackend` 与 `dispatch_rpc` 调度器，Tauri 桌面端与 CLI HTTP 服务共用同一套 RPC 接口。 |
| `crates/cli` | `fcompare` 单二进制入口：`build.rs` 编译期嵌入 `ui/dist`；`main.rs` 提供 HTTP+SSE 服务、浏览器 App 窗口拉起、`--install-git`、`-qc` 及 `guard` 子命令。 |
| `ui/src/` | SolidJS + TypeScript 前端：`App.tsx`（标签页/全局快捷键/窗口几何）、`bridge.ts`（RPC 与本地 Diff 客户端）、`engine/VirtualDiffViewport.tsx`、`views/`（文本/目录/三向视图）。 |

---

## 2. 标准验证与本地更新命令

修改 `ui/src/` 后**必须先构建前端再编译/测试 Rust**（否则二进制内嵌的是旧版 `ui/dist`）：

```bash
# 1. 前端单元测试（依赖 Node 22+ --experimental-strip-types）与构建
npm --prefix ui test
npm --prefix ui run build

# 2. Rust 全工作区测试（core + rpc + cli e2e）
cargo test --workspace

# 3. 覆盖更新本机安装的 fcompare（每次完成代码修改后的标准流程，无需额外确认直接执行）
cargo install --path crates/cli --force
```

> **提示**：`node --test` 仅验证纯函数与 mock DOM；凡涉及 `App.tsx`、视图挂载或 `createEffect` 的改动，必须用无头浏览器（如 `fcompare --no-open-window` + Chromium）或真实窗口确认零运行时异常。

---

## 3. 跨平台与单二进制硬红线

1. **零外部胶水与 C 库依赖**：
   - 严禁依赖 `bash`、`zsh`、`jq`、`cmp`、`python3`、`.sh`/`.bat` 脚本，或系统级 C 动态库（如 `libssh2`、`openssl`）；所有能力必须使用纯 Rust 或前端 TS 闭环实现。
2. **路径与 URI 边界**：
   - 本地磁盘路径必须经过 `expand_path`（兼容 `~`、`$HOME`、`%USERPROFILE%` 及 `\`/`/`）。
   - 远程 URI（如 `sftp://...`）必须原样保留并走 VFS 分发，严禁被本地 `expand_path` 改写破坏。
3. **单一自包含分发**：
   - 所有前端产物通过 `crates/cli/build.rs` 内嵌进单二进制，Release 压缩包不额外附带散落的 `ui/dist`。

---

## 4. 实战防坑清单（高频回归红线）

1. **SolidJS `createEffect` 防自循环**：
   - 在 `createEffect` 中调用会同时读取并写回 Signal（如 `options()`、`rowFilter()`、`excludeGlobs()`）的函数时，**必须使用 `untrack(() => ...)` 包裹**，否则会触发 `RangeError: Maximum call stack size exceeded`，导致页面停在 Home 页且全局快捷键失效。
2. **键盘 `Esc` / `Shift+Esc` 分层契约**：
   - 模态框与下拉菜单在 `document` **捕获阶段**消费 `Escape`；
   - 子视图（`TextDiffView` / `FolderDiffView` / `Merge3WayView`）仅消费无 `Shift` 的 `Escape` 关闭内部弹层，**遇到 `e.shiftKey` 必须放行**给 `App.tsx` 的 `window` 全局监听执行拒绝/退出（`Exit Code 1`）。
3. **数据与视图解耦 & 格式保真**：
   - 读文件必须走独立 `read_text_file` 接口，禁止借道 `open_two_way_files`（避免被 `show_only_diffs` 滤镜置空），且禁止使用 `.catch()` 静默吞掉读文件错误。
   - 读写与保存必须完整保留原文件编码（`UTF-8` / `UTF-8 BOM` / `UTF-16 LE/BE` / `GB18030`）与换行符（`LF` / `CRLF` / `CR`）。
4. **输入框防呆与退出码闭环**：
   - 路径与配置输入框须同时监听 `Enter` 与 `onBlur`（仅值变更时触发）。
   - 审查/合并视图须提供对称的通过（`Exit Code 0`）与拒绝/取消（`Exit Code != 0`）通道。
5. **UI 克制与交互直觉**（**触发条件**：准备新增或调整任何按钮、提示、菜单、浮层或交互状态前，必须先查阅 `README.md`「界面与交互设计原则」）：
   - **如无必要，勿增控件**：能靠现有高亮、快捷键或右键菜单表达的，绝不往主视图里塞新按钮、文字徽标或常驻提示条。
   - **对齐 Beyond Compare，高危操作收进右键**：常规交互（点击、焦点、导航）对齐 `bcompare` 直觉，不自创复杂状态；整目录覆盖、删除等高危动作收进右键菜单，不放行内裸按钮。
6. **修 Bug 与新功能必须配齐测试用例**：
   - 凡修复 Bug 或新增、调整功能，**必须同步新增或更新对应的自动化测试用例**（前端补入 `ui/tests/*.test.ts`，后端/核心引擎补入 `crates/` 或 `src-tauri/` 单元测试），严禁只改代码不补测试。

---

## 5. AI 审查守卫 (`fcompare guard`) 边界

- **白名单防死锁**：必须自动放行 `.git/`、`.agents/`、`.gemini/`、`.system_generated/` 及系统临时目录（`std::env::temp_dir()`）。
- **标准流纯净**：`stdout` 仅输出机器可解析的 JSON（如 `{"decision":"allow"}`），一切日志与提示必须输出到 `stderr`。

---

## 6. Git 提交规范

当用户要求 AI 执行 Git 提交时，必须严格遵守：
1. **Author 隔离**（严禁使用 `@google.com` 或 `*@users.noreply.github.com`）：
   ```bash
   git commit --author="Antigravity <antigravity@ai.invalid>" -m "<type>: <中文描述>"
   ```
2. **语言与风格**：`<type>` 保留英文（`feat` / `fix` / `docs` / `chore`），正文与描述**必须使用中文**、简洁纯文本；除非用户要求，提交信息中不带版本号。
