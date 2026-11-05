# 存储与检索：JSON + SQLite 混合方案调研

> 版本：2026-11-05。结论用于 2.0/3.0 规划，2.0 未引入 SQLite。

## 现状

- `result.json` / 合并后的 `source/result.json` 是**唯一事实来源**。
- 构建时生成 `data/archive-data.js`（消息、媒体、统计）、`search-index.js`、`date-index.js`，供离线网页使用；这些是派生文件。
- 桌面端媒体网格直接从 `archive-data.js` 解析（带缩略图与官方导出路径），任务历史本轮改为 `config/tasks.json`。
- 终端版保持 **Go 1.23、零第三方依赖**；不能把 SQLite 强塞进 TUI 模块。

实测（本机现有 5 个聊天、7,603 条消息）：

| 操作 | 耗时 |
|---|---|
| 解析全部 `archive-data.js` | ≈ 74 ms（一次性） |
| 7,603 条消息内存扫描 20 次 | ≈ 4 ms（≈0.2 ms/次） |
| SQLite FTS5 建索引（含插入） | ≈ 24 ms |
| FTS5 单次检索 | 亚毫秒级 |

结论：**当前数据量下 JSON 已经足够快**，SQLite 的收益主要在检索体验与更大数据量，而不是替换 JSON。

## 三种方案

| 方案 | 优点 | 缺点 | 判断 |
|---|---|---|---|
| A. 继续全 JSON | 零依赖、离线网页直接可用、实现简单 | 无跨聊天桌面搜索；每次媒体列表要解析整份 JSON；统计要遍历文件 | 2.0 保持 |
| B. 全面迁移 SQLite | 查询强、事务好 | 破坏离线网页与 TUI 零依赖；迁移风险大；静态网页仍需 JS 数据 | 不采用 |
| C. JSON 为源 + 桌面 SQLite 派生缓存 | 搜索/统计快；JSON 仍可独立使用；坏了可重建 | 多一套索引与一致性逻辑；桌面二进制增大 | **3.0 采用** |

## 3.0 建议架构（派生缓存）

SQLite 文件放在档案库 `.runtime/index.sqlite`，**只由桌面端维护，可随时删除重建**，不替代 `source/result.json`：

```sql
chats(slug TEXT PRIMARY KEY, name TEXT, messages INT, media INT, missing INT, pages INT, updated INT)
media(slug TEXT, rel TEXT, name TEXT, kind TEXT, size INT, msg_id TEXT, PRIMARY KEY(slug, rel))
messages_fts(slug, msg_id, ts INT, sender TEXT, text TEXT)   -- FTS5
tasks(id TEXT PRIMARY KEY, kind TEXT, title TEXT, chat TEXT, state TEXT,
      percent INT, started INT, finished INT, error TEXT)
```

- 驱动：`modernc.org/sqlite`（纯 Go，桌面模块专用；TUI 不引入）。
- 写入：导入/构建/删除后**增量**更新（按 source 文件 mtime + size + 最大消息 ID 判定）；事务 + WAL。
- 一致性：启动校验 schema 版本；损坏或版本不符直接删除重建，不影响源数据。
- 搜索：全局消息搜索页（Ctrl+K 扩展），支持聊天/发送者/时间过滤，点击跳转到对应聊天与媒体。
- 任务：把当前 `tasks.json` 迁到同一 SQLite，保留 500 条历史与筛选。
- 统计：首页直接查聚合表，避免每次解析全部 JSON。

## 何时值得做

- 聊天数量多（>10 个）、消息量 >5 万、需要**跨聊天搜索**或媒体筛选；
- 桌面端要做“搜索全部媒体/消息”“最近活动”“任务历史”等查询型功能。

## 工作量与风险

- 预估 4–7 人日：驱动接入（1）、schema/迁移/重建（1）、增量索引（2）、搜索页与跳转（2）、任务迁移（1）。
- 风险：索引与源数据不一致 → 用“删除重建”兜底；SQLite 与静态网页重复索引 → 明确只服务桌面查询；二进制体积增加（modernc 较大） → 桌面端可接受。

## 2.0 决定

2.0 不引入 SQLite：当前数据规模下 JSON 解析与扫描已足够快，优先把 UI/任务/账号体验做好；任务历史先用 `tasks.json` 持久化。SQLite 搜索与任务库作为 3.0 的候选核心功能，与在线聊天/一键导出一起评估。
