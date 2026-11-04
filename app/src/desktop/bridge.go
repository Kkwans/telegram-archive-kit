package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	takapp "telegramarchivekit/internal/app"
)

// Bridge exposes the engine over the asset server at /api/rpc. It is a normal
// same-origin HTTP endpoint inside the WebView2 window: no port, no CORS, no
// generated bindings and no WebView message channel to keep alive.
type Bridge struct {
	facade *takapp.Facade
	window *application.WebviewWindow
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
		return b.facade.State(), nil
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
		if b.window != nil {
			b.window.Close()
		}
		return nil, nil
	default:
		return nil, errors.New("未知请求: " + method)
	}
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
