<div align="center">

# Telegram Archive Kit

**Turn your Telegram chats into a fully offline, searchable, long-lived local web archive.**

Windows desktop client + console edition. Powered by [tdl](https://github.com/iyear/tdl) as the download engine and compatible with Telegram Desktop exports,
it connects media download → incremental archiving → static web generation → everyday browsing. All chats and media stay on your own disk.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-3.0-2f6bff.svg)](CHANGELOG.md)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D6.svg)](#-requirements)
[![Go](https://img.shields.io/badge/Go-1.26%2B-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![Release](https://img.shields.io/github/v/release/Kkwans/telegram-archive-kit?color=green)](https://github.com/Kkwans/telegram-archive-kit/releases)

[简体中文](README.md) · English · [Latest release](https://github.com/Kkwans/telegram-archive-kit/releases/latest) · [Changelog](CHANGELOG.md)

</div>

---

## Contents

- [What is this?](#what-is-this)
- [3.0 highlights](#-30-highlights)
- [Features](#-features)
- [Requirements](#-requirements)
- [Download & install](#-download--install)
- [First run](#-first-run)
- [Online chat & incremental archiving](#-online-chat--incremental-archiving)
- [Download preview](#-download-preview)
- [How it works](#-how-it-works)
- [Archive library layout](#-archive-library-layout)
- [Building from source](#-building-from-source)
- [Documentation](#-documentation)
- [Data, privacy & security](#-data-privacy--security)
- [FAQ](#-faq)
- [Contributing](#-contributing)
- [License](#-license)
- [Acknowledgements](#-acknowledgements)

## What is this?

**Telegram Archive Kit (TAK)** is a Windows desktop archiving client (with a console edition for troubleshooting and server scenarios). It solves a specific problem:

- Telegram Desktop's built-in export gives you a `result.json` and a folder of HTML pages, but it **can't batch-download missing media, can't update incrementally, and gets painfully slow with chats tens of gigabytes large**;
- [tdl](https://github.com/iyear/tdl) is a powerful downloader, but it **only downloads — it doesn't organize or present anything**.

TAK bridges the two: you supply the `result.json` exported from Telegram Desktop, and TAK takes care of login, downloading missing media, maintaining a portable **Archive Library**, and generating an offline static website (**Prism Archive**) built on the beautification scheme of [telegram-export-beautifier](https://github.com/Kkwans/telegram-export-beautifier) — multi-chat dashboard, full-text search, cross-page date navigation, media lightbox, six message-merge modes. Just double-click `index.html`; no server required.

> ⚠️ This tool is intended for **backing up and reading your own chat history**. Please comply with the Telegram Terms of Service and applicable local laws. Do not use it for mass-scraping other people's data.

## ✨ 3.0 highlights

- **Online chat**: reuses the local tdl session and reads the full conversation list (type, unread, pinned, last message, real avatars) through gotd, with filters and search.
- **Incremental online archiving**: fetches only messages newer than the local maximum Message ID; the preview also checks **media actually missing from the archive**, so a stopped download is never mistaken for "up to date" just because `result.json` is current.
- **Preview before every download**: online update, result.json backfill, sync selected chat, continue download and sync-all-missing all share one statistics dialog with media counts, types, estimated size and free disk space. Insufficient space blocks task creation.
- **Remote libraries**: SMB / UNC locations, an rclone mount wizard and SSHFS-Win guidance, with an offline banner and local thumbnail cache.
- **Viewer improvements**: single-click image zoom / double-click reset, wheel zoom anchored at the cursor, drag to pan; video supports HTML fullscreen and window-level immersive fullscreen, speed control, picture-in-picture and auto-next.

## ✨ Features

### 🖥️ Desktop client

- Double-click `TelegramArchiveKit.exe`: light/dark themes, borderless title bar with Win11 Mica, tray residency
- Home dashboard: media composition, storage usage, top chats, recent chats and tasks
- Task center: imports, official ChatExport inheritance, exports, rebuilds, library merges, online archiving and media backfill all leave a record
- Download board: progress ring, real-time / average / peak speed, speed curve, ETA and per-file table
- In-app QR / phone / 2FA login, Ctrl+K command palette, drag-and-drop import and taskbar progress
- Online chat page: conversation list, filters, real avatars and incremental archiving
- Remote libraries: SMB / UNC, rclone mounts and SSHFS guidance

### 📥 Smart media download (powered by tdl)

- QR-code / verification-code login; tdl is **installed automatically** from its official GitHub releases (SHA-256 verified) if missing
- Missing media is computed from **Message IDs + actual file sizes**, so downloads resume incrementally — completed files are never re-downloaded
- No-progress watchdog: when a download stalls at 0 B/s, stalled files are set aside and the queue continues with the rest (an engineering safety net for [tdl#1071](https://github.com/iyear/tdl/issues/1071))
- A dedicated retry queue for stubborn files with adjustable transfer strategies; proxy support and configurable concurrency (1–8) × threads (1–16)
- Live progress: total speed, elapsed time, ETA, active and recently completed transfers
- **Preview before download**: every download entry shows missing media counts, types and estimated size, and checks free disk space before creating a task

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
- Nothing is uploaded: chats, media and indexes stay in your local or remote library
- The desktop and console editions refuse to write to the same library at the same time (named mutex + session file); set `TAK_ALLOW_CONCURRENT=1` only for troubleshooting

### 🖥️ Friendly UX

- Desktop client with a visual interface, or a Windows terminal TUI for troubleshooting; **drag a `result.json` or a ChatExport folder onto the EXE** to import
- CLI subcommands are also available: `version` / `selftest` / `build` / `verify`

## 🖥 Requirements

| Item | Requirement |
|---|---|
| OS | Windows 10 / 11 (x64) |
| Runtime dependencies | None (tdl and FFmpeg are auto-installed on demand; manual placement also works) |
| WebView2 | The desktop client uses the system WebView2 runtime (bundled with Win11; install the Microsoft Edge WebView2 Runtime on Win10 if missing) |
| Network | Needed for login, online archiving and download; browsing the archive is fully offline |
| Disk | Depends on your media volume; NTFS recommended |

## ⬇️ Download & install

1. Open [Releases](https://github.com/Kkwans/telegram-archive-kit/releases/latest) and download `TelegramArchiveKit_v3.0_windows-x64.zip`.
2. Extract it to any folder (do not run it from inside the ZIP).
3. Double-click `TelegramArchiveKit.exe` for the desktop client, or run `TelegramArchiveKit-Console.exe` for the console edition. Both share the same library.
4. On first launch, choose the archive library location. **Never delete this directory when upgrading.**

## 🚀 First run

1. **Export from Telegram Desktop**: open the target chat → top-right menu → **Export chat history** → choose *Machine-readable JSON format*. This produces `result.json`.
2. **Pick a library location**: choose where the archive lives on first launch; later upgrades only need to point at the same directory.
3. **Log in**: open "Account & Session" and scan the QR code, or use a phone code / 2FA.
4. **Import**: drag `result.json` or a ChatExport folder into the window, or import it from the Chats page.
5. **Sync**: click "Sync selected" or "Sync all missing", review the download statistics, then start.
6. **Browse**: after the build finishes, open the archive home page `index.html`.

> 💡 Already have an official ChatExport HTML export? Run "Inherit official ChatExport" first, then merge the current `result.json` — existing media is reused.
>
> 💡 Upgrading: extract the new version into a **new folder**, point it at the existing library, and run "Rebuild web pages". No media is re-downloaded.

## 🌐 Online chat & incremental archiving

3.0 adds an "Online chat" page that reuses the local tdl session (no extra password storage):

- Full conversation list with type, unread, pinned, last message and real avatars
- Filters for private chats / groups / channels / archived chats, plus search and sorting
- "Online update" on an archived chat fetches only messages newer than the local maximum Message ID
- The preview shows new messages, media composition and estimated size
- **It also checks media actually missing from the archive**: if a previous download was stopped, the dialog reports "messages are up to date, but N local media files are missing" and offers to finish them
- Free disk space is checked before starting; insufficient space disables the action instead of creating a doomed task

## 📊 Download preview

Since 3.0 every download entry opens the same statistics dialog before writing anything:

| Entry | What is shown | When disk space is insufficient |
|---|---|---|
| Online update | New messages + local missing media, media types, estimated size | "Start archiving" is disabled |
| result.json backfill | Local missing media, types, estimated size | "Start backfill" is disabled |
| Sync selected / one-click sync | Missing media of the current chat, types, size | "Start sync" is disabled |
| Sync all missing | Combined media count and size across affected chats | "Start sync" is disabled |
| Task center "Continue download" | Remaining missing media, types, size | "Start sync" is disabled |

The estimate uses the same known-file-size basis as the downloader (`file_size` in `result.json`) plus a 256 MB reserve. Media with unknown sizes is not included, so actual usage can be slightly higher.

## 🔭 How It Works

```text
┌──────────────────────── Telegram Archive Kit (Desktop / Console) ────────────────────────┐
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

- **TAK itself**: a single Go binary. The console edition keeps Go 1.23+ and **zero third-party dependencies**; the desktop client is a separate Wails v3 + React 19 module sharing the same archive engine.
- **tdl**: invoked as an external subprocess at runtime — never bundled or modified; session data lives in `%USERPROFILE%\.tdl`.
- **Beautifier theme**: TAK bundles the complete [telegram-export-beautifier](https://github.com/Kkwans/telegram-export-beautifier) theme (upstream commit `608ac73`) — shipped with the binary, fully offline, nothing is fetched at runtime.
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

Requirements: Go **1.26.4+** (desktop module; console edition needs Go 1.23+), Node.js 20+ / npm, Python 3.

```bash
git clone https://github.com/Kkwans/telegram-archive-kit.git
cd telegram-archive-kit

# Build both clients: console tests/vet → frontend npm ci + build → two Win64 targets → PE subsystem check
python scripts/build_windows.py --target all

# Outputs:
#   TelegramArchiveKit.exe          desktop client (Windows GUI, subsystem 2)
#   TelegramArchiveKit-Console.exe  console edition (subsystem 3)
```

Or build separately:

```bash
# Console edition: still zero-dependency and offline-capable
cd app/src
go test ./...
go vet ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o ../../TelegramArchiveKit-Console.exe .

# Desktop client: frontend + Wails
cd desktop/frontend && npm ci && npm run build && cd ..
go build -trimpath -tags production -ldflags="-s -w -H windowsgui" -o ../../TelegramArchiveKit.exe .

# Package a zip for local acceptance
python scripts/build_windows.py --target all --zip
```

> The console edition needs a real console for keyboard input — do NOT add `-H=windowsgui` to `-Console.exe`. The desktop client must use `-H windowsgui` with `-tags production`.

## 📚 Documentation

| Document | Contents |
|---|---|
| [Documentation index](docs/README.md) | Navigation for all documents (Chinese) |
| [Usage Guide](docs/USAGE.md) | Install, login, import, ChatExport inheritance, multi-disk management, download settings |
| [Online capabilities & incremental archiving](docs/ONLINE_TDL_3.0.md) | tdl integration, gotd online sessions, merge strategy |
| [Remote libraries](docs/REMOTE_LIBRARY_3.0.md) | SMB / UNC, rclone mounts, SSHFS, cache and offline behaviour |
| [Data & Directory Structure](docs/DATA_FORMAT.md) | Library layout, data-safety rules, config file locations |
| [Storage & SQLite](docs/STORAGE_SQLITE.md) | Index and storage design |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | 0 B/s downloads, login issues, thumbnails, web page caching, and more |
| [Changelog](CHANGELOG.md) | Release notes for every version |
| [Third-party Components](docs/THIRD_PARTY.md) | Sources and licenses of tdl, beautifier and other dependencies |

> The detailed docs in this repository are currently written in Chinese; English translations are welcome via PR.

## ❓ FAQ

<details>
<summary><b>Download speed is stuck at 0 B/s</b></summary>

This is a known tdl issue on Windows ([iyear/tdl#1071](https://github.com/iyear/tdl/issues/1071)): a healthy login check does not guarantee the media's data center is currently reachable. TAK sets stalled files aside after 60 seconds without real progress, rebuilds the queue and keeps downloading the rest, with a single diagnostic restart of the engine. If it still fails repeatedly, restore the default 2×4 concurrency, configure a proxy explicitly, and inspect tdl's raw logs under `Library/.logs/`.
</details>

<details>
<summary><b>Online update says "up to date" but local media is incomplete</b></summary>

Since 3.0 the preview no longer trusts `result.json` alone: it also checks media actually missing from the archive. If a previous download was stopped, the dialog reports "messages are up to date, but N local media files are missing" and offers to finish them; you can also use "Backfill from result.json" on the chat page.
</details>

<details>
<summary><b>Why does every download now open a statistics dialog first?</b></summary>

To avoid creating a task that immediately fails because the disk is full, and to avoid assuming an archive is complete when files are missing, every download entry previews missing media and required space first. The task is created only after confirmation; when space is insufficient the action is disabled.
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

Both the desktop client and the TUI depend on Windows APIs and target Windows 10/11 x64. A few CLI subcommands (`version`, `selftest`, `verify`) run on other platforms, but full functionality is Windows-only.
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
- [telegram-export-beautifier](https://github.com/Kkwans/telegram-export-beautifier) (archived, no longer maintained): TAK bundles the complete theme (upstream commit `608ac73`) with the binary — the upstream repo is not a runtime dependency.

See [Third-party Components](docs/THIRD_PARTY.md) for details.

## 🙏 Acknowledgements

- [iyear/tdl](https://github.com/iyear/tdl) — the powerful Telegram downloader behind this project
- [Kkwans/telegram-export-beautifier](https://github.com/Kkwans/telegram-export-beautifier) — the message-page beautification theme
- [rand0451/Telegram-Chat-Export-Viewer](https://github.com/rand0451/Telegram-Chat-Export-Viewer) and other open-source projects — architecture references

---

<div align="center">

If this project helps you, please consider giving it a ⭐

</div>
