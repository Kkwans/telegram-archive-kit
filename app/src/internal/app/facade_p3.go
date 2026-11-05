package app

import (
	"fmt"
	"strings"
	"time"
)

// SessionCheckDTO is JSON-friendly form of SessionStatus for the account page.
type SessionCheckDTO struct {
	State   string `json:"state"`
	Message string `json:"message"`
	Detail  string `json:"detail,omitempty"`
	Code    int    `json:"code"`
}

// TdlInfoDTO summarizes the local tdl installation and session for the account
// page header card.
type TdlInfoDTO struct {
	Exe        string `json:"exe"`
	Version    string `json:"version"`
	SessionDir string `json:"sessionDir"`
	HasSession bool   `json:"hasSession"`
	Running    bool   `json:"running"`
	Namespace  string `json:"namespace"`
}

func (f *Facade) TdlInfo() TdlInfoDTO {
	running := isTdlRunning()
	exe := f.a.resolveTdl()
	version := ""
	if exe != "" {
		version = f.a.tdlVersion()
	}
	return TdlInfoDTO{
		Exe:        exe,
		Version:    version,
		SessionDir: tdlDataDir(),
		HasSession: hasTdlSessionData(),
		Running:    running,
		Namespace:  f.a.Settings.TdlNamespace,
	}
}

// SessionCheck runs `tdl chat ls` as a connectivity/authorization diagnostic.
// It never logs the user out; the TUI behaves the same way.
func (f *Facade) SessionCheck(timeoutSeconds int) SessionCheckDTO {
	if f.login != nil && f.login.snapshot().State == "waiting" {
		return SessionCheckDTO{State: "busy", Message: "登录会话进行中，完成或取消后再检查", Code: -3}
	}
	if isTdlRunning() {
		return SessionCheckDTO{State: "busy", Message: "tdl.exe 正在运行（下载或登录中），请稍后再检查", Code: -3}
	}
	timeout := time.Duration(timeoutSeconds) * time.Second
	if timeout < 10*time.Second {
		timeout = 45 * time.Second
	}
	if timeout > 120*time.Second {
		timeout = 120 * time.Second
	}
	st := f.a.testTdlSession(timeout)
	return SessionCheckDTO{State: st.State, Message: st.Message, Detail: st.Detail, Code: st.Code}
}

// InstallTdl downloads the latest official tdl release when none is present.
// Existing installs are left untouched.
func (f *Facade) InstallTdl() (TdlInfoDTO, error) {
	if isTdlRunning() {
		return TdlInfoDTO{}, fmt.Errorf("检测到 tdl.exe 正在运行，请先结束它再安装")
	}
	if _, err := f.a.ensureTdlInstalled(nil); err != nil {
		return TdlInfoDTO{}, err
	}
	return f.TdlInfo(), nil
}

// KillTdl ends any stray tdl processes (mirrors the TUI's "结束 tdl" action).
func (f *Facade) KillTdl() (bool, error) {
	if !isTdlRunning() {
		return false, nil
	}
	if err := killAllTdl(); err != nil {
		return false, err
	}
	return true, nil
}

func (f *Facade) OpenTdlDir() error {
	return osMkdirAndOpen(tdlDataDir())
}

// LoginScreenText joins the mirrored terminal lines for clipboard/debug use.
func (f *Facade) LoginScreenText(id string) string {
	st := f.LoginState(id)
	if st.State == "missing" {
		return ""
	}
	return strings.Join(st.Screen, "\n")
}
