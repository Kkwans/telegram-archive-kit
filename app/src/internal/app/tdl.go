package app

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"telegramarchivekit/internal/archive"
	"telegramarchivekit/internal/platform"
)

type tdlRelease struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Digest             string `json:"digest"`
	} `json:"assets"`
}

type SessionStatus struct {
	State   string
	Message string
	Detail  string
	Code    int
}

const (
	tdlFailureNetwork = "network"
	tdlFailureAuth    = "auth"
	tdlFailureContent = "content"
	tdlFailureUnknown = "unknown"
)

var errUserAbort = errors.New("用户已中止下载；已完成文件已保留")
var errDeferredExhausted = errors.New("疑难文件重试次数已耗尽")

type TdlFailure struct {
	Kind      string
	Summary   string
	Detail    string
	LogPath   string
	ExitCode  int
	Stalled   bool
	ActiveIDs []string
}

func (e *TdlFailure) Error() string {
	if e == nil {
		return ""
	}
	if e.Summary != "" {
		return e.Summary
	}
	return "tdl 下载失败"
}

func cleanTdlText(s string) string {
	s = ansiRE.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "\r", "\n")
	return strings.TrimSpace(s)
}

func containsAny(s string, xs ...string) bool {
	s = strings.ToLower(s)
	for _, x := range xs {
		if strings.Contains(s, strings.ToLower(x)) {
			return true
		}
	}
	return false
}

func summarizeTdlError(raw string) string {
	clean := cleanTdlText(raw)
	if clean == "" {
		return "tdl 返回非 0，但没有输出错误详情"
	}
	low := strings.ToLower(clean)
	known := []string{
		"not authorized", "auth_key_unregistered", "session_revoked", "auth_key_duplicated",
		"connection dead", "retry limit reached", "connection reset", "connection refused",
		"no route to host", "network is unreachable", "i/o timeout", "timed out", " eof",
		"chat_id_invalid", "username_invalid", "invalid message", "file_reference",
	}
	for _, k := range known {
		if i := strings.Index(low, k); i >= 0 {
			lineStart := strings.LastIndex(clean[:i], "\n") + 1
			lineEnd := strings.Index(clean[i:], "\n")
			if lineEnd < 0 {
				lineEnd = len(clean)
			} else {
				lineEnd += i
			}
			line := strings.TrimSpace(strings.TrimLeft(clean[lineStart:lineEnd], "-*• \t"))
			if line != "" {
				return shortLine(line, 120)
			}
		}
	}
	lines := strings.Split(clean, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" || strings.HasPrefix(line, "github.com/") || strings.HasPrefix(line, "go.uber.org/") || strings.Contains(line, ".go:") {
			continue
		}
		if line == "Error: callback:" || line == "Error: group:" || line == "callback:" || line == "group:" {
			continue
		}
		line = strings.TrimSpace(strings.TrimLeft(line, "-*• \t"))
		if line != "" {
			return shortLine(line, 120)
		}
	}
	return shortLine(strings.ReplaceAll(clean, "\n", " "), 120)
}

func classifyTdlFailure(raw string, runErr error, logPath string) *TdlFailure {
	clean := cleanTdlText(raw)
	low := strings.ToLower(clean)
	code := 1
	if ee, ok := runErr.(*exec.ExitError); ok {
		code = ee.ExitCode()
	}
	f := &TdlFailure{Kind: tdlFailureUnknown, Summary: summarizeTdlError(clean), Detail: clean, LogPath: logPath, ExitCode: code}
	if containsAny(low, "not authorized", "auth_key_unregistered", "session_revoked", "auth_key_duplicated", "please login first") {
		f.Kind = tdlFailureAuth
		f.Summary = "Telegram 授权不可用，需要重新登录"
		return f
	}
	if containsAny(low,
		"connection dead", "retry limit reached", "connection reset", "connection refused", "connection aborted",
		"network is unreachable", "no route to host", "dial tcp", "i/o timeout", "timed out", "unexpected eof",
		"read length: eof", "engine forcibly closed", "wsarecv", "forcibly closed by the remote host") {
		f.Kind = tdlFailureNetwork
		f.Summary = "Telegram 网络连接中断"
		return f
	}
	// tdl sometimes collapses a short network interruption into only these generic
	// errgroup/callback wrappers. Treat them as transient after auth/content signatures
	// have already been excluded, so switching proxy nodes does not immediately dump
	// the user back to a confirmation screen. The retry window is bounded by settings.
	if containsAny(low, "error: group:", "error: callback:") {
		f.Kind = tdlFailureNetwork
		f.Summary = "tdl 任务组中断，按临时网络故障自动恢复"
		return f
	}
	if containsAny(low, "invalid message", "chat_id_invalid", "username_invalid", "media_invalid", "message_id_invalid") {
		f.Kind = tdlFailureContent
		return f
	}
	return f
}

func globalTdlDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, "AppData", "Local")
	}
	return filepath.Join(base, "Programs", "tdl")
}

func globalTdlExe() string { return filepath.Join(globalTdlDir(), "tdl.exe") }

func tdlDataDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".tdl")
}

func (a *App) resolveTdl() string {
	if p, err := exec.LookPath("tdl.exe"); err == nil && p != "" {
		return p
	}
	if p, err := exec.LookPath("tdl"); err == nil && p != "" {
		return p
	}
	if fileExists(globalTdlExe()) {
		return globalTdlExe()
	}
	return ""
}

func (a *App) findLegacyTdl() string {
	parent := filepath.Dir(a.ExeDir)
	entries, _ := os.ReadDir(parent)
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(strings.ToLower(e.Name()), "telegramarchivekit_v") {
			continue
		}
		root := filepath.Join(parent, e.Name())
		candidates := []string{
			filepath.Join(root, "app", "tools", "tdl", "tdl.exe"),
			filepath.Join(root, "tools", "tdl", "tdl.exe"),
			filepath.Join(root, "app", "bin", "tdl.exe"),
		}
		for _, p := range candidates {
			if fileExists(p) {
				return p
			}
		}
	}
	return ""
}

func (a *App) ensureTdlInstalled(progress func(string)) (string, error) {
	if p := a.resolveTdl(); p != "" {
		return p, nil
	}
	if legacy := a.findLegacyTdl(); legacy != "" {
		if progress != nil {
			progress("检测到旧版 tdl，正在迁移到用户级全局目录…")
		}
		if err := os.MkdirAll(globalTdlDir(), 0755); err != nil {
			return "", err
		}
		if err := copyFile(legacy, globalTdlExe()); err != nil {
			return "", err
		}
		_ = platform.AddUserPath(globalTdlDir())
		return globalTdlExe(), nil
	}
	if progress != nil {
		progress("未发现 tdl，正在从官方 GitHub Release 安装…")
	}
	if err := installLatestTdl(progress); err != nil {
		return "", err
	}
	return globalTdlExe(), nil
}

func installLatestTdl(progress func(string)) error {
	client := &http.Client{Timeout: 3 * time.Minute}
	req, _ := http.NewRequest("GET", "https://api.github.com/repos/iyear/tdl/releases/latest", nil)
	req.Header.Set("User-Agent", "TelegramArchiveKit/"+version)
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("获取 tdl 最新版本失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("GitHub 返回 HTTP %d", resp.StatusCode)
	}
	var rel tdlRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return err
	}
	want := "tdl_Windows_64bit.zip"
	if runtime.GOARCH == "arm64" {
		want = "tdl_Windows_arm64.zip"
	} else if runtime.GOARCH == "386" {
		want = "tdl_Windows_32bit.zip"
	}
	var url, digest string
	for _, as := range rel.Assets {
		if as.Name == want {
			url, digest = as.BrowserDownloadURL, as.Digest
			break
		}
	}
	if url == "" {
		return fmt.Errorf("tdl %s 中未找到 %s", rel.TagName, want)
	}
	if progress != nil {
		progress("下载 " + rel.TagName + " · " + want)
	}
	tmp, err := os.CreateTemp("", "tdl-*.zip")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	dreq, _ := http.NewRequest("GET", url, nil)
	dreq.Header.Set("User-Agent", "TelegramArchiveKit/"+version)
	dresp, err := client.Do(dreq)
	if err != nil {
		tmp.Close()
		return err
	}
	defer dresp.Body.Close()
	if dresp.StatusCode/100 != 2 {
		tmp.Close()
		return fmt.Errorf("下载 tdl 失败: HTTP %d", dresp.StatusCode)
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), dresp.Body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if strings.HasPrefix(digest, "sha256:") {
		got := hex.EncodeToString(h.Sum(nil))
		wantDigest := strings.TrimPrefix(digest, "sha256:")
		if !strings.EqualFold(got, wantDigest) {
			return fmt.Errorf("tdl SHA-256 校验失败")
		}
	}
	zr, err := zip.OpenReader(tmpPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	var exeFile *zip.File
	for _, f := range zr.File {
		if strings.EqualFold(filepath.Base(f.Name), "tdl.exe") {
			exeFile = f
			break
		}
	}
	if exeFile == nil {
		return fmt.Errorf("压缩包中没有 tdl.exe")
	}
	if err := os.MkdirAll(globalTdlDir(), 0755); err != nil {
		return err
	}
	rc, err := exeFile.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.Create(globalTdlExe())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, rc); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	_ = platform.AddUserPath(globalTdlDir())
	if progress != nil {
		progress("tdl 已安装到 " + globalTdlExe())
	}
	return nil
}

