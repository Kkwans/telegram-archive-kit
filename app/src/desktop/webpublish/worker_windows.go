package webpublish

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

const WorkerArg = "--web-publication-worker"

var errWorkerOffline = errors.New("部署后台进程未连接")

type controlRequest struct {
	Action  string `json:"action"`
	Config  Config `json:"config"`
	Library string `json:"library"`
}

type controlReply struct {
	Status Status `json:"status"`
	Error  string `json:"error,omitempty"`
}

func configID(dir string) string {
	path, err := filepath.Abs(dir)
	if err != nil {
		path = filepath.Clean(dir)
	}
	hash := sha256.Sum256([]byte(strings.ToLower(path)))
	return hex.EncodeToString(hash[:12])
}

func pipeName(dir string) string { return `\\.\pipe\tak-web-publication-` + configID(dir) }

func processSID() (string, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return u.User.Sid.String(), nil
}

func workerMarker(dir string) string { return filepath.Join(dir, ".web-publication-worker") }

func startWorkerRun(dir string) (string, error) {
	token := rand.Text()
	return token, os.WriteFile(workerMarker(dir), []byte(token), 0600)
}

func workerRequested(dir, token string) bool {
	data, err := os.ReadFile(workerMarker(dir))
	return err == nil && token != "" && string(data) == token
}

// RunWorker owns all public listeners. The control endpoint is a local named
// pipe whose ACL permits only the Windows user that started the worker.
func RunWorker(dir, token string) error {
	saved := readConfig(filepath.Join(dir, "web-publication.json"))
	if !saved.Resume || saved.Library == "" || !workerRequested(dir, token) {
		return nil
	}
	sid, err := processSID()
	if err != nil {
		return err
	}
	ln, err := winio.ListenPipe(pipeName(dir), &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;" + sid + ")"})
	if err != nil {
		if _, probe := callWorker(dir, controlRequest{Action: "status"}); probe == nil {
			return nil
		}
		return err
	}
	defer ln.Close()
	// Quit can withdraw this session's launch authorization while a pending
	// restart is queued. The next sign-in can issue a new authorization.
	if !workerRequested(dir, token) || !readConfig(filepath.Join(dir, "web-publication.json")).Resume {
		return nil
	}
	manager := NewManager(dir, func() string {
		if !workerRequested(dir, token) {
			return ""
		}
		return saved.Library
	}, DiscoverWindows, func(on bool) error { return setWindowsStartup(dir, on) })
	defer manager.Close()
	manager.failure = make(chan error, 1)
	manager.resume(false)
	done := make(chan struct{})
	var closeOnce sync.Once
	server := &http.Server{ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 8 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost || r.URL.Path != "/control" {
				http.NotFound(w, r)
				return
			}
			var req controlRequest
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
				http.Error(w, "invalid control request", http.StatusBadRequest)
				return
			}
			var actionErr error
			switch req.Action {
			case "status":
			case "refresh":
				manager.signal()
			case "save":
				if !sameRoot(req.Library, saved.Library) || !manager.Requested() {
					actionErr = errors.New("请先停止当前档案库的部署")
				} else {
					actionErr = manager.Save(req.Config, false)
				}
			case "stop":
				actionErr = manager.Stop()
				defer closeOnce.Do(func() { close(done) })
			case "close":
				manager.Close()
				defer closeOnce.Do(func() { close(done) })
			default:
				actionErr = errors.New("不支持的后台部署操作")
			}
			out := controlReply{Status: manager.Status(false)}
			if actionErr != nil {
				out.Error = actionErr.Error()
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(out)
		}),
	}
	served := make(chan error, 1)
	go func() { served <- server.Serve(ln) }()
	select {
	case <-done:
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		if workerRequested(dir, token) {
			_ = stopWorkerRun(dir)
		}
		return nil
	case err := <-manager.failure:
		_ = server.Close()
		return err
	case err := <-served:
		return err
	}
}

func callWorker(dir string, req controlRequest) (Status, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	body, err := json.Marshal(req)
	if err != nil {
		return Status{}, err
	}
	transport := &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		connect, stop := context.WithTimeout(ctx, 220*time.Millisecond)
		defer stop()
		conn, err := winio.DialPipeContext(connect, pipeName(dir))
		if err != nil {
			return nil, fmt.Errorf("%w: %v", errWorkerOffline, err)
		}
		return conn, nil
	}}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://tak-control/control", bytes.NewReader(body))
	if err != nil {
		return Status{}, err
	}
	client := &http.Client{Transport: transport}
	resp, err := client.Do(httpReq)
	if err != nil {
		return Status{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Status{}, fmt.Errorf("后台部署返回 HTTP %d", resp.StatusCode)
	}
	var reply controlReply
	if err := json.NewDecoder(resp.Body).Decode(&reply); err != nil {
		return Status{}, err
	}
	if reply.Error != "" {
		return reply.Status, errors.New(reply.Error)
	}
	return reply.Status, nil
}

func workerCommand(action, dir, token string) (*exec.Cmd, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exe, action, dir, token)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW}
	return cmd, nil
}

func launchWorker(dir, token string, cfg Config) error {
	action := WorkerArg
	if cfg.RestartOnFailure {
		action = WatchdogArg
	}
	cmd, err := workerCommand(action, dir, token)
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func ResumeAfterLogin(dir string) error {
	saved := readConfig(filepath.Join(dir, "web-publication.json"))
	if !saved.Auto || !saved.Resume || saved.Library == "" {
		return nil
	}
	if _, err := callWorker(dir, controlRequest{Action: "status"}); err == nil {
		return nil
	} else if !errors.Is(err, errWorkerOffline) {
		return err
	}
	token, err := startWorkerRun(dir)
	if err != nil {
		return err
	}
	if err := launchWorker(dir, token, saved.Config); err != nil {
		if workerRequested(dir, token) {
			_ = stopWorkerRun(dir)
		}
		return err
	}
	return nil
}
