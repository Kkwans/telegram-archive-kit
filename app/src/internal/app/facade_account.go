package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// AccountInfoDTO describes the local tdl session without claiming that
// Telegram still accepts it (that requires SessionCheck).
type AccountInfoDTO struct {
	Namespace       string `json:"namespace"`
	TdlExe          string `json:"tdlExe"`
	TdlVersion      string `json:"tdlVersion"`
	SessionDir      string `json:"sessionDir"`
	SessionFile     string `json:"sessionFile"`
	SessionSize     int64  `json:"sessionSize"`
	SessionModified int64  `json:"sessionModified"`
	HasSessionFile  bool   `json:"hasSessionFile"`
	Running         bool   `json:"running"`
}

func (a *App) tdlNamespace() string {
	ns := strings.TrimSpace(a.Settings.TdlNamespace)
	if ns == "" {
		ns = "default"
	}
	return ns
}

func (a *App) tdlSessionFile() string {
	ns := a.tdlNamespace()
	if ns != filepath.Base(ns) || strings.ContainsAny(ns, `/\:`) {
		ns = "default"
	}
	return filepath.Join(tdlDataDir(), "data", ns)
}

func (a *App) hasSessionFile() bool {
	st, err := os.Stat(a.tdlSessionFile())
	return err == nil && !st.IsDir()
}

func (f *Facade) AccountInfo() AccountInfoDTO {
	file := f.a.tdlSessionFile()
	info := AccountInfoDTO{
		Namespace:   f.a.tdlNamespace(),
		TdlExe:      f.a.resolveTdl(),
		TdlVersion:  f.a.tdlVersion(),
		SessionDir:  tdlDataDir(),
		SessionFile: file,
		Running:     isTdlRunning(),
	}
	if st, err := os.Stat(file); err == nil && !st.IsDir() {
		info.HasSessionFile = true
		info.SessionSize = st.Size()
		info.SessionModified = st.ModTime().UnixMilli()
	}
	return info
}

// LogoutTdl backs up and removes the current namespace's tdl session file.
// tdl 0.20 has no logout command, so this is the only reversible way to
// forget the account without touching other namespaces.
func (f *Facade) LogoutTdl() error {
	if isTdlRunning() {
		if err := killAllTdl(); err != nil {
			return fmt.Errorf("请先结束 tdl 进程：%w", err)
		}
	}
	src := f.a.tdlSessionFile()
	if st, err := os.Stat(src); err != nil || st.IsDir() {
		return fmt.Errorf("当前 namespace 没有可退出的会话文件")
	}
	backupDir := filepath.Join(tdlDataDir(), "backups")
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		return err
	}
	dst := filepath.Join(backupDir, f.a.tdlNamespace()+"-"+time.Now().Format("20060102-150405"))
	if err := copyFile(src, dst); err != nil {
		return fmt.Errorf("备份会话失败，已取消退出：%w", err)
	}
	if err := os.Remove(src); err != nil {
		return fmt.Errorf("删除会话失败：%w", err)
	}
	return nil
}
