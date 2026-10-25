<div align="center">

# Telegram Archive Kit

**Turn your Telegram chats into a fully offline, searchable, beautifully rendered local web archive.**

Powered by [tdl](https://github.com/iyear/tdl) as the download engine and Telegram Desktop's official export data,
it handles everything end to end: media download → archive management → a gorgeous static website. All data stays on your own disk.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.23%2B-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11%20x64-0078D6?logo=windows11&logoColor=white)](#-requirements)
[![Release](https://img.shields.io/github/v/release/Kkwans/telegram-archive-kit?color=green)](https://github.com/Kkwans/telegram-archive-kit/releases)

[简体中文](README.md) · English

</div>

---

## Contents

- [What is this?](#what-is-this)
- [✨ Features](#-features)
- [🖥 Requirements](#-requirements)
- [🚀 Quick Start](#-quick-start)
- [🔭 How It Works](#-how-it-works)
- [📁 Archive Library Layout](#-archive-library-layout)
- [🛠 Building from Source](#-building-from-source)
- [📚 Documentation](#-documentation)
- [❓ FAQ](#-faq)
- [🤝 Contributing](#-contributing)
- [📄 License](#-license)
- [🙏 Acknowledgements](#-acknowledgements)

## What is this?

**Telegram Archive Kit (TAK)** is an interactive archiving workbench that runs in a Windows terminal. It solves a specific problem:

- Telegram Desktop's built-in export gives you a `result.json` and a folder of HTML pages, but it **can't batch-download missing media, can't update incrementally, and gets painfully slow with chats tens of gigabytes large**;
- [tdl](https://github.com/iyear/tdl) is a powerful downloader, but it **only downloads — it doesn't organize or present anything**.

TAK bridges the two: you supply the `result.json` exported from Telegram Desktop, and TAK takes care of login, downloading missing media, maintaining a portable **Archive Library**, and generating an offline static website (**Prism Archive**) built on the beautification scheme of [telegram-export-beautifier](https://github.com/Kkwans/telegram-export-beautifier) — multi-chat dashboard, full-text search, cross-page date navigation, media lightbox, six message-merge modes. Just double-click `index.html`; no server required.

> ⚠️ This tool is intended for **backing up and reading your own chat history**. Please comply with the Telegram Terms of Service and applicable local laws. Do not use it for mass-scraping other people's data.

## ✨ Features

### 📥 Smart media download (powered by tdl)

- QR-code / verification-code login; tdl is **installed automatically** from its official GitHub releases (SHA-256 verified) if missing
- Missing media is computed from **Message IDs + actual file sizes**, so downloads resume incrementally — completed files are never re-downloaded
- No-progress watchdog: when a download stalls at 0 B/s, stalled files are set aside and the queue continues with the rest (an engineering safety net for [tdl#1071](https://github.com/iyear/tdl/issues/1071))
- A dedicated retry queue for stubborn files with adjustable transfer strategies; proxy support and configurable concurrency (1–8) × threads (1–16)
- Live progress: total speed, elapsed time, ETA, active and recently completed transfers

### 🏛️ Inherit official ChatExport

- Already have an older Telegram Desktop HTML export (`messages.html` + `photos/` + `video_files/` + `files/`)? **Inherit it** — existing media is reused by Message ID and only what's missing gets downloaded
- Three import modes: **Manage** (instant same-disk move), **Reference in place** (zero-copy, ideal for tens-of-GB historical exports), **Copy** (safest)

### 📂 Archive library management

- Multi-chat, multi-library: switch / create / recent libraries, one self-contained workspace per chat (stably identified by Chat ID)
- **Merge libraries**, **extract or copy chats** into another library, **migrate whole libraries** — cross-disk transfers use `.tak-part` temp files with background low I/O priority: cancellable, resumable, crash-safe
- Re-importing the same chat merges **incrementally by Message ID**, and every raw import is snapshotted to `source/history/`

### 🌐 Prism Archive offline web

- **Six message-view modes**: Smart Merge (default), Original (Strict), Original (Reconstructed), Same-minute Merge, Same-sender Merge, Media-batch Merge
- **Full-text search** (`/` or `Ctrl+K`, with media previews), **cross-page date navigation**, message-locate highlighting
- **Album lightbox**: full-viewport overlay, zoom & pan, keyboard navigation, image/video filters, open original file
- Lazy-loaded images, video poster frames (FFmpeg auto-installed), explicit "media not yet synced" markers
- Responsive desktop / mobile layout; pure static files that open over `file://` — copy them to a USB drive or NAS and they just work

### 🔒 Data safety

- Completed media is **never deleted**; 0-byte leftovers are cleaned automatically; deleting a chat requires explicit confirmation
- Every operation is logged under `Library/.logs/`; each build produces an `archive-report.json` with statistics and a missing-media report
- The library is self-contained and movable — no absolute-path dependencies

### 🖥️ Friendly UX

- A Windows terminal TUI that requires no command-line knowledge; **drag a `result.json` or a ChatExport folder onto the EXE** to import
- CLI subcommands are also available: `version` / `selftest` / `build` / `verify`

## 🖥 Requirements

| Item | Requirement |
|---|---|
| OS | Windows 10 / 11 (x64) |
| Runtime dependencies | None (tdl and FFmpeg are auto-installed on demand; manual placement also works) |
| Network | Needed for login and download; browsing the archive is fully offline |
| Disk | Depends on your media volume; NTFS recommended |

## 🚀 Quick Start

1. **Export from Telegram Desktop**: open the target chat → top-right menu → **Export chat history** → choose *Machine-readable JSON format*. This produces `result.json`.
2. **Download & run**: grab the ZIP from [Releases](https://github.com/Kkwans/telegram-archive-kit/releases), extract anywhere, and double-click `TelegramArchiveKit.exe`.
3. **Pick a library location**: on first launch, choose where the archive lives (default: `Documents\Telegram Archive Library`, or portable mode). **Never delete this directory when upgrading.**
4. **Log in**: menu "Telegram 账号与会话" (Account & Session) → sign in via QR code or verification code.
5. **Import & sync**: drag `result.json` onto the EXE (or pick it under "添加/更新聊天" / Add & Update Chats), then run **"一键完成"** (One-click Complete) — TAK pre-flights the environment, downloads missing media, generates thumbnails and web pages.
6. **Browse**: the archive home page `index.html` opens automatically when the build finishes.

> 💡 Already have an official ChatExport HTML export? Run "Inherit official ChatExport" first, then import the current `result.json` — old media will be reused. See the [Usage Guide](docs/USAGE.md).
>
> 💡 Upgrading: extract the new version into a **new folder**, point it at the existing library, and run "Chats → Regenerate web pages only". No media is re-downloaded.

## 🔭 How It Works

```text
┌───────────────────────────── Telegram Archive Kit (TUI) ─────────────────────────────┐
│                                                                                      │
│  Telegram Desktop export      tdl (download engine, auto-installed)    Archive Library│
│  ┌────────────────┐          ┌──────────────────────┐          ┌──────────────────┐  │
│  │  result.json   ├─────────▶│  QR / code login     │─────────▶│ chats/chat__ID   │  │
│  │  ChatExport/   │ messages │  multi-threaded DL   │  media   │  ├ source/       │  │
│  └────────────────┘          │  watchdog / resume   │          │  ├ media/ thumbs/│  │
│                              └──────────────────────┘          │  └ data/ indexes │  │
│                                                                        │             │
│  telegram-export-beautifier (theme)     8-step build: scan → thumbs → indexes → HTML│
│  ┌──────────────────────────────────────────────────────────────▼─────────────┐      │
│  │        Prism Archive: index.html + messages*.html (pure static, offline)   │      │
│  │      search · date navigation · lightbox · 6 merge modes · mobile-ready    │      │
│  └─────────────────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- **TAK itself**: a single Go 1.23+ binary with **zero third-party dependencies** and a Windows console TUI.
- **tdl**: invoked as an external subprocess at runtime — never bundled or modified; session data lives in `%USERPROFILE%\.tdl`.
- **Beautifier theme**: TAK bundles an optimized, self-contained edition of the [telegram-export-beautifier](https://github.com/Kkwans/telegram-export-beautifier) theme — shipped with the binary, fully offline, nothing is fetched at runtime.
- **Config file**: `%APPDATA%\TelegramArchiveKit\config.json`.

## 📁 Archive Library Layout

```text
Telegram Archive Library/           ← data directory; do NOT delete when upgrading
├── index.html                      ← archive home page (the single entry point)
├── library.json / library-data.js  ← chat list and statistics
├── assets/                         ← web assets and the beautifier theme
├── .logs/                          ← run logs (start here when troubleshooting)
├── .runtime/                       ← transient files such as download plans
└── chats/
    └── chat_<name>__<ChatID>/      ← one workspace per chat
        ├── workspace.json          ← chat metadata
        ├── source/
        │   ├── result.json         ← merged message source data
        │   └── history/            ← snapshot of every raw import
        ├── media/                  ← downloaded media files
        ├── thumbs/                 ← 720px thumbnail cache
        ├── data/                   ← message data, search index, date index
        ├── messages.html …         ← paginated web pages (strict-messages* = strict mode)
        └── archive-report.json     ← build statistics and missing-media report
```

Full data-safety rules (exact behaviour of merge, extract and delete) are described in [Data & Directory Structure](docs/DATA_FORMAT.md).

## 🛠 Building from Source

```bash
# Requirements: Go 1.23+ and Python 3 (for the build script)
git clone https://github.com/Kkwans/telegram-archive-kit.git
cd telegram-archive-kit

# One-shot build (unit tests → go vet → Win64 cross-compile → PE check)
python scripts/build_windows.py

# Output: TelegramArchiveKit.exe in the repo root (Windows console app)
```

Or build manually:

```bash
cd app/src
go test ./...
go vet ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o ../../TelegramArchiveKit.exe .
```

> Note: do NOT add `-H=windowsgui` — the app needs a real console to read keyboard input.

## 📚 Documentation

| Document | Contents |
|---|---|
| [Usage Guide](docs/USAGE.md) | Install, login, import, ChatExport inheritance, multi-disk management, download settings |
| [Data & Directory Structure](docs/DATA_FORMAT.md) | Library layout, data-safety rules, config file locations |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | 0 B/s downloads, login issues, thumbnails, web page caching, and more |
| [Changelog](CHANGELOG.md) | Release notes for every version |
| [Third-party Components](docs/THIRD_PARTY.md) | Sources and licenses of tdl, beautifier and other dependencies |

> The docs in this repository are currently written in Chinese; English translations are welcome via PR.

## ❓ FAQ

<details>
<summary><b>Download speed is stuck at 0 B/s</b></summary>

This is a known tdl issue on Windows ([iyear/tdl#1071](https://github.com/iyear/tdl/issues/1071)): a healthy login check does not guarantee the media's data center is currently reachable. TAK sets stalled files aside after 60 seconds without real progress, rebuilds the queue and keeps downloading the rest, with a single diagnostic restart of the engine. If it still fails repeatedly, restore the default 2×4 concurrency, configure a proxy explicitly, and inspect tdl's raw logs under `Library/.logs/`.
</details>

<details>
<summary><b>Do I need to re-download media after upgrading?</b></summary>

No. Extract the new version into a fresh folder, point it at your existing library, and run "Regenerate web pages only". The library format stays compatible and all media and message data is reused.
</details>

<details>
<summary><b>Videos in the web pages have no poster image</b></summary>

Video posters require FFmpeg. TAK downloads and installs it automatically when needed (~109 MB, SHA-256 verified). If your network blocks the download, install FFmpeg yourself, make sure `ffmpeg -version` works, then regenerate the pages. Videos without posters remain playable, and the media itself is never lost.
</details>

<details>
<summary><b>Linux / macOS support?</b></summary>

The TUI depends on the Windows console API and is designed for Windows 10/11 x64. A few CLI subcommands (`version`, `selftest`, `verify`) run on other platforms, but full functionality is Windows-only.
</details>

For anything else, see [Troubleshooting](docs/TROUBLESHOOTING.md) or open an [Issue](https://github.com/Kkwans/telegram-archive-kit/issues).

## 🤝 Contributing

Issues and pull requests are welcome!

- When reporting a bug, attach the relevant files from `Library/.logs/` (**redact personal chat content first**);
- Run `python scripts/build_windows.py` before submitting to make sure tests and the build pass;
- Please open an Issue to discuss new features before implementing them.

## 📄 License

This project is licensed under the [MIT License](LICENSE).

Third-party notes:

- [tdl](https://github.com/iyear/tdl) (AGPL-3.0): installed and invoked at runtime as a **separate external program**; this project neither bundles nor copies its code, so there is no license conflict;
- [telegram-export-beautifier](https://github.com/Kkwans/telegram-export-beautifier) (archived, no longer maintained): TAK's built-in theme is an optimized edition of it, bundled with the binary — the upstream repo is not a runtime dependency.

See [Third-party Components](docs/THIRD_PARTY.md) for details.

## 🙏 Acknowledgements

- [iyear/tdl](https://github.com/iyear/tdl) — the powerful Telegram downloader behind this project
- [Kkwans/telegram-export-beautifier](https://github.com/Kkwans/telegram-export-beautifier) — the message-page beautification theme
- [rand0451/Telegram-Chat-Export-Viewer](https://github.com/rand0451/Telegram-Chat-Export-Viewer) and other open-source projects — architecture references

---

<div align="center">

If this project helps you, please consider giving it a ⭐

</div>