func (a *App) tdlBaseArgs() []string {
	args := []string{"-n", a.Settings.TdlNamespace, "--reconnect-timeout", a.Settings.ReconnectTimeout}
	if strings.TrimSpace(a.Settings.Proxy) != "" {
		args = append(args, "--proxy", strings.TrimSpace(a.Settings.Proxy))
	}
	return args
}

func (a *App) testTdlSession(timeout time.Duration) SessionStatus {
	exe := a.resolveTdl()
	if exe == "" {
		return SessionStatus{State: "no-tdl", Message: "tdl 未安装", Code: -1}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	// Do not request JSON here. Older tdl versions have had chat-ls failures on
	// problematic dialogs, and a full chat enumeration is only a connectivity
	// diagnostic, not a trustworthy authorization oracle. The exact command also
	// matches the simple `tdl -n ... chat ls` that users commonly test manually.
	args := append(a.tdlBaseArgs(), "chat", "ls")
	cmd := exec.CommandContext(ctx, exe, args...)
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return SessionStatus{State: "timeout", Message: "连接检查超时；本地会话仍然保留", Detail: string(out), Code: -2}
	}
	if err == nil {
		return SessionStatus{State: "ready", Message: "Telegram 连接正常，会话可用", Code: 0}
	}
	code := 1
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	}
	raw := string(out)
	low := strings.ToLower(raw)
	msg := summarizeTdlError(raw)
	if containsAny(low, "not authorized", "auth_key_unregistered", "session_revoked", "please login first") {
		return SessionStatus{State: "unauthorized", Message: "Telegram 授权已失效或当前 namespace 未登录", Detail: raw, Code: code}
	}
	if containsAny(low, "connection dead", "retry limit reached", "connection reset", "connection refused", "network is unreachable", "no route to host", "dial tcp", "i/o timeout", "timed out", "eof") {
		return SessionStatus{State: "network", Message: "网络连接失败；这不等于登录失效", Detail: raw, Code: code}
	}
	if msg == "" {
		msg = "chat ls 返回非 0；不能据此判定登录失效"
	}
	return SessionStatus{State: "check-failed", Message: msg, Detail: raw, Code: code}
}

func hasTdlSessionData() bool {
	for _, p := range []string{filepath.Join(tdlDataDir(), "data"), filepath.Join(tdlDataDir(), "data.kv")} {
		if fileExists(p) {
			return true
		}
	}
	return false
}

