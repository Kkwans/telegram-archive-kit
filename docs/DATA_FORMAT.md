# 数据与目录结构

本文档说明 Telegram Archive Kit（TAK）档案库的目录布局、各文件的作用，以及程序在数据安全上的行为边界。

## 档案库总览

```text
Telegram Archive Library/            ← 数据目录，可整体备份/迁移
├── index.html                       ← 档案库首页（唯一入口）
├── library.json                     ← 聊天清单（机器可读）
├── library-data.js                  ← 首页数据（index.html 加载）
├── assets/                          ← 网页样式、脚本
│   ├── app.css / app.js             ← 首页样式与逻辑
│   ├── tak-bridge.css/.js           ← 聊天页搜索/日期/定位桥接层
│   ├── tak-lightbox.css/.js         ← 灯箱
│   ├── tak-prelude.js               ← 六种消息合并模式
│   ├── favicon.ico                  ← 图标
│   └── beautifier/                  ← 内置优化版美化主题（style.css / script.js 与来源记录）
├── .logs/                           ← 运行日志
│   ├── tak-YYYYMMDD.log             ← TAK 日志
│   ├── tdl-*.log                    ← tdl 原始日志
│   └── last-recovery-diagnostic.txt ← 最近一次故障恢复的诊断信息
├── .runtime/                        ← 临时文件（missing.json 下载计划等），可安全删除
└── chats/                           ← 所有聊天的工作区
    └── chat_<聊天名称>__<ChatID>/    ← 每个聊天一个目录（Chat ID 用于稳定识别）
```

## 聊天工作区

```text
chat_<聊天名称>__<ChatID>/
├── workspace.json                   ← 聊天元数据（Chat ID、导入记录等）
├── source/
│   ├── result.json                  ← 合并后的消息源数据（工作副本）
│   └── history/                     ← 每次导入的原始 JSON 快照 + 合并前快照
├── media/                           ← 下载的媒体文件（msg_<id>__ 命名）
├── thumbs/                          ← 约 720px 的缩略图缓存（按内容哈希命名）
├── data/
│   ├── archive-data.js              ← 消息数据（网页加载）
│   ├── search-index.js              ← 全文搜索索引
│   └── date-index.js                ← 跨页日期索引
├── messages.html, messages2.html …  ← 默认视图分页（每页 1000 条）
├── strict-messages*.html            ← 原版（严格）模式的分页
├── archive-report.json              ← 构建统计与缺失媒体报告
├── official-media-index.json        ← 官方 ChatExport 继承索引
└── official_exports/                ← 纳管的旧版 ChatExport 副本
```

## 数据安全规则

TAK 在设计上有明确的数据安全边界：

- **已完成媒体永不删除**：判断依据是"实际存在的完整文件"，不信任下载器的中断状态；0 字节残留文件会自动清除后重新下载；
- **导入即快照**：每次导入的原始 `result.json` 都进入 `source/history/`，合并行为可回溯；
- **合并档案库时源库只读**：库合并、聊天抽取/复制都不会删除源数据；
- **删除聊天需二次确认**：必须进入危险确认页显式确认；
- **跨盘传输崩溃安全**：使用 `.tak-part` 临时文件，复制完整后才改为最终文件名；同名同大小的文件自动跳过，可反复续传；
- **tdl 卡死不自动强杀既有进程**：仅对本次启动的下载进程做看门狗管理，用户明确选择时才结束其他进程；
- **明确报告**：每次构建产出 `archive-report.json`，缺失媒体、缺失封面等都有精确清单，不会静默丢数据。

## 程序配置文件

| 路径 | 内容 |
|---|---|
| `%APPDATA%\TelegramArchiveKit\config.json` | 程序配置（当前档案库位置、下载设置、最近使用的库等） |
| `%USERPROFILE%\.tdl\` | tdl 的 Telegram 会话数据 |
| `%LOCALAPPDATA%\Programs\TelegramArchiveKit\` | 自动安装的 tdl / FFmpeg |

## 备份与迁移建议

- **整库备份**：档案库是自包含的，直接复制整个目录即可（`media/` 占绝大部分体积，`thumbs/` 可以不备份——重建网页时会重新生成）；
- **跨盘迁移**：优先使用程序内「档案库与存储 → 迁移」而非手动复制，可获得进度显示、断点续传与低 I/O 优先级；
- **快照回溯**：怀疑数据异常时，对比 `source/history/` 中的历史快照与当前 `source/result.json`。
