package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	takapp "telegramarchivekit/internal/app"
)

// Bridge exposes the engine over the asset server at /api/rpc. It is a normal
// same-origin HTTP endpoint inside the WebView2 window: no port, no CORS, no
// generated bindings and no WebView message channel to keep alive.
type Bridge struct {
	facade  *takapp.Facade
	window  *application.WebviewWindow
	profile *ProfileService
	online  *OnlineService

	mu      sync.Mutex
	mountMu sync.Mutex
	mounts  map[string]*rcloneMount
	pending *PendingInput
	notice  *Notice
	dialog  *PickedDialog
	seq     int64

	previewMu         sync.Mutex
	previewProgress   OnlineExportProgress
	previewCancel     context.CancelFunc
	previewGeneration uint64
	remoteMediaSlots  chan struct{}
	thumbFlights      sync.Map
	remoteCacheSweeps sync.Map

	fsWindow fsWindowState
}

// fsWindowState is a screen-covering window placement used instead of Wails'
// fullscreen style switch. SetWindowPos resizes the WebView2 child in the same
// message turn, while the fullscreen style change leaves unpainted pixels for
// several frames on this WebView2 build.
type fsWindowState struct {
	Active    bool
	X, Y      int
	Width     int
	Height    int
	Maximised bool
	AlwaysTop bool
}

