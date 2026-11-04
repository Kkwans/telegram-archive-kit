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
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
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

func (b *Bridge) dispatch(method string, raw json.RawMessage) (any, error) {
	var params struct {
		Slug string `json:"slug"`
	}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &params)
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
		id, err := b.facade.StartOneClick(params.Slug)
		if err != nil {
			return nil, err
		}
		return map[string]string{"opId": id}, nil
	case "cancel":
		return map[string]bool{"cancelled": b.facade.Cancel()}, nil
	case "openLibrary":
		return nil, b.facade.OpenLibrary(params.Slug)
	case "revealChat":
		return nil, b.facade.RevealChat(params.Slug)
	case "revealLogs":
		return nil, b.facade.RevealLogs()
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