func (a *App) loginTdl(loginType string) error {
	exe, err := a.ensureTdlInstalled(nil)
	if err != nil {
		return err
	}
	args := append(a.tdlBaseArgs(), "login", "-T", loginType)
	cmd := exec.Command(exe, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func (a *App) tdlVersion() string {
	exe := a.resolveTdl()
	if exe == "" {
		return ""
	}
	out, err := exec.Command(exe, "version").CombinedOutput()
	if err != nil {
		return ""
	}
	line := strings.TrimSpace(string(out))
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	return line
}

func adaptiveTransferProfile(concurrent, threads, stallLevel int, enabled bool) (int, int) {
	if concurrent < 1 {
		concurrent = 1
	}
	if threads < 1 {
		threads = 1
	}
	if !enabled || stallLevel <= 0 {
		return concurrent, threads
	}
	switch stallLevel {
	case 1:
		if concurrent > 2 {
			concurrent = 2
		}
		if threads > 4 {
			threads = 4
		}
	case 2:
		concurrent = 1
		if threads > 2 {
			threads = 2
		}
	default:
		concurrent = 1
		threads = 1
	}
	return concurrent, threads
}

func (a *App) downloadMissing(slug, jsonPath string, pass int, globalEngineRestarts *int) error {
	exe, err := a.ensureTdlInstalled(nil)
	if err != nil {
		return err
	}
	// The dashboard always uses the complete chat media plan, while tdl receives
	// only the current missing subset. That makes a resumed run display e.g.
	// 52/4666 instead of misleadingly starting at 1/4615.
	basePlan, err := loadDownloadPlan(a.sourcePath(slug))
	if err != nil {
		return fmt.Errorf("读取完整媒体计划失败: %w", err)
	}
	pendingPlan, err := loadDownloadPlan(jsonPath)
	if err != nil {
		return fmt.Errorf("读取下载计划失败: %w", err)
	}
	if pendingPlan.Total == 0 {
		return nil
	}
	meta, _ := a.readWorkspaceMeta(slug)
	chatName := meta.Chat.Name
	if chatName == "" {
		chatName = slug
	}

	currentJSON := jsonPath
	startedAll := time.Now()
	networkRetryStart := time.Time{}
	networkAttempt := 0
	unknownAttempt := 0
	if globalEngineRestarts == nil {
		budget := 0
		globalEngineRestarts = &budget
	}
	deferred := map[string]int{} // stalled media IDs, retried individually at the end
	activeDeferred := ""
	deferredInfo := ""
	exhausted := map[string]bool{}
	// Plan next work from the current filesystem, never from tdl's resume state.
	advanceDeferred := func() (bool, error) {
		_, missingPath, err := a.generateMissingJSON(slug)
		if err != nil {
			return false, err
		}
		if missingPath == "" {
			return false, nil
		}
		nonStalled, err := filterDownloadJSON(missingPath, func() map[string]bool {
			ids := map[string]bool{}
			for id := range deferred {
				ids[id] = true
			}
			return ids
		}(), nil, filepath.Join(a.runtimeDir(), "work", slug, "nonstalled.json"))
		if err != nil {
			return false, err
		}
		if nonStalled > 0 {
			currentJSON = filepath.Join(a.runtimeDir(), "work", slug, "nonstalled.json")
			activeDeferred = ""
			return true, nil
		}
		keys := make([]string, 0, len(deferred))
		for id := range deferred {
			keys = append(keys, id)
		}
		sort.Slice(keys, func(i, j int) bool {
			ai, _ := strconv.ParseInt(keys[i], 10, 64)
			aj, _ := strconv.ParseInt(keys[j], 10, 64)
			return ai < aj
		})
		for _, id := range keys {
			// Check actual remaining JSON BEFORE judging the retry budget:
			// an item completed on its final attempt must not be marked failed.
			only := map[string]bool{id: true}
			n, err := filterDownloadJSON(missingPath, nil, only, filepath.Join(a.runtimeDir(), "work", slug, "deferred-one.json"))
			if err != nil {
				return false, err
			}
			if n == 0 {
				delete(deferred, id)
				delete(exhausted, id)
				continue
			}
			if deferred[id] >= a.Settings.StalledFileRetries {
				exhausted[id] = true
				continue
			}
			deferred[id]++
			activeDeferred = id
			currentJSON = filepath.Join(a.runtimeDir(), "work", slug, "deferred-one.json")
			return true, nil
		}
		if len(exhausted) > 0 {
			ids := make([]string, 0, len(exhausted))
			for id := range exhausted {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			return false, fmt.Errorf("%w: %d 个媒体分别重试 %d 次仍无法下载：Message ID %s；其他资源已保留", errDeferredExhausted, len(ids), a.Settings.StalledFileRetries, strings.Join(ids, ", "))
		}
		return false, nil
	}

	// There are two bounded epochs, never a loop of fresh 60-second restarts.
	// Epoch 1: healthy queue followed by problematic files.
	// Then one diagnostic and one global engine restart. Epoch 2 has a fresh
	// per-file retry budget; after it is exhausted the task ends with a report.
	restartAfterDiagnostic := func(reason string) (bool, error) {
		if !consumeGlobalRestart(globalEngineRestarts) {
			return false, nil
		}
		completed, totalBytes := a.downloadProgressState(slug, basePlan, nil)
		a.renderDownloadDashboardState(chatName, pass, basePlan, completed, totalBytes, 0, time.Since(startedAll), nil,
			"正在诊断", "疑难文件已完成第一轮重试；正在检查 Telegram 连通性，随后最多整体重启一次", 0, a.Settings.Concurrent, a.Settings.Threads)
		diagCh := make(chan SessionStatus, 1)
		go func() { diagCh <- a.testTdlSession(12 * time.Second) }()
		diagStarted := time.Now()
		var diagnosis SessionStatus
		diagDone := false
		for !diagDone {
			select {
			case diagnosis = <-diagCh:
				diagDone = true
			case <-time.After(250 * time.Millisecond):
				a.renderDownloadDashboardState(chatName, pass, basePlan, completed, totalBytes, 0, time.Since(startedAll), nil,
					"正在诊断", fmt.Sprintf("检查连接和授权 · 已等待 %s（最多 12 秒） · 只剩最后一次整体重启", formatDuration(time.Since(diagStarted))), 0, a.Settings.Concurrent, a.Settings.Threads)
			}
			if k, ok := pollKey(1 * time.Millisecond); ok && k.Code == keyEsc {
				return false, errUserAbort
			}
		}
		diagnosticText := fmt.Sprintf("%s (%s); cause=%s; epoch=2/2", diagnosis.State, diagnosis.Message, reason)
		_ = os.MkdirAll(a.logsDir(), 0755)
		_ = os.WriteFile(filepath.Join(a.logsDir(), "last-recovery-diagnostic.txt"), []byte(time.Now().Format(time.RFC3339)+"\n"+diagnosticText+"\n"+diagnosis.Detail), 0644)
		if diagnosis.State == "unauthorized" {
			return false, fmt.Errorf("诊断发现授权已失效：%s", diagnosis.Message)
		}
		missing, pth, e := a.generateMissingJSON(slug)
		if e != nil {
			return false, e
		}
		if missing == 0 {
			return false, nil
		}
		currentJSON = pth
		activeDeferred = ""
		deferred = map[string]int{}
		exhausted = map[string]bool{}
		networkAttempt, unknownAttempt = 0, 0
		networkRetryStart = time.Time{}
		a.renderDownloadDashboardState(chatName, pass, basePlan, completed, totalBytes, 0, time.Since(startedAll), nil,
			"诊断完成", fmt.Sprintf("%s；最后一轮（2/2），疑难文件重试次数重新计数", diagnosis.Message), 0, a.Settings.Concurrent, a.Settings.Threads)
		time.Sleep(900 * time.Millisecond)
		return true, nil
	}

	for {
		effectiveConcurrent, effectiveThreads := a.Settings.Concurrent, a.Settings.Threads
		if a.Settings.TransferAdjustment == "increase-both" && *globalEngineRestarts > 0 {
			effectiveConcurrent = min(8, effectiveConcurrent+2)
			effectiveThreads = min(16, effectiveThreads+2)
		}
		if activeDeferred != "" {
			// A single failing media item cannot produce multiple simultaneous
			// file tasks. Increasing threads can help only this isolated file.
			effectiveConcurrent = 1
			effectiveThreads = retryThreads(a.Settings.Threads, deferred[activeDeferred], a.Settings.TransferAdjustment)
		}
		failure, runErr := a.runTdlDownloadAttempt(exe, slug, currentJSON, chatName, pass, basePlan, startedAll, effectiveConcurrent, effectiveThreads)
		if runErr == nil {
			if len(deferred) > 0 {
				more, e := advanceDeferred()
				if e != nil {
					if errors.Is(e, errDeferredExhausted) {
						if retry, e2 := restartAfterDiagnostic(e.Error()); e2 != nil {
							return e2
						} else if retry {
							continue
						}
					}
					return e
				}
				if more {
					continue
				}
			}
			return nil
		}
		if errors.Is(runErr, errUserAbort) {
			return runErr
		}
		if failure == nil {
			return runErr
		}
		if failure.Kind == tdlFailureAuth || failure.Kind == tdlFailureContent {
			return failure
		}
		if failure.Stalled && len(failure.ActiveIDs) > 0 {
			if activeDeferred == "" {
				for _, id := range failure.ActiveIDs {
					if _, has := deferred[id]; !has {
						deferred[id] = 0
					}
				}
				deferredInfo = fmt.Sprintf("暂缓 %d 个无进展文件，先完成其余媒体；疑难文件每轮最多重试 %d 次", len(deferred), a.Settings.StalledFileRetries)
			} else {
				deferredInfo = fmt.Sprintf("媒体 #%s 重试 %d/%d 次仍无进展，转到队尾", activeDeferred, deferred[activeDeferred], a.Settings.StalledFileRetries)
			}
			more, e := advanceDeferred()
			if e != nil {
				if errors.Is(e, errDeferredExhausted) {
					if retry, e2 := restartAfterDiagnostic(e.Error()); e2 != nil {
						return e2
					} else if retry {
						continue
					}
				}
				return e
			}
			if more {
				done, byteCount := a.downloadProgressState(slug, basePlan, nil)
				if !a.waitForRetry(chatName, pass, basePlan, done, byteCount, time.Since(startedAll), deferredInfo, deferredInfo,
					time.Second, effectiveConcurrent, effectiveThreads) {
					return errUserAbort
				}
				continue
			}
			// Empty queue after a file-only stall: do not restart forever.
			if retry, e2 := restartAfterDiagnostic(failure.Summary); e2 != nil {
				return e2
			} else if retry {
				continue
			}
			return failure
		}
		// Bounded retries for transient network and ambiguous errors. The
		// global diagnostic restart is also bounded, independent of wall clock.
		autoRetry := false
		delay := time.Second
		if failure.Kind == tdlFailureNetwork {
			if networkRetryStart.IsZero() {
				networkRetryStart = time.Now()
			}
			networkAttempt++
			autoRetry = networkAttempt <= a.Settings.StalledFileRetries && time.Since(networkRetryStart) <= time.Duration(max(1, a.Settings.NetworkRetryMinutes))*time.Minute
			delay = retryBackoff(networkAttempt)
		} else if failure.Kind == tdlFailureUnknown {
			unknownAttempt++
			autoRetry = unknownAttempt <= min(a.Settings.UnknownRetryCount, a.Settings.StalledFileRetries)
			delay = retryBackoff(unknownAttempt)
		}
		if !autoRetry {
			if retry, e := restartAfterDiagnostic(failure.Summary); e != nil {
				return e
			} else if retry {
				continue
			}
			return failure
		}
		missing, nextJSON, e := a.generateMissingJSON(slug)
		if e != nil {
			return e
		}
		if missing == 0 {
			return nil
		}
		currentJSON = nextJSON
		done, byteCount := a.downloadProgressState(slug, basePlan, nil)
		if !a.waitForRetry(chatName, pass, basePlan, done, byteCount, time.Since(startedAll), failure.Summary,
			fmt.Sprintf("连接恢复尝试 %d/%d · 整体诊断重启 %d/1", networkAttempt, a.Settings.StalledFileRetries, *globalEngineRestarts), delay, a.Settings.Concurrent, a.Settings.Threads) {
			return errUserAbort
		}
	}

}

// retryThreads adjusts a problematic *single* file without degrading the
// healthy queue. The number of concurrent files is unchanged outside retry.
// One budget is shared by every repair pass. A failed recovery cannot consume
// another restart when the outer smart-sync loop begins a new pass.
func consumeGlobalRestart(budget *int) bool {
	if budget == nil || *budget >= 1 {
		return false
	}
	*budget++
	return true
}

func retryThreads(base, attempt int, policy string) int {
	if base < 1 {
		base = 1
	}
	switch policy {
	case "increase", "increase-both":
		return min(16, base+2*max(0, attempt))
	case "decrease":
		return max(1, base-max(0, attempt))
	default:
		return base
	}
}

func retryBackoff(n int) time.Duration {
	steps := []time.Duration{2, 3, 5, 8, 13, 20, 30}
	if n <= 0 {
		n = 1
	}
	if n > len(steps) {
		n = len(steps)
	}
	return steps[n-1] * time.Second
}

func (a *App) waitForRetry(chat string, pass int, plan downloadPlan, done int, bytesNow int64, elapsed time.Duration, summary, reason string, delay time.Duration, effectiveConcurrent, effectiveThreads int) bool {
	until := time.Now().Add(delay)
	for {
		remaining := time.Until(until)
		if remaining <= 0 {
			return true
		}
		detail := reason
		if strings.TrimSpace(detail) == "" {
			detail = summary
		}
		a.renderDownloadDashboardState(chat, pass, plan, done, bytesNow, 0, elapsed+delay-remaining, nil, "等待网络恢复", detail, remaining, effectiveConcurrent, effectiveThreads)
		if k, ok := pollKey(120 * time.Millisecond); ok && k.Code == keyEsc {
			return false
		}
	}
}

func priorUnknownCompleted(basePlan, pendingPlan downloadPlan) int {
	n := 0
	for id, expected := range basePlan.IDs {
		if expected != 0 {
			continue
		}
		if _, stillPending := pendingPlan.IDs[id]; !stillPending {
			n++
		}
	}
	return n
}

func (a *App) runTdlDownloadAttempt(exe, slug, jsonPath, chatName string, pass int, basePlan downloadPlan, startedAll time.Time, effectiveConcurrent, effectiveThreads int) (*TdlFailure, error) {
	args := append(a.tdlBaseArgs(), "-l", fmt.Sprint(effectiveConcurrent), "-t", fmt.Sprint(effectiveThreads), "download", "--restart", "-f", jsonPath, "-d", a.mediaDir(slug))
	_ = os.MkdirAll(a.logsDir(), 0755)
	logPath := filepath.Join(a.logsDir(), "tdl-"+slug+"-"+time.Now().Format("20060102-150405.000")+".log")
	logFile, _ := os.Create(logPath)
	if logFile != nil {
		defer logFile.Close()
	}
	capture := newProgressCapture(logFile)
	cmd := exec.Command(exe, args...)
	cmd.Stdout = capture
	cmd.Stderr = capture
	cmd.Stdin = nil
	if err := cmd.Start(); err != nil {
		f := &TdlFailure{Kind: tdlFailureUnknown, Summary: "无法启动 tdl", Detail: err.Error(), LogPath: logPath, ExitCode: -1}
		return f, f
	}
	result := make(chan error, 1)
	go func() { result <- cmd.Wait() }()

	lastTick := time.Now()
	lastBytes := int64(0)
	smoothedSpeed := float64(0)
	ticker := time.NewTicker(650 * time.Millisecond)
	defer ticker.Stop()

	baselineDone, baselineBytes := a.downloadExistingSnapshot(slug, basePlan)
	pd, speeds, _ := capture.snapshot()
	done, bytesNow := progressFromBaseline(basePlan, baselineDone, baselineBytes, pd, capture.doneSizeSnapshot())
	activeSpeed := sumRates(speeds)
	active, finished := capture.dashboardTasks(basePlan)
	a.renderDownloadDashboardDetailed(chatName, pass, basePlan, done, bytesNow, activeSpeed, time.Since(startedAll), "正在下载", "", 0, effectiveConcurrent, effectiveThreads, active, finished)
	lastBytes = bytesNow

	for {
		select {
		case runErr := <-result:
			pd, speeds, recent := capture.snapshot()
			done, bytesNow = progressFromBaseline(basePlan, baselineDone, baselineBytes, pd, capture.doneSizeSnapshot())
			activeSpeed = sumRates(speeds)
			if activeSpeed <= 0 {
				activeSpeed = smoothedSpeed
			}
			if runErr == nil {
				a.renderDownloadDashboardState(chatName, pass, basePlan, done, bytesNow, activeSpeed, time.Since(startedAll), recent, "已完成", "正在重新核对本地文件…", 0, effectiveConcurrent, effectiveThreads)
				time.Sleep(260 * time.Millisecond)
				return nil, nil
			}
			// A killed/failed worker can leave a partially-written final filename.
			// Remove only files belonging to tasks that were active but never emitted
			// `done!`; known-size completed files are kept.
			a.cleanupInterruptedMedia(slug, capture.activeSnapshot(), basePlan)
			failure := classifyTdlFailure(capture.rawSnapshot(), runErr, logPath)
			return failure, failure
		case now := <-ticker.C:
			pd, speeds, _ = capture.snapshot()
			done, bytesNow = progressFromBaseline(basePlan, baselineDone, baselineBytes, pd, capture.doneSizeSnapshot())
			dt := now.Sub(lastTick).Seconds()
			measured := float64(0)
			if dt > 0 && bytesNow >= lastBytes {
				measured = float64(bytesNow-lastBytes) / dt
			}
			activeSpeed = sumRates(speeds)
			if capture.movementAge() > 3*time.Second {
				// tdl keeps the last printed per-task speed in our parser even after a
				// link stalls. Never display that stale number as if traffic were still flowing.
				activeSpeed = 0
			}
			candidate := activeSpeed
			if candidate <= 0 {
				candidate = measured
			}
			if smoothedSpeed == 0 {
				smoothedSpeed = candidate
			} else if candidate > 0 {
				smoothedSpeed = smoothedSpeed*0.55 + candidate*0.45
			} else {
				smoothedSpeed *= 0.45
				if smoothedSpeed < 1024 {
					smoothedSpeed = 0
				}
			}
			stallAfter := time.Duration(max(30, a.Settings.StallTimeoutSeconds)) * time.Second
			if capture.movementAge() >= stallAfter && time.Since(startedAll) >= stallAfter {
				activeIDs := capture.activeIDs()
				_ = killProcessTree(cmd.Process.Pid)
				select {
				case <-result:
				case <-time.After(3 * time.Second):
				}
				a.cleanupInterruptedMedia(slug, capture.activeSnapshot(), basePlan)
				f := &TdlFailure{
					Kind: tdlFailureNetwork, Stalled: true, ActiveIDs: activeIDs,
					Summary: fmt.Sprintf("tdl 连续 %d 秒没有进展，暂缓当前媒体并继续其他文件", int(stallAfter.Seconds())),
					Detail:  "TAK_STALL_WATCHDOG", LogPath: logPath, ExitCode: -3,
				}
				return f, f
			}
			active, finished := capture.dashboardTasks(basePlan)
			a.renderDownloadDashboardDetailed(chatName, pass, basePlan, done, bytesNow, smoothedSpeed, time.Since(startedAll), "正在下载", "", 0, effectiveConcurrent, effectiveThreads, active, finished)
			lastBytes, lastTick = bytesNow, now
		default:
			if k, ok := pollKey(70 * time.Millisecond); ok && k.Code == keyEsc {
				_ = killProcessTree(cmd.Process.Pid)
				// Do not let a misbehaving child make Esc feel like the old Ctrl+C hang.
				select {
				case <-result:
				case <-time.After(3 * time.Second):
				}
				a.cleanupInterruptedMedia(slug, capture.activeSnapshot(), basePlan)
				return nil, errUserAbort
			}
		}
	}
}

func sumRates(m map[string]float64) float64 {
	var v float64
	for _, x := range m {
		v += x
	}
	return v
}

func (a *App) cleanupInterruptedMedia(slug string, active map[string]bool, plan downloadPlan) {
	if len(active) == 0 {
		return
	}
	_ = filepath.WalkDir(a.mediaDir(slug), func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		base := d.Name()
		id := archive.MessageIDFromFilename(base)
		if !active[id] {
			return nil
		}
		info, er := d.Info()
		if er != nil {
			return nil
		}
		expected := plan.IDs[id]
		if expected > 0 && info.Size() == expected {
			return nil
		}
		_ = os.Remove(path)
		return nil
	})
}

func killProcessTree(pid int) error {
	if runtime.GOOS == "windows" {
		return exec.Command("taskkill", "/PID", fmt.Sprint(pid), "/T", "/F").Run()
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func isTdlRunning() bool { return processRunning("tdl.exe") }

func killAllTdl() error {
	if runtime.GOOS != "windows" {
		return nil
	}
	cmd := exec.Command("taskkill", "/F", "/IM", "tdl.exe", "/T")
	out, err := cmd.CombinedOutput()
	if err != nil {
		// If there is no process, taskkill returns non-zero. Treat that as success.
		low := strings.ToLower(string(out))
		if strings.Contains(low, "not found") || strings.Contains(low, "no running instance") || strings.Contains(low, "没有找到") {
			return nil
		}
		return fmt.Errorf("结束 tdl.exe 失败: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// filterDownloadJSON retains JSON export metadata but selects records by
// Message ID. excluded and only are optional; filter result preserves order.
func filterDownloadJSON(src string, excluded, only map[string]bool, dst string) (int, error) {
	b, err := os.ReadFile(src)
	if err != nil {
		return 0, err
	}
	var root map[string]any
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	if err = d.Decode(&root); err != nil {
		return 0, err
	}
	arr, _ := root["messages"].([]any)
	kept := make([]any, 0, len(arr))
	for _, r := range arr {
		m, ok := r.(map[string]any)
		if !ok {
			continue
		}
		id := archive.AnyString(m["id"])
		if excluded != nil && excluded[id] {
			continue
		}
		if only != nil && !only[id] {
			continue
		}
		kept = append(kept, r)
	}
	root["messages"] = kept
	out, err := json.Marshal(root)
	if err != nil {
		return 0, err
	}
	if err = os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return 0, err
	}
	return len(kept), os.WriteFile(dst, out, 0644)
}