// SessionCheckReply adds the live Telegram profile to the existing check result.
type SessionCheckReply struct {
	takapp.SessionCheckDTO
	Profile *AccountProfile `json:"profile,omitempty"`
	Source  string          `json:"source,omitempty"`
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

func NewBridge(f *takapp.Facade) *Bridge {
	return &Bridge{
		facade:           f,
		profile:          NewProfileService(f.ConfigDir()),
		online:           NewOnlineService(f.ConfigDir()),
		mounts:           make(map[string]*rcloneMount),
		remoteMediaSlots: make(chan struct{}, 6),
	}
}

// sessionCheck queries Telegram directly with the existing tdl auth key. That
// is much faster than `tdl chat ls` and yields the real account identity.
func (b *Bridge) sessionCheck(timeout int) SessionCheckReply {
	info := b.facade.AccountInfo()
	cached := b.profile.Cached(info.Namespace)
	if b.facade.Running() {
		msg := "下载任务正在运行，Telegram 授权有效"
		if cached != nil {
			msg = fmt.Sprintf("%s（上次验证：%s）", msg, time.UnixMilli(cached.CheckedAt).Format("15:04"))
		}
		return SessionCheckReply{
			SessionCheckDTO: takapp.SessionCheckDTO{State: "ready", Message: msg, Code: 0},
			Profile:         cached, Source: "inferred",
		}
	}
	if !info.HasSessionFile {
		return SessionCheckReply{SessionCheckDTO: takapp.SessionCheckDTO{
			State: "unauthorized", Message: "当前 namespace 没有本地会话，请先登录", Code: -1,
		}}
	}
	if timeout <= 0 || timeout > 20 {
		timeout = 12
	}
	settings := b.facade.GetSettings()
	profile, err := b.profile.Fetch(context.Background(), info.Namespace, settings.Proxy, time.Duration(timeout)*time.Second)
	if err == nil {
		return SessionCheckReply{
			SessionCheckDTO: takapp.SessionCheckDTO{State: "ready", Message: "Telegram 连接正常，账号资料已更新", Code: 0},
			Profile:         &profile, Source: "live",
		}
	}
	state, message := classifyProfileError(err)
	if state == "busy" && info.Running {
		state = "busy"
		message = "tdl 正在运行（下载或登录中），完成后再检查"
	}
	out := SessionCheckReply{
		SessionCheckDTO: takapp.SessionCheckDTO{State: state, Message: message, Detail: err.Error(), Code: 1},
		Source:          "cache",
	}
	if cached != nil {
		out.Profile = cached
	}
	return out
}

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
	result, err := b.dispatch(r.Context(), req.Method, req.Params)
	if err != nil {
		_ = json.NewEncoder(w).Encode(apiReply{Error: err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(apiReply{OK: true, Result: result})
}

type apiParams struct {
	Slug                string              `json:"slug"`
	Folder              string              `json:"folder"`
	Mode                string              `json:"mode"`
	Root                string              `json:"root"`
	Dst                 string              `json:"dst"`
	Path                string              `json:"path"`
	Drive               string              `json:"drive"`
	Peer                string              `json:"peer"`
	Token               string              `json:"token"`
	Limit               int                 `json:"limit"`
	Name                string              `json:"name"`
	Title               string              `json:"title"`
	Initial             string              `json:"initial"`
	Paths               []string            `json:"paths"`
	Peers               []string            `json:"peers"`
	Settings            *takapp.SettingsDTO `json:"settings"`
	Kind                string              `json:"kind"`
	ID                  string              `json:"id"`
	Text                string              `json:"text"`
	Timeout             int                 `json:"timeout"`
	Width               int                 `json:"width"`
	Height              int                 `json:"height"`
	Fullscreen          bool                `json:"fullscreen"`
	Cover               string              `json:"cover"`
	Sharp               string              `json:"sharp"`
	From                []int               `json:"from"`
	To                  []int               `json:"to"`
	Radius              int                 `json:"radius"`
	Duration            int                 `json:"duration"`
	Fade                int                 `json:"fade"`
	Concurrent          int                 `json:"concurrent"`
	Threads             int                 `json:"threads"`
	StallTimeoutSeconds int                 `json:"stallTimeoutSeconds"`
	StalledFileRetries  int                 `json:"stalledFileRetries"`
	NetworkRetryMinutes int                 `json:"networkRetryMinutes"`
	UnknownRetryCount   int                 `json:"unknownRetryCount"`
	MaxRepairPasses     int                 `json:"maxRepairPasses"`
	TransferAdjustment  string              `json:"transferAdjustment"`
	ReconnectTimeout    string              `json:"reconnectTimeout"`
	X                   int                 `json:"x"`
	Y                   int                 `json:"y"`
	Seq                 int64               `json:"seq"`
	Purpose             string              `json:"purpose"`
	Query               string              `json:"query"`
	Sort                string              `json:"sort"`
	Page                int                 `json:"page"`
	Version             string              `json:"version"`
	Refresh             bool                `json:"refresh"`
	LibraryKey          string              `json:"libraryKey"`
}

func (b *Bridge) dispatch(ctx context.Context, method string, raw json.RawMessage) (any, error) {
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
		return b.facade.LibraryChats()
	case "chatMedia":
		return b.facade.ChatMedia(ctx, takapp.MediaQuery{
			Slug: p.Slug, Kind: p.Kind, Sort: p.Sort, Query: p.Query, Page: p.Page,
			Version: p.Version, Refresh: p.Refresh, LibraryKey: p.LibraryKey,
		})
	case "startImportJSON":
		id, err := b.facade.StartImportJSON(p.Paths)
		if err != nil {
			return nil, err
		}
		return map[string]string{"taskId": id}, nil
	case "startImportOfficial":
		id, err := b.facade.StartImportOfficial(p.Folder, p.Slug, p.Mode)
		if err != nil {
			return nil, err
		}
		return map[string]string{"taskId": id}, nil
	case "startExportChat":
		id, err := b.facade.StartExportChat(p.Slug, p.Dst)
		if err != nil {
			return nil, err
		}
		return map[string]string{"taskId": id}, nil
	case "startRefreshWeb":
		id, err := b.facade.StartRefreshWeb(p.Slug)
		if err != nil {
			return nil, err
		}
		return map[string]string{"taskId": id}, nil
	case "startRefreshAllWeb":
		id, err := b.facade.StartRefreshAllWeb()
		if err != nil {
			return nil, err
		}
		return map[string]string{"taskId": id}, nil
	case "startSyncAllMissing":
		id, err := b.facade.StartSyncAllMissing()
		if err != nil {
			return nil, err
		}
		return map[string]string{"taskId": id}, nil
	case "startMergeLibrary":
		id, err := b.facade.StartMergeLibrary(p.Root)
		if err != nil {
			return nil, err
		}
		return map[string]string{"taskId": id}, nil
	case "tasks":
		return b.facade.Tasks(), nil
	case "taskDetail":
		return b.facade.TaskDetail(p.ID)
	case "homeStats":
		return b.facade.HomeStats(), nil
	case "clearTasks":
		b.facade.ClearFinishedTasks()
		return nil, nil
	case "clearAllTasks":
		b.facade.ClearAllTasks()
		return nil, nil
	case "deleteTask":
		return nil, b.facade.DeleteTask(p.ID)
	case "revealMedia":
		return nil, b.facade.RevealMedia(p.Slug, p.Path, p.LibraryKey)
	case "openMedia":
		return nil, b.facade.OpenMedia(p.Slug, p.Path, p.LibraryKey)
	case "state":
		return b.stateReply(), nil
	case "ackPending":
		b.ackPending(p.Seq)
		return nil, nil
	case "ackNotice":
		b.ackNotice(p.Seq)
		return nil, nil
	case "startOneClick":
		return b.facade.StartOneClick(p.Slug)
	case "previewBackfill":
		return b.facade.PreviewBackfill(p.Slug)
	case "previewSyncAll":
		return b.facade.PreviewSyncAll()
	case "setDownloadConfig":
		return b.facade.SetDownloadConfig(takapp.DownloadConfigDTO{
			Concurrent: p.Concurrent, Threads: p.Threads,
			StallTimeoutSeconds: p.StallTimeoutSeconds, StalledFileRetries: p.StalledFileRetries,
			NetworkRetryMinutes: p.NetworkRetryMinutes, UnknownRetryCount: p.UnknownRetryCount,
			MaxRepairPasses: p.MaxRepairPasses, TransferAdjustment: p.TransferAdjustment,
			ReconnectTimeout: p.ReconnectTimeout,
		})
	case "cancel":
		return map[string]bool{"cancelled": b.facade.Cancel()}, nil
	case "pause":
		return map[string]bool{"paused": b.facade.Pause()}, nil
	case "stopTask":
		return b.facade.StopTask(p.ID)
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
	case "remoteStatus":
		if strings.TrimSpace(p.Root) != "" {
			return b.facade.RemoteStatusFor(p.Root), nil
		}
		return b.facade.RemoteStatus(), nil
	case "remoteTools":
		return b.RemoteTools(), nil
	case "clearRemoteCache":
		return b.facade.ClearRemoteCache()
	case "rcloneMount":
		return b.StartRcloneMount(p.Name, p.Path, p.Drive)
	case "rcloneUnmount":
		return nil, b.StopRcloneMount(p.Drive)
	case "listLogs":
		return b.facade.ListLogs(), nil
	case "readLog":
		return b.facade.ReadLog(p.Name)

	case "tdlInfo":
		return b.facade.TdlInfo(), nil
	case "accountInfo":
		return b.facade.AccountInfo(), nil
	case "accountProfile":
		return b.profile.Cached(b.facade.AccountInfo().Namespace), nil
	case "logoutTdl":
		ns := b.facade.AccountInfo().Namespace
		if err := b.facade.LogoutTdl(); err != nil {
			return nil, err
		}
		b.profile.Clear(ns)
		return nil, nil
	case "sessionCheck":
		return b.sessionCheck(p.Timeout), nil
	case "captureWindow":
		return b.CaptureWindow()
	case "setWindowFullscreen":
		if b.window == nil {
			return nil, errors.New("窗口尚未初始化")
		}
		return map[string]bool{"fullscreen": b.setScreenFullscreen(p.Fullscreen, p.Cover)}, nil
	case "hideFullscreenCover":
		hideFsCover(p.Fade)
		return nil, nil
	case "showFullscreenCover":
		if p.Sharp != "" && len(p.From) >= 4 {
			return map[string]bool{"shown": showFsCoverAnimated(p.Cover, p.Sharp, p.From, p.To, p.Radius, p.Duration)}, nil
		}
		return map[string]bool{"shown": showFsCover(p.Cover)}, nil
	case "animateFullscreenCover":
		return map[string]bool{"animated": animateFsCover(p.From, p.To, p.Radius, p.Duration)}, nil
	case "windowFullscreenState":
		return map[string]bool{"fullscreen": b.fsWindow.Active}, nil
	case "onlineChats":
		return b.OnlineChats(p.Timeout)
	case "onlineChatsCached":
		return b.OnlineChatsCached(), nil
	case "onlineChatForSlug":
		return b.OnlineChatForSlug(p.Slug)
	case "onlineAvatars":
		return b.OnlineAvatars(p.Peers, p.Timeout)
	case "onlineExportPreview":
		return b.OnlineExportPreview(p.Peer, p.Timeout, p.Limit, p.Slug)
	case "onlineExportPreviewProgress":
		return b.OnlineExportPreviewProgress(), nil
	case "onlineExportPreviewCancel":
		b.OnlineExportPreviewCancel()
		return nil, nil
	case "onlineExportDiscard":
		b.OnlineExportDiscard(p.Token)
		return nil, nil
	case "onlineExport":
		return b.OnlineExport(p.Peer, p.Timeout, p.Limit, p.Token, p.Slug)
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

	case "windowResize":
		if b.window != nil {
			if p.Width > 0 && p.Height > 0 {
				if p.X >= 0 && p.Y >= 0 {
					b.window.SetPosition(p.X, p.Y)
				}
				b.window.SetSize(p.Width, p.Height)
			}
		}
		return nil, nil
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

// setScreenFullscreen covers the primary monitor with a normal borderless
// window instead of toggling WS_POPUP fullscreen. The latter exposes several
// frames of the old WebView2 surface (white/unpainted) before Chromium commits
// the enlarged frame. A regular SetWindowPos resize keeps the child and page
// geometry in the same WM_SIZE turn.
func (b *Bridge) setScreenFullscreen(on bool, cover string) bool {
	if on {
		if b.fsWindow.Active {
			return true
		}
		x, y := b.window.Position()
		w, h := b.window.Size()
		b.fsWindow = fsWindowState{
			Active: true, X: x, Y: y, Width: w, Height: h,
			Maximised: b.window.IsMaximised(),
		}
		screen := application.Get().Screen.GetPrimary()
		if screen == nil {
			b.fsWindow.Active = false
			return false
		}
		if b.fsWindow.Maximised {
			// A maximized window ignores move/resize; reset to normal first.
			b.window.UnMaximise()
		}
		r1, r2 := applyDarkWindowFrame(b.window.NativeWindow())
		if r1 != 0 && r2 != 0 {
			log.Printf("dark window frame failed: hr20=%#x hr19=%#x", r1, r2)
		}
		b.window.SetAlwaysOnTop(true)
		raiseFsCover()
		// The cover must be above the (now topmost) main window, and it must be
		// visible before SetWindowPos grows the window: WebView2 presents the old
		// surface for a few frames and the exposed strip would otherwise show the
		// Mica base colour.
		if cover != "" {
			showFsCover(cover)
		}
		b.window.SetPosition(screen.Bounds.X, screen.Bounds.Y)
		b.window.SetSize(screen.Bounds.Width, screen.Bounds.Height)
		return true
	}
	if !b.fsWindow.Active {
		return false
	}
	// The cover is owned by the transition: on exit the frontend keeps it
	// visible while the window shrinks and fades it out after the page cover
	// has settled at the restored size.
	state := b.fsWindow
	b.fsWindow.Active = false
	b.window.SetAlwaysOnTop(state.AlwaysTop)
	b.window.SetPosition(state.X, state.Y)
	b.window.SetSize(state.Width, state.Height)
	if state.Maximised {
		b.window.Maximise()
	}
	return true
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
	b.stopAllRcloneMounts()
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
	query := r.URL.Query()
	root, remote, ok := b.facade.MediaLibrary(query.Get("k"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	ctx := r.Context()
	slug, name, version := query.Get("slug"), query.Get("f"), query.Get("v")
	preview := query.Get("preview") == "1"
	var cachePath string
	var size, modTime int64
	if remote && preview && version != "" {
		if n, mtime, ok := b.facade.CachedMediaThumbnail(root, slug, name, version); ok && n > 0 && n <= 8<<20 {
			cachePath = remoteThumbnailPath(b.facade.ConfigDir(), root, slug, name, n, mtime)
			size, modTime = n, mtime
			if cached, err := os.Stat(cachePath); err == nil && cached.Size() == size {
				serveMediaFile(w, r, cachePath, name, true)
				return
			}
		}
	}
	if remote {
		select {
		case b.remoteMediaSlots <- struct{}{}:
			defer func() { <-b.remoteMediaSlots }()
		case <-ctx.Done():
			return
		}
	}
	path, err := b.facade.PlayableMediaPath(ctx, root, slug, name, !remote && !preview && query.Get("prefetch") != "1")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if cachePath != "" {
		if cached := b.cacheRemoteThumbnail(ctx, path, cachePath, size, modTime); cached != "" {
			path = cached
		}
	}
	serveMediaFile(w, r, path, name, version != "")
}

func serveMediaFile(w http.ResponseWriter, r *http.Request, path, name string, versioned bool) {
	if r.Context().Err() != nil {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	if versioned {
		w.Header().Set("Cache-Control", "private, max-age=604800, immutable")
	}
	http.ServeContent(w, r, name, st.ModTime(), mediaReader{r.Context(), f})
}

type mediaReader struct {
	ctx context.Context
	io.ReadSeeker
}

func (r mediaReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.ReadSeeker.Read(p)
}
