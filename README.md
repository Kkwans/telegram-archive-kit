<div align="center">

# Telegram Archive Kit

**把 Telegram 聊天变成一个完全离线、可检索、高颜值的本地网页档案库。**

以 [tdl](https://github.com/iyear/tdl) 为下载引擎，结合 Telegram Desktop 官方导出数据，
一条龙完成：媒体下载 → 档案库管理 → 生成美化静态网页，全程数据留在你自己的硬盘上。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.23%2B-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11%20x64-0078D6?logo=windows11&logoColor=white)](#-环境要求)
[![Release](https://img.shields.io/github/v/release/Kkwans/telegram-archive-kit?color=green)](https://github.com/Kkwans/telegram-archive-kit/releases)

简体中文 · [English](README_EN.md)

</div>

---

## 目录

- [这是什么](#这是什么)
- [功能特性](#-功能特性)
- [环境要求](#-环境要求)
- [快速开始](#-快速开始)
- [工作原理](#-工作原理)
- [档案库结构](#-档案库结构)
- [从源码构建](#-从源码构建)
- [文档](#-文档)
- [常见问题](#-常见问题)
- [参与贡献](#-参与贡献)
- [许可证](#-许可证)
- [致谢](#-致谢)

## 这是什么

**Telegram Archive Kit（TAK）** 是一个运行在 Windows 终端里的交互式归档工作台。它解决的问题很具体：

- Telegram Desktop 的官方导出功能可以拿到 `result.json` 和一份 HTML 网页，但**不能批量补齐媒体、不能增量更新、几十 GB 的聊天翻起来很慢**；
- [tdl](https://github.com/iyear/tdl) 下载能力很强，但**只负责下载，不负责整理和浏览**。

TAK 把两者接了起来：你提供 Telegram Desktop 导出的 `result.json`，TAK 负责登录、下载缺失媒体、维护一个可迁移的**档案库（Archive Library）**，并生成一套基于 [telegram-export-beautifier](https://github.com/Kkwans/telegram-export-beautifier) 美化方案的**离线静态网页（Prism Archive）**——支持多聊天聚合、全文搜索、跨页日期导航、相册灯箱、六种消息合并模式，直接双击 `index.html` 就能看，不需要任何服务端。

> ⚠️ 本工具仅用于**个人聊天记录的备份与查阅**，请遵守 Telegram 服务条款及所在地法律法规，请勿用于批量抓取他人数据。

## ✨ 功能特性

### 📥 智能媒体下载（基于 tdl）

- 二维码 / 验证码登录，tdl 缺失时**自动从官方 Release 下载安装**（SHA-256 校验）
- 按 Message ID + 实际文件大小计算**真正缺失**的媒体，断点续传、增量补齐，绝不重复下载已完成文件
- 无进展看门狗：下载卡在 0 B/s 时自动暂缓问题文件、重建队列继续下载其他文件（针对 [tdl#1071](https://github.com/iyear/tdl/issues/1071) 的工程化兜底）
- 疑难文件独立重试队列，重试传输策略可调；支持代理、并发（1–8）× 线程（1–16）自定义
- 实时进度：总速度、已用时、ETA、正在下载与最近完成列表

### 🏛️ 继承官方 ChatExport

- 已有 Telegram Desktop 导出的旧版 HTML（`messages.html` + `photos/` + `video_files/` + `files/`）？直接**继承**，按 Message ID 复用旧媒体，缺什么补什么
- 三种导入模式：**纳管**（同盘秒迁）、**引用原目录**（零复制，适合几十 GB 的历史导出）、**复制**（最安全）

### 📂 档案库管理

- 多聊天、多档案库：切换 / 新建 / 最近使用，每个聊天一个独立工作区（按 Chat ID 稳定识别）
- **库间合并**、**聊天抽取/复制**到另一个库、**整库迁移**——跨盘传输使用 `.tak-part` 临时文件 + 后台低 I/O 优先级，可中断、可续传、崩溃安全
- 同一聊天多次导入按 Message ID **增量合并**，每次导入原始 JSON 自动快照到 `source/history/`

### 🌐 Prism Archive 离线网页

- **六种消息呈现模式**：智能合并（默认）、原版（严格）、原版（还原）、同分钟合并、同发送者合并、媒体批次合并
- **全文搜索**（`/` 或 `Ctrl+K`，含媒体预览）、**跨页日期导航**、消息定位高亮
- **相册灯箱**：全页覆盖、缩放平移、键盘翻页、图片/视频筛选、打开原文件
- 图片懒加载、视频封面海报（FFmpeg 自动安装）、缺失媒体明确标注
- 桌面 / 移动端响应式适配，纯静态 `file://` 打开即可用，可放进 U 盘或 NAS

### 🔒 数据安全

- 已完成的媒体**永不删除**；0 字节残留自动清理；删除聊天须二次确认
- 所有操作写入 `Library/.logs/` 日志；构建完成后输出 `archive-report.json` 统计与缺失报告
- 档案库自包含、可整体备份迁移，不依赖绝对路径

### 🖥️ 友好的使用方式

- Windows 终端 TUI 界面，不需要命令行知识；把 `result.json` 或 ChatExport 目录**直接拖到 EXE 图标上**即可导入
- 同时提供 CLI 子命令：`version` / `selftest` / `build` / `verify`

## 🖥 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11（x64） |
| 运行时依赖 | 无（tdl、FFmpeg 均按需自动安装，也可手动放置） |
| 网络 | 登录与下载时需要；浏览网页完全离线 |
| 磁盘 | 取决于聊天媒体总量，建议预留空间并使用 NTFS 磁盘 |

## 🚀 快速开始

1. **获取 Telegram 数据**：在 Telegram Desktop 中打开目标聊天 → 右上角菜单 → **导出聊天记录** → 选择 *机器可读 JSON 格式*，导出得到 `result.json`（也可以只导出部分类型）。
2. **下载并运行**：从 [Releases](https://github.com/Kkwans/telegram-archive-kit/releases) 下载 ZIP，解压到任意目录，双击 `TelegramArchiveKit.exe`。
3. **选择档案库位置**：首次启动选择数据存放位置（默认 `文档\Telegram Archive Library`，也可选便携模式）。**以后升级版本不要删除这个目录。**
4. **登录**：菜单「Telegram 账号与会话」→ 扫二维码或输入验证码登录。
5. **导入并同步**：把 `result.json` 拖到 EXE 上（或在「添加/更新聊天」中选择），然后执行 **「一键完成」**——程序会自动预检环境、下载缺失媒体、生成缩略图和网页。
6. **开始浏览**：完成后自动打开档案库首页 `index.html`，也可随时从菜单打开。建议收藏到浏览器。

> 💡 已有官方 ChatExport HTML 导出？先执行「继承 Telegram 官方 ChatExport」，再导入当前的 `result.json`，旧媒体可以直接复用。详见 [使用指南](docs/USAGE.md)。
>
> 💡 升级版本：解压新版本到**新目录**，指向原档案库，执行「聊天管理 → 只重新生成网页」即可，无需重新下载任何媒体。

## 🔭 工作原理

```text
┌────────────────────────────── Telegram Archive Kit (TUI) ──────────────────────────────┐
│                                                                                        │
│  Telegram Desktop 导出        tdl（下载引擎，自动安装）              档案库 Archive Library  │
│  ┌────────────────┐          ┌──────────────────────┐        ┌────────────────────┐    │
│  │  result.json   ├─────────▶│  二维码/验证码登录    │───────▶│ chats/chat_名称__ID│    │
│  │  ChatExport/   │  消息源   │  多线程媒体下载      │  媒体   │  ├ source/        │    │
│  └────────────────┘          │  看门狗/断点续传     │        │  ├ media/  thumbs/ │    │
│                              └──────────────────────┘        │  └ data/ 索引/报告  │    │
│                                                                              │         │
│  telegram-export-beautifier（美化主题）        8 步构建：扫描→缩略图→索引→HTML │         │
│  ┌───────────────────────────────────────────────────────────────▼─────────┐            │
│  │            Prism Archive：index.html + messages*.html（纯静态离线）      │            │
│  │        搜索 · 日期导航 · 灯箱 · 六种合并模式 · 移动端适配                │            │
│  └──────────────────────────────────────────────────────────────────────────┘          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **TAK 本体**：Go 1.23+ 编写的单文件程序，**零第三方依赖**，Windows 控制台 TUI。
- **tdl**：运行时以子进程方式调用，不捆绑、不修改其代码；会话数据保存在 `%USERPROFILE%\.tdl`。
- **美化主题**：TAK 内置了 [telegram-export-beautifier](https://github.com/Kkwans/telegram-export-beautifier) 的完整主题（上游 commit `608ac73`），随程序分发、完全离线，不从网络拉取任何资源。
- **配置文件**：`%APPDATA%\TelegramArchiveKit\config.json`。

## 📁 档案库结构

```text
Telegram Archive Library/            ← 数据目录，升级程序时不要删除
├── index.html                       ← 档案库首页（唯一入口）
├── library.json / library-data.js   ← 聊天清单与统计
├── assets/                          ← 网页样式、脚本与美化主题
├── .logs/                           ← 运行日志（排查问题先看这里）
├── .runtime/                        ← 下载计划等临时文件
└── chats/
    └── chat_聊天名称__ChatID/        ← 每个聊天一个工作区
        ├── workspace.json           ← 聊天元数据
        ├── source/
        │   ├── result.json          ← 合并后的消息源数据
        │   └── history/             ← 每次导入的原始快照
        ├── media/                   ← 下载的媒体文件
        ├── thumbs/                  ← 720px 缩略图缓存
        ├── data/                    ← 消息数据、搜索索引、日期索引
        ├── messages.html …          ← 网页分页（strict-messages* 为严格模式）
        └── archive-report.json      ← 构建统计与缺失报告
```

完整的数据安全规则（合并、抽取、删除的行为边界）见 [数据与目录结构](docs/DATA_FORMAT.md)。

## 🛠 从源码构建

```bash
# 环境要求：Go 1.23+ 和 Python 3（仅构建脚本使用）
git clone https://github.com/Kkwans/telegram-archive-kit.git
cd telegram-archive-kit

# 一键构建（单元测试 → go vet → 交叉编译 Win64 → PE 校验）
python scripts/build_windows.py

# 产物：项目根目录下的 TelegramArchiveKit.exe（Windows 控制台程序）
```

也可以手动构建：

```bash
cd app/src
go test ./...
go vet ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o ../../TelegramArchiveKit.exe .
```

> 注意：不要加 `-H=windowsgui`，本程序需要真实控制台读取键盘输入。

## 📚 文档

| 文档 | 内容 |
|---|---|
| [使用指南](docs/USAGE.md) | 安装、登录、导入、ChatExport 继承、多磁盘管理、下载参数详解 |
| [数据与目录结构](docs/DATA_FORMAT.md) | 档案库布局、数据安全规则、配置文件位置 |
| [故障排查](docs/TROUBLESHOOTING.md) | 下载 0 B/s、登录失败、缩略图、网页缓存等常见问题 |
| [更新日志](CHANGELOG.md) | 每个版本的变更记录 |
| [第三方组件与来源](docs/THIRD_PARTY.md) | tdl、beautifier 等依赖的来源与许可证说明 |

## ❓ 常见问题

<details>
<summary><b>下载速度一直是 0 B/s？</b></summary>

这是 tdl 在 Windows 上的已知问题（[iyear/tdl#1071](https://github.com/iyear/tdl/issues/1071)）：登录检查正常不代表媒体所在的数据中心当前可用。TAK 默认 60 秒无真实进展即自动暂缓问题文件、重建队列继续下载，并进行一次诊断性重启。若仍反复失败，建议恢复默认 2×4 并发、显式配置代理，或查看 `Library/.logs/` 中 tdl 的原始日志。
</details>

<details>
<summary><b>升级新版本需要重新下载媒体吗？</b></summary>

不需要。把新版本解压到新目录，指向原档案库，执行「聊天管理 → 只重新生成网页」即可。档案库格式保持兼容，媒体和消息数据完全复用。
</details>

<details>
<summary><b>网页里的视频没有封面图？</b></summary>

视频封面需要 FFmpeg 解码。程序会在需要时自动下载安装 FFmpeg（约 109 MB，SHA-256 校验），如果网络受限可手动安装并确保 `ffmpeg -version` 可用后重新生成网页。没有封面的视频仍可直接播放，媒体本体不会丢失。
</details>

<details>
<summary><b>支持 Linux / macOS 吗？</b></summary>

TUI 依赖 Windows 控制台 API，目前面向 Windows 10/11 x64 设计。部分 CLI 子命令（`version`、`selftest`、`verify`）可在其他平台运行，但完整功能不支持。
</details>

更多问题见 [故障排查](docs/TROUBLESHOOTING.md)，或提交 [Issue](https://github.com/Kkwans/telegram-archive-kit/issues)。

## 🤝 参与贡献

欢迎 Issue 和 Pull Request！

- 报告问题请附上 `Library/.logs/` 中的相关日志（**注意先抹去个人聊天内容**）；
- 提交代码前请运行 `python scripts/build_windows.py` 确保测试与构建通过；
- 新功能建议先开 Issue 讨论再动手。

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。

第三方组件说明：

- [tdl](https://github.com/iyear/tdl)（AGPL-3.0）：作为**独立外部程序**在运行时自动安装调用，本项目不捆绑、不复制其代码，与其许可证义务不冲突；
- [telegram-export-beautifier](https://github.com/Kkwans/telegram-export-beautifier)（已归档，停止维护）：TAK 内置其完整主题（上游 commit `608ac73`），随程序分发，不依赖该仓库。

详见 [第三方组件与来源](docs/THIRD_PARTY.md)。

## 🙏 致谢

- [iyear/tdl](https://github.com/iyear/tdl) — 强大的 Telegram 下载工具，本项目的下载引擎
- [Kkwans/telegram-export-beautifier](https://github.com/Kkwans/telegram-export-beautifier) — 消息网页的美化主题
- [rand0451/Telegram-Chat-Export-Viewer](https://github.com/rand0451/Telegram-Chat-Export-Viewer) 等开源项目 — 架构设计参考

---

<div align="center">

如果这个项目对你有帮助，欢迎点一个 ⭐ Star

</div>
