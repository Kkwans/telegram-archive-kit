package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
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
	dialog  *PickedDialog
	seq     int64
}

// PickedDialog is the asynchronous result of a native file/folder picker.
type PickedDialog struct {
	Seq     int64    `json:"seq"`
	Kind    string   `json:"kind"`
	Purpose string   `json:"purpose"`
	Paths   []string `json:"paths,omitempty"`
	Folder  string   `json:"folder,omitempty"`
	Error   string   `json:"error,omitempty"`
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
	Dialog  *PickedDialog `json:"dialog,omitempty"`
}

func NewBridge(f *takapp.Facade) *Bridge { return &Bridge{facade: f} }

func (b *Bridge) Attach(w *application.WebviewWindow) { b.window = w }

func (b *Bridge) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/media" {
			b.serveMedia(w, r)
			return
		}
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
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("rpc panic on %s: %v\n%s", r.URL.Path, rec, debug.Stack())
			_ = json.NewEncoder(w).Encode(apiReply{Error: "内部错误，详见桌面日志"})
		}
	}()
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
	Purpose  string              `json:"purpose"`
}

func (b *Bridge) dispatch(method string, raw json.RawMessage) (any, error) {
	var p apiParams
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &p)
	}
	switch method {
	case "ping":
		return b.facade.Ping(), nil
	case "clientLog":
		log.Printf("client: %s", p.Text)
		return nil, nil
	case "bootstrap":
		return b.facade.Bootstrap(), nil
	case "listChats":
		return b.facade.ListChats(), nil
	case "chatMedia":
		return b.facade.ChatMedia(p.Slug)
	case "revealMedia":
		return nil, b.facade.RevealMedia(p.Slug, p.Path)
	case "openMedia":
		return nil, b.facade.OpenMedia(p.Slug, p.Path)
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
		b.startPicker("json", "选择 Telegram Desktop 导出的 result.json（可多选）", p.Purpose)
		return map[string]bool{"started": true}, nil
	case "pickFolder":
		b.startPicker("folder", p.Title, p.Purpose)
		return map[string]bool{"started": true}, nil
	case "ackDialog":
		b.ackDialog(p.Seq)
		return nil, nil

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
	out.Dialog = b.dialog
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

func (b *Bridge) startPicker(kind, title, purpose string) {
	if purpose == "" {
		purpose = kind
	}
	go func() {
		var paths []string
		var err error
		if kind == "json" {
			paths, err = showFileDialog(b.owner(), fileDialogOptions{
				Title:      title,
				FilterName: "JSON 文件",
				FilterSpec: "*.json",
				Multiple:   true,
			})
		} else {
			paths, err = showFileDialog(b.owner(), fileDialogOptions{Title: title, Folder: true})
		}
		if err != nil {
			log.Printf("picker %s failed: %v", kind, err)
		}
		result := &PickedDialog{Kind: kind, Purpose: purpose, Paths: paths}
		if len(paths) > 0 && kind == "folder" {
			result.Folder = paths[0]
		}
		if err != nil {
			result.Error = err.Error()
			log.Printf("picker %s failed: %v", kind, err)
		}
		b.mu.Lock()
		b.seq++
		result.Seq = b.seq
		b.dialog = result
		b.mu.Unlock()
	}()
}

func (b *Bridge) ackDialog(seq int64) {
	b.mu.Lock()
	if b.dialog != nil && b.dialog.Seq == seq {
		b.dialog = nil
	}
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

// owner stays 0: IFileOpenDialog deadlocks when given the WebView2 child
// window; an unowned dialog still comes to the foreground when shown.
func (b *Bridge) owner() uintptr {
	return 0
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
	hide := askHideOrQuit(b.owner(), "仍有"+what+"在进行。选择「是」隐藏到托盘并继续；选择「否」停止任务并退出。")
	if hide {
		b.window.Hide()
		return
	}
	b.quit()
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

func (b *Bridge) serveMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	slug := r.URL.Query().Get("slug")
	name := r.URL.Query().Get("f")
	path, err := b.facade.MediaFilePath(slug, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, r, name, st.ModTime(), f)
}
