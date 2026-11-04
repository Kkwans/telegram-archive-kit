# TelegramArchiveKit 桌面客户端

Wails v3 + React 19 的桌面壳，和终端版共用 `internal/app` 引擎。构建：

```bash
python scripts/build_windows.py --target all
```

## 结构

- `main.go`：应用、窗口、托盘、单实例、文件拖放
- `bridge.go`：同源 HTTP `POST /api/rpc`，前端不依赖生成的 Wails 绑定
- `conpty_windows.go`：tdl 登录用的伪控制台（交互式输入必须真终端）
- `taskbar_windows.go`：ITaskbarList3 任务栏进度
- `frontend/`：Vite + React；`npm run build` 后由 Go embed

## 坑位备忘

- 生产构建必须带 `-tags production -H windowsgui`；子系统 2 由 `scripts/check_windows_exe.py --subsystem 2` 校验。
- 无边框窗口拖动用 `--wails-draggable`（v3 写法），不要照搬 v2 的 `--wails-drag`。
- 前端没有引入 `@wailsio/runtime`，因此不要依赖 `Events.On`；状态通过 600ms 轮询 `/api/rpc` 的 `state`。
- `-H windowsgui` 下没有 stdout；自测结果写 `--out` 文件，日志走应用日志目录。
- 窗口 ready 之前发出的事件会丢；需要送达的信息（拖放、第二实例参数）放在 `state.pending` 里轮询。
- tdl 的登录提示依赖终端 UI 库，普通管道会报 `Incorrect function`；必须走 ConPTY。
- 关闭窗口默认隐藏到托盘；托盘菜单「退出」才真正结束进程并释放档案库互斥体。
- 桌面端持有 `Local\TAK.Library.<hash>` 命名互斥体，终端版写入前会检查；排障可用 `TAK_ALLOW_CONCURRENT=1` 跳过检查。
