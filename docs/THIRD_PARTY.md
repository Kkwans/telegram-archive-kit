# 第三方组件与来源

本项目（Telegram Archive Kit，下称 TAK）本体为原创代码，基于 [MIT License](../LICENSE) 开源。本文档说明 TAK 依赖或参考的第三方项目及其许可证情况。

## 运行时依赖

### tdl（下载引擎）

- 仓库：<https://github.com/iyear/tdl>
- 上游许可证：**AGPL-3.0**
- 使用方式：TAK **不捆绑、不复制、不修改** tdl 的代码。tdl 作为独立的外部程序，在运行时由 TAK 从其官方 GitHub Release 自动下载安装（SHA-256 校验），并以子进程方式调用。TAK 与 tdl 之间仅通过命令行接口交互，属于独立的进程间通信，不构成代码层面的衍生。

### telegram-export-beautifier（网页美化主题，已归档）

- 仓库：<https://github.com/Kkwans/telegram-export-beautifier>（**已归档，停止维护**；最终版本 v3.2）
- 使用方式：TAK **内置**了基于该主题优化改写的轻量版本（`app/src/ui/beautifier-theme.css` / `.js`），构建档案库时由程序直接写入 `assets/beautifier/`，完全离线，不拉取任何线上资源。
- 版权说明：上游仓库未声明开源许可证，内容版权归 Kkwans 所有；TAK 的内置主题由同一作者基于其优化改写，随 TAK 以 MIT 许可证分发。

### FFmpeg（媒体解码，可选）

- 来源：<https://www.gyan.dev/ffmpeg/builds/>（FFmpeg 官网推荐的 Windows 构建提供方）
- 使用方式：仅在需要生成视频封面/解码 HEIC/WebP 时，由 TAK 自动下载 `ffmpeg-release-essentials.zip`（附带官方 SHA-256 校验），仅解压 `bin/ffmpeg.exe` 安装到用户目录。也可手动安装。
- 上游许可证：FFmpeg 为 LGPL/GPL，具体取决于构建配置；TAK 仅以独立进程调用其可执行文件。

## 架构参考（仅参考，未使用代码）

- <https://github.com/rand0451/Telegram-Chat-Export-Viewer>
- <https://github.com/cnafateh/telegram-archive-viewer>
- <https://github.com/deathmaz/tg-export>

## TUI 技术选型说明

TAK 曾评估 [Bubble Tea / Bubbles](https://github.com/charmbracelet/bubbletea) 作为终端界面框架，最终未采用：TAK 的终端界面规模较小，直接使用 Windows VT 备用屏幕缓冲区与原生 `ReadConsoleInputW` 即可实现同等渲染模型，避免引入额外运行时依赖。因此 TAK 的 Go 模块**零第三方依赖**。

## 相关上游问题

- [iyear/tdl#1071](https://github.com/iyear/tdl/issues/1071)：Windows 下载可能长期停留在 0 B/s 且不报错。TAK 针对该问题实现了外层无进展看门狗与自适应重启策略，而非无限等待。
