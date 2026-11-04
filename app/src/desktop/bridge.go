package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"

	takapp "telegramarchivekit/internal/app"
)

// Bridge exposes the engine over the asset server at /api/rpc. It is a normal
// same-origin HTTP endpoint inside the WebView2 window: no port, no CORS, no
// generated bindings and no WebView message channel to keep alive.
type Bridge struct {
	facade *takapp.Facade
	window *application.WebviewWindow

	mu      sync.Mutex
	pending *PendingInput
	notice  *Notice
	seq     int64
}

// Notice is a one-shot message (for example a failed tray action) that the
// frontend polls and acknowledges.
type Notice struct {
	Seq  int64  `json:"seq"`
	Text string `json:"text,omitempty"`
}

// PendingInput carries files or folders that arrived through the second
// instance, a shell drop or the command line. The frontend acknowledges it.
type PendingInput struct {
	Seq     int64    `json:"seq"`
	Paths   []string `json:"paths,omitempty"`
	Folders []string `json:"folders,omitempty"`
	Source  string   `json:"source,omitempty"`
}

// stateReply flattens DesktopState and adds the pending drop.
type stateReply struct {
	takapp.DesktopState
	Pending *PendingInput `json:"pending,omitempty"`
	Notice  *Notice       `json:"notice,omitempty"`
}

func NewBridge(f *takapp.Facade) *Bridge { return &Bridge{facade: f} }

func (b *Bridge) Attach(w *application.WebviewWindow) { b.window = w }

func (b *Bridge) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			b.serve(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type apiRequest struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type apiReply struct {
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

func (b *Bridge) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(apiReply{Error: "仅支持 POST"})
		return
	}
	var req apiRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
		_ = json.NewEncoder(w).Encode(apiReply{Error: "请求格式错误"})
		return
	}
	result, err := b.dispatch(req.Method, req.Params)
	if err != nil {
		_ = json.NewEncoder(w).Encode(apiReply{Error: err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(apiReply{OK: true, Result: result})
}

type apiParams struct {
	Slug     string              `json:"slug"`
	Folder   string              `json:"folder"`
	Mode     string              `json:"mode"`
	Root     string              `json:"root"`
	Dst      string              `json:"dst"`
	Path     string              `json:"path"`
	Name     string              `json:"name"`
	Title    string              `json:"title"`
	Initial  string              `json:"initial"`
	Paths    []string            `json:"paths"`
	Settings *takapp.SettingsDTO `json:"settings"`
	Kind     string              `json:"kind"`
	ID       string              `json:"id"`
	Text     string              `json:"text"`
	Timeout  int                 `json:"timeout"`
	Seq      int64               `json:"seq"`
}

func (b *Bridge) dispatch(method string, raw json.RawMessage) (any, error) {
	var p apiParams
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &p)
	}
	switch method {
	case "ping":
		return b.facade.Ping(), nil
	case "bootstrap":
		return b.facade.Bootstrap(), nil
	case "listChats":
		return b.facade.ListChats(), nil
	case "state":
		return b.stateReply(), nil
	case "ackPending":
		b.ackPending(p.Seq)
		return nil, nil
	case "ackNotice":
		b.ackNotice(p.Seq)
		return nil, nil
	case "startOneClick":
		id, err := b.facade.StartOneClick(p.Slug)
		if err != nil {
			return nil, err
		}
		return map[string]string{"opId": id}, nil
	case "cancel":
		return map[string]bool{"cancelled": b.facade.Cancel()}, nil
	case "openLibrary":
		return nil, b.facade.OpenLibrary(p.Slug)
	case "revealChat":
		return nil, b.facade.RevealChat(p.Slug)
	case "revealLogs":
		return nil, b.facade.RevealLogs()
	case "openPath":
		return nil, b.facade.OpenFolderPath(p.Path)

	case "pickJSON":
		return b.pickJSON()
	case "pickFolder":
		return b.pickFolder(p.Title, p.Initial)

	case "importJSON":
		return b.facade.ImportJSONFiles(p.Paths)
	case "analyzeOfficial":
		return b.facade.AnalyzeOfficial(p.Folder)
	case "importOfficial":
		return b.facade.ImportOfficial(p.Folder, p.Slug, p.Mode)
	case "deleteChat":
		return nil, b.facade.DeleteChat(p.Slug)
	case "verifyChat":
		return b.facade.VerifyChat(p.Slug)
	case "refreshWeb":
		return nil, b.facade.RefreshWeb(p.Slug)
	case "refreshAllWeb":
		ok, skipped, err := b.facade.RefreshAllWeb()
		if err != nil {
			return nil, err
		}
		return map[string]int{"rebuilt": ok, "skipped": skipped}, nil
	case "exportChat":
		return nil, b.facade.ExportChat(p.Slug, p.Dst)
	case "switchLibrary":
		return nil, b.facade.SwitchLibrary(p.Root)
	case "mergeLibrary":
		ok, total, err := b.facade.MergeLibrary(p.Root)
		if err != nil {
			return nil, err
		}
		return map[string]int{"merged": ok, "total": total}, nil
	case "getSettings":
		return b.facade.GetSettings(), nil
	case "setSettings":
		if p.Settings == nil {
			return nil, errors.New("缺少设置内容")
		}
		return b.facade.SetSettings(*p.Settings)
	case "diagnostics":
		return b.facade.Diagnostics(), nil
	case "listLogs":
		return b.facade.ListLogs(), nil
	case "readLog":
		return b.facade.ReadLog(p.Name)

	case "tdlInfo":
		return b.facade.TdlInfo(), nil
	case "sessionCheck":
		return b.facade.SessionCheck(p.Timeout), nil
	case "installTdl":
		return b.facade.InstallTdl()
	case "killTdl":
		killed, err := b.facade.KillTdl()
		if err != nil {
			return nil, err
		}
		return map[string]bool{"killed": killed}, nil
	case "openTdlDir":
		return nil, b.facade.OpenTdlDir()
	case "startLogin":
		return b.facade.StartLogin(p.Kind)
	case "loginInput":
		return nil, b.facade.LoginInput(p.ID, p.Text)
	case "loginCancel":
		return map[string]bool{"cancelled": b.facade.LoginCancel(p.ID)}, nil

	case "windowMinimize":
		if b.window != nil {
			b.window.Minimise()
		}
		return nil, nil
	case "windowToggleMaximize":
		if b.window != nil {
			b.window.ToggleMaximise()
		}
		return nil, nil
	case "windowClose":
		b.closeWindow()
		return nil, nil
	case "quitApp":
		b.quit()
		return nil, nil
	case "syncCurrent":
		return b.syncCurrent()
	default:
		return nil, errors.New("未知请求: " + method)
	}
}

