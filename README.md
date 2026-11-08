<div align="center">

# Telegram Archive Kit

**把 Telegram 聊天变成一个完全离线、可检索、可长期保存的本地网页档案库。**

Windows 桌面客户端 + 终端版。以 [tdl](https://github.com/iyear/tdl) 为下载引擎，兼容 Telegram Desktop 官方导出，
把「媒体下载 → 增量归档 → 网页生成 → 日常浏览」串成一条完整的本地流水线，全程数据留在你自己的硬盘上。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-3.0-2f6bff.svg)](CHANGELOG.md)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D6.svg)](#-环境要求)
[![Go](https://img.shields.io/badge/Go-1.26%2B-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![Release](https://img.shields.io/github/v/release/Kkwans/telegram-archive-kit?color=green)](https://github.com/Kkwans/telegram-archive-kit/releases)

简体中文 · [English](README_EN.md) · [下载最新版本](https://github.com/Kkwans/telegram-archive-kit/releases/latest) · [更新日志](CHANGELOG.md)

</div>

---

## 目录

- [这是什么](#这是什么)
- [3.0 亮点](#-30-亮点)
- [功能特性](#-功能特性)
- [环境要求](#-环境要求)
- [快速开始](#-快速开始)
- [在线聊天与增量归档](#-在线聊天与增量归档)
- [下载前统计](#-下载前统计)
- [工作原理](#-工作原理)
- [档案库结构](#-档案库结构)
- [从源码构建](#-从源码构建)
- [文档](#-文档)
- [数据、隐私与安全](#-数据隐私与安全)
- [常见问题](#-常见问题)
- [参与贡献](#-参与贡献)
- [许可证](#-许可证)
- [致谢](#-致谢)

## 这是什么

**Telegram Archive Kit（TAK）** 是一个 Windows 桌面归档客户端（另附终端版 `TelegramArchiveKit-Console.exe`，供排障与服务器场景使用）。它解决的问题很具体：

- Telegram Desktop 的官方导出功能可以拿到 `result.json` 和一份 HTML 网页，但**不能批量补齐媒体、不能增量更新、几十 GB 的聊天翻起来很慢**；
- [tdl](https://github.com/iyear/tdl) 下载能力很强，但**只负责下载，不负责整理和浏览**。

TAK 把两者接了起来：你提供 Telegram Desktop 导出的 `result.json`，TAK 负责登录、下载缺失媒体、维护一个可迁移的**档案库（Archive Library）**，并生成一套基于 [telegram-export-beautifier](https://github.com/Kkwans/telegram-export-beautifier) 美化方案的**离线静态网页（Prism Archive）**——支持多聊天聚合、全文搜索、跨页日期导航、相册灯箱、六种消息合并模式，直接双击 `index.html` 就能看，不需要任何服务端。

> ⚠️ 本工具仅用于**个人聊天记录的备份与查阅**，请遵守 Telegram 服务条款及所在地法律法规，请勿用于批量抓取他人数据。

## ✨ 3.0 亮点

- **在线聊天**：直接复用本机 tdl 会话，通过 gotd 读取完整对话列表、类型、未读、置顶、最后消息与真实头像；支持私聊 / 群组 / 频道 / 归档夹筛选与搜索。
- **在线增量归档**：对已归档聊天按最大 Message ID 增量拉取，只合并真正的新消息；预览会同时核对**档案库实际缺失的媒体**，即使上次下载被停止、`result.json` 已更新，也不会误报「已是最新」。
- **所有下载先统计**：在线更新、按 `result.json` 补全、一键同步、继续下载、同步全部缺失，都会先打开同一套预览弹窗，展示待下载媒体的数量、类型、预计大小与磁盘剩余空间；空间不足时直接阻止创建任务。
- **远程档案库**：支持 SMB / UNC 网络位置，内置 rclone 挂载向导与 SSHFS-Win 引导；远程库离线时明确提示，缩略图可在本机缓存。
- **查看器增强**：图片单击放大 / 双击恢复、滚轮锚点缩放、拖动平移；视频支持 HTML 全屏与窗口级沉浸全屏、倍速、画中画、自动连播。

## ✨ 功能特性

### 🖥️ 桌面客户端

- 双击 `TelegramArchiveKit.exe` 直接进入桌面客户端：默认浅色、可切深色，无边框标题栏 + Win11 Mica，关闭后驻留系统托盘。
- 首页仪表盘：媒体构成环图、存储占用、媒体最多的聊天、最近聊天与最近任务，以及同步 / 导入 / 打开归档库 / 账号快捷入口。
- 在线聊天：复用本机 tdl 会话读取 Telegram 对话列表、未读、置顶与真实头像，可对已归档聊天直接增量更新。
- 任务中心：导入、官方导出继承、导出到另一库、重建网页、合并档案库、在线归档、补全媒体都在后台运行，可查看进行中 / 完成 / 失败与百分比，完成时 toast 并在任务中心留档。
- 下载看板：进度环、阶段条、实时/平均/峰值速度、速度曲线、预计剩余、本轮完成、并发 × 线程与重试计数；逐项任务表显示文件名、类型、百分比、已传/期望、单项速度、单项 ETA、耗时和卡死状态。
- 应用内登录：二维码直接显示在窗口里用手机扫描；手机号验证码与两步验证也可在应用内完成，输入回显打码、不落盘，取消后没有孤儿进程。
- 聊天与档案库：导入 `result.json`、继承官方 ChatExport、一键同步、只重建网页、完整性核对、导出/删除、切换/新建/合并档案库、诊断与日志查看，功能与终端版一一对应。
- 远程档案库：SMB / UNC 网络位置、rclone 挂载与 SSHFS 引导；远程离线时显示横幅，缩略图可缓存在本机。
- 媒体查看器：图片/视频/音频/文档网格，按类型筛选；图片单击放大、双击恢复，滚轮锚点缩放、拖动平移；视频/音频内嵌播放，支持 HTML 全屏与窗口级全屏、倍速、画中画与自动连播。
- Ctrl+K 命令面板、把 `result.json` 或 ChatExport 目录拖进窗口、第二实例参数转交首窗、任务栏下载进度。
- 数据安全：桌面端运行时终端版会拒绝同时写入同一档案库（命名互斥体 + 会话文件），设置原子写入；排障可设 `TAK_ALLOW_CONCURRENT=1`。

### 📥 智能媒体下载（基于 tdl）

- 二维码 / 验证码登录，tdl 缺失时**自动从官方 Release 下载安装**（SHA-256 校验）
- 按 Message ID + 实际文件大小计算**真正缺失**的媒体，断点续传、增量补齐，绝不重复下载已完成文件
- 无进展看门狗：下载卡在 0 B/s 时自动暂缓问题文件、重建队列继续下载其他文件（针对 [tdl#1071](https://github.com/iyear/tdl/issues/1071) 的工程化兜底）
- 疑难文件独立重试队列，重试传输策略可调；支持代理、并发（1–8）× 线程（1–16）自定义
- 实时进度：总速度、已用时、ETA、正在下载与最近完成列表
- **下载前统计**：任何下载入口都会先展示待补媒体数量、类型与占用，并检查磁盘剩余空间；空间不足时不会创建任务

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
| 运行库 | 桌面端使用系统 WebView2（Win11 自带；Win10 如缺失请安装 Microsoft Edge WebView2 Runtime） |
| 网络 | 登录与下载时需要；浏览网页完全离线 |
| 磁盘 | 取决于聊天媒体总量，建议预留空间并使用 NTFS 磁盘 |

## 🚀 快速开始

1. **获取 Telegram 数据**：在 Telegram Desktop 中打开目标聊天 → 右上角菜单 → **导出聊天记录** → 选择 *机器可读 JSON 格式*，导出得到 `result.json`（也可以只导出部分类型）。
2. **下载并运行**：从 [Releases](https://github.com/Kkwans/telegram-archive-kit/releases) 下载 ZIP，解压到任意目录，双击 `TelegramArchiveKit.exe` 打开桌面客户端（终端版为 `TelegramArchiveKit-Console.exe`，两者共用档案库）。
3. **选择档案库位置**：首次启动选择数据存放位置（默认 `文档\Telegram Archive Library`，也可在终端版选便携模式）。**以后升级版本不要删除这个目录。**
4. **登录**：打开「账号」页 → 用手机扫描窗口里的二维码；也可改用手机号验证码登录。
5. **导入并同步**：把 `result.json` 或 ChatExport 文件夹拖进窗口（或在「聊天」页导入），然后执行 **「同步所选」**——先确认统计结果，再自动下载缺失媒体、生成缩略图和网页。
6. **开始浏览**：完成后点「打开归档库」查看 `index.html`，也可随时从托盘菜单打开。建议收藏到浏览器。

> 💡 已有官方 ChatExport HTML 导出？先执行「继承 Telegram 官方 ChatExport」，再导入当前的 `result.json`，旧媒体可以直接复用。详见 [使用指南](docs/USAGE.md)。
>
> 💡 升级版本：解压新版本到**新目录**，指向原档案库，执行「聊天管理 → 只重新生成网页」即可，无需重新下载任何媒体。

## 🌐 在线聊天与增量归档

3.0 新增「在线聊天」一级页面，直接复用本机 tdl 会话（不会额外保存密码）：

- 读取完整对话列表、类型、未读、置顶、最后消息与真实头像；
- 支持私聊 / 群组 / 频道 / 归档夹筛选、搜索与排序；
- 对已归档聊天执行「在线更新」：按本地最大 Message ID 增量拉取，只合并新消息；
- 预览弹窗展示新增消息、媒体类型构成与预计大小；
- **同时核对档案库真实缺失的媒体**：如果上次下载被停止，即使 `result.json` 已是最新，也会提示「消息已最新，本地仍缺 N 个媒体」，并可直接补全；
- 下载前检查磁盘剩余空间；空间不足时禁用操作，不会创建必然失败的任务。

## 📊 下载前统计

3.0 起，所有会写入磁盘的下载动作都先统计、再执行，并复用同一个预览弹窗：

| 入口 | 统计内容 | 空间不足时 |
|---|---|---|
| 在线更新 | 新增消息 + 本地缺失媒体、类型构成、预计大小 | 禁用「开始归档」 |
| 按 result.json 补全 | 本地缺失媒体、类型构成、预计大小 | 禁用「开始补全」 |
| 同步所选 / 一键同步 | 当前聊天缺失媒体、类型构成、预计大小 | 禁用「开始同步」 |
| 同步全部缺失 | 所有缺失聊天的合计媒体数与占用 | 禁用「开始同步」 |
| 任务中心「继续下载」 | 该聊天剩余缺失媒体、类型构成、预计大小 | 禁用「开始同步」 |

空间检查使用与下载器相同的已知文件大小口径（`result.json` 中的 `file_size` 汇总），并预留 256 MB 余量；未知大小的媒体不计入预计值，实际下载仍可能略高。

## 🔭 工作原理

```text
┌─────────────────────── Telegram Archive Kit（桌面客户端 / 终端版）───────────────────────┐
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

- **TAK 本体**：Go 编写的单文件程序。终端版保持 Go 1.23+ 与**零第三方依赖**；桌面端为独立模块（Wails v3 + React 19），二者共用同一归档引擎。
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
        ├── media/                   ← 图片 / 视频 / 音频
        ├── files/                   ← 非媒体文档（zip、pdf、贴纸等）
        ├── thumbs/                  ← 720px 缩略图缓存
        ├── data/                    ← 消息数据、搜索索引、日期索引
        ├── messages.html …          ← 网页分页（strict-messages* 为严格模式）
        └── archive-report.json      ← 构建统计与缺失报告
```

完整的数据安全规则（合并、抽取、删除的行为边界）见 [数据与目录结构](docs/DATA_FORMAT.md)。

## 🛠 从源码构建

```bash
# 环境要求：Go 1.26.4+（桌面端模块）、Node.js 20+ / npm（前端）、Python 3（构建脚本）
git clone https://github.com/Kkwans/telegram-archive-kit.git
cd telegram-archive-kit

# 一键构建两个客户端（终端版测试/vet → 前端 npm ci + build → 两个 Win64 目标 → PE 子系统校验）
python scripts/build_windows.py --target all

# 产物：
#   TelegramArchiveKit.exe          桌面客户端（Windows GUI，子系统 2）
#   TelegramArchiveKit-Console.exe  终端版（控制台，子系统 3）
```

也可以分开构建：

```bash
# 终端版：仍是零依赖、可离线
cd app/src
go test ./...
go vet ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o ../../TelegramArchiveKit-Console.exe .

# 桌面端：前端 + Wails
cd desktop/frontend && npm ci && npm run build && cd ..
go build -trimpath -tags production -ldflags="-s -w -H windowsgui" -o ../../TelegramArchiveKit.exe .

# 打包 zip（本地验收用）
python scripts/build_windows.py --target all --zip
```

> 终端版需要真实控制台读取键盘输入，**不要**给 `-Console.exe` 加 `-H=windowsgui`；桌面端则必须使用 `-H windowsgui` + `-tags production`。

## 📚 文档

| 文档 | 内容 |
|---|---|
| [文档索引](docs/README.md) | 所有文档的导航 |
| [使用指南](docs/USAGE.md) | 安装、登录、导入、ChatExport 继承、多磁盘管理、下载参数详解 |
| [在线能力与增量归档](docs/ONLINE_TDL_3.0.md) | tdl 集成、gotd 在线会话、在线归档与合并策略 |
| [远程档案库](docs/REMOTE_LIBRARY_3.0.md) | SMB / UNC、rclone 挂载、SSHFS、缓存与离线行为 |
| [数据与目录结构](docs/DATA_FORMAT.md) | 档案库布局、数据安全规则、配置文件位置 |
| [存储与 SQLite](docs/STORAGE_SQLITE.md) | 索引与存储设计 |
| [故障排查](docs/TROUBLESHOOTING.md) | 下载 0 B/s、登录失败、缩略图、网页缓存等常见问题 |
| [更新日志](CHANGELOG.md) | 每个版本的变更记录 |
| [第三方组件与来源](docs/THIRD_PARTY.md) | tdl、beautifier 等依赖的来源与许可证说明 |

## 🔐 数据、隐私与安全

- 所有聊天、媒体与索引都保存在你选择的本地或远程档案库中；TAK 不上传任何聊天内容；
- 登录会话由 tdl 保存在 `%USERPROFILE%\.tdl`，TAK 不额外存储密码；
- 已完成的媒体**永不删除**；0 字节残留自动清理；删除聊天须二次确认；
- 所有操作写入 `Library/.logs/`；构建完成后输出 `archive-report.json` 统计与缺失报告；
- 桌面端运行时终端版会拒绝同时写入同一档案库（命名互斥体 + 会话文件），设置原子写入；排障可设 `TAK_ALLOW_CONCURRENT=1`；
- 请妥善保管档案库，网页中包含你的聊天内容与媒体。

## ❓ 常见问题

<details>
<summary><b>下载速度一直是 0 B/s？</b></summary>

这是 tdl 在 Windows 上的已知问题（[iyear/tdl#1071](https://github.com/iyear/tdl/issues/1071)）：登录检查正常不代表媒体所在的数据中心当前可用。TAK 默认 60 秒无真实进展即自动暂缓问题文件、重建队列继续下载，并进行一次诊断性重启。若仍反复失败，建议恢复默认 2×4 并发、显式配置代理，或查看 `Library/.logs/` 中 tdl 的原始日志。
</details>

<details>
<summary><b>在线更新显示「已是最新」，但本地媒体并不完整？</b></summary>

3.0 起不会只看 `result.json`：预览会同时检查档案库实际缺失的媒体。若上次下载被停止，会显示「消息已最新，本地仍缺 N 个媒体」，点击「补全缺失媒体」即可；也可以直接使用聊天页的「按 result.json 补全」。
</details>

<details>
<summary><b>为什么现在下载前都会弹统计窗口？</b></summary>

为了避免「任务创建后才发现磁盘不足」或「以为已下载完整、实际缺文件」，所有下载入口都会先统计待补媒体与占用空间。确认后才会创建任务；空间不足时按钮会直接禁用。
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
