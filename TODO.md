# FreeCompare

对标 Beyond Compare，全新构建一个开源的跨平台（Windows / macOS / Linux）比较与合并工具，聚焦核心功能与极致性能。

## 技术栈
- **桌面框架**：Tauri v2（跨平台系统原生 WebView，极小安装包体积 ~5MB）
- **核心引擎**：Rust (`freecompare-core` Workspace Crate，`ropey` + `imara-diff` + `similar` + `jwalk` + `encoding_rs`)
- **前端视图**：SolidJS + TypeScript + 自研虚拟滚动渲染引擎（无 VDOM 细粒度响应式 + SVG/Canvas 对齐曲线）

---

## 开发路线图 (Roadmap)

### Phase 1: 基础底座与 `freecompare-core` 核心算法引擎
- [x] 初始化 Cargo Workspace (`crates/core`, `crates/cli`, `src-tauri`) 与 `ui` (SolidJS + Vite + TypeScript) 工程骨架
- [x] 实现文本缓冲区与编码探测 (`buffer` 模块：支持 UTF-8 / UTF-16LE / UTF-16BE / GBK / GB18030，保留 LF / CRLF 信息，支持基于 Rope 的实时行编辑与 Undo/Redo)
- [x] 实现双文件行级 Diff 与虚拟对齐映射表 (`diff::two_way` 模块：基于 `imara-diff` Histogram/Myers 算法，生成 `AlignmentRow` 与 `TwoWayHunk` 索引，支持忽略空白/大小写)
- [x] 实现可视区切片按需计算接口 (`get_viewport_slice`：仅对屏幕可见行计算 `similar` 字符级/词级细粒度高亮区间)
- [x] 实现多线程文件夹扫描与对比引擎 (`folder` 模块：跨平台路径归一化、大小/修改时间快速对比、BLAKE3 内容哈希对比、Glob 过滤)
- [x] 实现三向合并算法引擎 (`diff::three_way` 模块：`Base` / `Left` / `Right` 三路对齐与冲突块检测、自动合并非冲突块)
- [x] 编写核心引擎完备的单元测试集 (`crates/core/tests/core_tests.rs`)

### Phase 2: 自研双栏虚拟滚动编辑器与双向合并 (Text Compare & 2-Way Merge)
- [x] 自研双栏同步虚拟滚动视口组件 (`VirtualDiffViewport`：定高极速行池渲染、水平/垂直同步滚动、Gap 空白占位斜纹行)
- [x] 中间 Gutter 对齐连接器 (`DiffConnectorGutter`：SVG 三次贝塞尔平滑连接色带 + `»` / `«` 块复制快捷按钮)
- [x] 右侧全局差异鸟瞰图 (`OverviewBar`：Canvas 全文件差异分布缩略条与当前视口高亮框)
- [x] 底部“当前选中行上下对照详情窗格”（BC 经典逐字符放大对比栏）
- [x] 差异导航与合并交互：上/下一处差异跳转、块复制到左/右、行内实时编辑重算 Diff、文件保存、比较规则切换（忽略空白/大小写、仅显示差异行）

### Phase 3: 文件夹对比与同步 (Folder Compare & Sync)
- [x] 双栏对称虚拟树形表格 (`FolderDiffView`：支持目录展开/折叠、状态向上冒泡)
- [x] 比较状态视觉标识与过滤器（全部 / 仅差异 / 仅孤立项 / 仅相同项 / 文件名过滤）
- [x] 双击文件行在新标签页（Tab）中联动打开 Phase 2 的文本对比视图
- [x] 批量文件同步操作：复制到左/右、一键镜像同步

### Phase 4: 三向合并视图与 CLI / Git 集成 (3-Way Merge)
- [x] 四窗格三向合并视图（上方 Left / Base / Right 三栏同步视图 + 下方 Merged Output 输出窗格）
- [x] 冲突块一键解决操作（采用 Left / 采用 Base / 采用 Right / 合并双方）与冲突计数状态栏
- [x] CLI 命令行参数解析 (`crates/cli/src/main.rs`：支持 2 路径文件/目录对比与 3/4 路径 `git mergetool` 调用)

### Phase 5: 语法高亮、会话管理与多平台构建发布
- [x] 增量语法高亮与深色/浅色主题切换（Dark / Light Mode）
- [x] 首页新建会话引导与历史会话卡片恢复 (`HomeView.tsx`)
- [x] GitHub Actions 三端矩阵测试与构建配置 (`.github/workflows/release.yml`：Windows / macOS / Linux)