func (b *Bridge) stateReply() stateReply {
	st := b.facade.State()
	out := stateReply{DesktopState: st}
	b.mu.Lock()
	out.Pending = b.pending
	out.Notice = b.notice
	b.mu.Unlock()
	b.updateTaskbar(st)
	return out
}

func (b *Bridge) QueueArgs(args []string) {
	b.queue(args, "启动参数")
}

func (b *Bridge) QueuePaths(paths []string) {
	b.queue(paths, "拖放")
}

func (b *Bridge) queue(raw []string, source string) {
	var files, dirs []string
	for _, p := range raw {
		p = strings.TrimSpace(strings.Trim(p, `"`))
		if p == "" || strings.HasPrefix(p, "--") {
			continue
		}
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		if st.IsDir() {
			dirs = append(dirs, p)
		} else if strings.EqualFold(filepath.Ext(p), ".json") {
			files = append(files, p)
		}
	}
	if len(files) == 0 && len(dirs) == 0 {
		return
	}
	b.mu.Lock()
	b.seq++
	b.pending = &PendingInput{Seq: b.seq, Paths: files, Folders: dirs, Source: source}
	b.mu.Unlock()
}

func (b *Bridge) QueueNotice(text string) {
	b.mu.Lock()
	b.seq++
	b.notice = &Notice{Seq: b.seq, Text: text}
	b.mu.Unlock()
}

func (b *Bridge) ackNotice(seq int64) {
	b.mu.Lock()
	if b.notice != nil && b.notice.Seq == seq {
		b.notice = nil
	}
	b.mu.Unlock()
}

func (b *Bridge) ackPending(seq int64) {
	b.mu.Lock()
	if b.pending != nil && b.pending.Seq == seq {
		b.pending = nil
	}
	b.mu.Unlock()
}

func (b *Bridge) showWindow() {
	if b.window == nil {
		return
	}
	b.window.Show()
	b.window.Focus()
}

func (b *Bridge) closeWindow() {
	if b.window == nil {
		return
	}
	running := b.facade.Running()
	login := b.facade.LoginActive()
	if !running && !login {
		b.window.Hide()
		return
	}
	what := "下载任务"
	if login && !running {
		what = "登录会话"
	}
	dlg := application.Get().Dialog.Question().
		SetTitle("Telegram Archive Kit").
		SetMessage("仍有" + what + "在进行。关闭窗口后任务会继续，可从托盘图标恢复。").
		AttachToWindow(b.window)
	hide := dlg.AddButton("隐藏到托盘")
	hide.SetAsDefault().OnClick(func() { b.window.Hide() })
	quit := dlg.AddButton("停止并退出")
	quit.OnClick(func() { b.quit() })
	dlg.SetCancelButton(hide)
	dlg.Show()
}

func (b *Bridge) quit() {
	b.facade.Shutdown()
	if b.window != nil {
		b.window.Hide()
	}
	application.Get().Quit()
}

func (b *Bridge) syncCurrent() (map[string]string, error) {
	slug, err := b.facade.SyncCurrentChat()
	if err != nil {
		b.QueueNotice("同步失败：" + err.Error())
		return nil, err
	}
	b.showWindow()
	return map[string]string{"slug": slug}, nil
}

func (b *Bridge) pickJSON() ([]string, error) {
	d := application.Get().Dialog.OpenFile().
		SetTitle("选择 Telegram Desktop 导出的 result.json（可多选）").
		AddFilter("JSON 文件", "*.json").
		CanChooseFiles(true).
		CanChooseDirectories(false)
	if b.window != nil {
		d.AttachToWindow(b.window)
	}
	paths, err := d.PromptForMultipleSelection()
	if err != nil {
		return nil, err
	}
	return paths, nil
}

func (b *Bridge) pickFolder(title, initial string) (string, error) {
	if strings.TrimSpace(title) == "" {
		title = "选择目录"
	}
	d := application.Get().Dialog.OpenFile().
		SetTitle(title).
		CanChooseFiles(false).
		CanChooseDirectories(true)
	if strings.TrimSpace(initial) != "" {
		d.SetDirectory(initial)
	}
	if b.window != nil {
		d.AttachToWindow(b.window)
	}
	path, err := d.PromptForSingleSelection()
	if err != nil {
		return "", err
	}
	return path, nil
}
