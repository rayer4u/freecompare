# FreeCompare

对标 Beyond Compare，全新构建的开源跨平台（Windows / macOS / Linux）文件对比、双向/三向合并与目录同步工具。受[OpenCompare](https://github.com/chaxiu/OpenCompare)，解决bcompare的对比不准问题，测试AI的快速迭代能力

## 核心特性
1. **自研双栏虚拟滚动引擎 (`VirtualDiffViewport`)**：
   - 定高极速虚拟行池 + 水平/垂直双栏同步滚动 + Gap 斜纹对齐占位行。
   - 中间 Gutter 绘制 **SVG 三次贝塞尔平滑连接色带** 与 `»` / `«` 块复制快捷按钮。
   - 右侧 **Canvas 全局差异鸟瞰图 (Overview Bar)** 与底部 **单行逐字符放大对比详情栏**。
2. **Rust 高性能核心 (`freecompare-core`)**：
   - 基于 `ropey` + `imara-diff` (Histogram 算法) + `similar` (字符级细粒度二次 Diff)。
   - 自动识别 `UTF-8` / `UTF-8 BOM` / `UTF-16 LE/BE` / `GB18030` 编码与 `LF` / `CRLF` 换行符。
3. **文件夹对比与同步 (`FolderDiffView`)**：
   - 支持 **BLAKE3 内容哈希深度比对** 与 **大小+时间戳快扫模式**。
   - 支持状态过滤（全部 / 仅差异 / 仅孤立项 / 仅相同）与双击直接穿透打开文本对比标签页。
4. **三向合并 (`Merge3WayView` & `fc` CLI)**：
   - 四窗格三向合并（Left / Base / Right + Merged Output），支持一键解决冲突与 `git mergetool` 命令行调用。

## 快速运行指南

```bash
# 1. 运行 Rust 核心引擎与 CLI 全量测试
cargo test --workspace

# 2. 直接通过命令行唤起 UI 窗口对比目录或文件
./target/debug/fcompare crates/core crates/cli
./target/debug/fcompare Cargo.toml README.md

# 3. 仅在终端输出统计摘要（不弹窗）
./target/debug/fcompare Cargo.toml README.md --cli
```
