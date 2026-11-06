//go:build windows

package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode"
)

type rcloneMount struct {
	cmd     *exec.Cmd
	drive   string
	logPath string
	done    chan error
}

func (b *Bridge) StartRcloneMount(remote, subpath, drive string) (string, error) {
	exe := findRclone()
	if exe == "" {
		return "", errors.New("未检测到 rclone，请先安装并配置 remote")
	}
	if !fileExists(filepath.Join(programFilesDir(), "WinFsp")) && !fileExists(filepath.Join(programFilesX86Dir(), "WinFsp")) {
		return "", errors.New("未检测到 WinFsp，请先安装 rclone 挂载所需的文件系统驱动")
	}
	remote = strings.TrimSuffix(strings.TrimSpace(remote), ":")
	if remote == "" || strings.ContainsAny(remote, " \t/:") {
		return "", errors.New("请选择有效的 rclone remote")
	}
	subpath = strings.Trim(strings.TrimSpace(subpath), "/\\")
	for _, part := range strings.Split(strings.ReplaceAll(subpath, "\\", "/"), "/") {
		if part == ".." || strings.Contains(part, ":") {
			return "", errors.New("remote 子路径不合法")
		}
	}
	drive = strings.ToUpper(strings.TrimSuffix(strings.TrimSpace(drive), ":"))
	if len([]rune(drive)) != 1 || !unicode.IsLetter([]rune(drive)[0]) {
		return "", errors.New("盘符必须是单个字母，例如 Z")
	}
	root := drive + `:\`
	if _, err := os.Stat(root); err == nil {
		return "", fmt.Errorf("盘符 %s 已被占用", drive)
	}

	spec := remote + ":"
	if subpath != "" {
		spec += "/" + subpath
	}
	logPath := filepath.Join(b.facade.ConfigDir(), "rclone-mount-"+drive+".log")
	logFile, err := os.Create(logPath)
	if err != nil {
		return "", err
	}
	cmd := exec.Command(exe, "mount", spec, drive+":",
		"--volname", "TAK Remote",
		"--vfs-cache-mode", "writes",
		"--dir-cache-time", "30s",
		"--network-mode",
	)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		logFile.Close()
		return "", err
	}
	mount := &rcloneMount{cmd: cmd, drive: drive, logPath: logPath, done: make(chan error, 1)}
	go func() {
		err := cmd.Wait()
		_ = logFile.Close()
		mount.done <- err
	}()
	b.mountMu.Lock()
	b.mounts[drive] = mount
	b.mountMu.Unlock()

	deadline := time.Now().Add(18 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-mount.done:
			b.mountMu.Lock()
			delete(b.mounts, drive)
			b.mountMu.Unlock()
			return "", fmt.Errorf("rclone 挂载失败：%s", tailLog(logPath, err))
		default:
		}
		if st, err := os.Stat(root); err == nil && st.IsDir() {
			test := filepath.Join(root, ".tak-write-test")
			if err := os.WriteFile(test, []byte("ok"), 0600); err == nil {
				_ = os.Remove(test)
				return root, nil
			}
		}
		time.Sleep(350 * time.Millisecond)
	}
	b.StopRcloneMount(drive)
	return "", fmt.Errorf("rclone 挂载超时，请查看日志：%s", logPath)
}

func (b *Bridge) StopRcloneMount(drive string) error {
	drive = strings.ToUpper(strings.TrimSuffix(strings.TrimSpace(drive), ":"))
	b.mountMu.Lock()
	mount := b.mounts[drive]
	delete(b.mounts, drive)
	b.mountMu.Unlock()
	if mount == nil {
		return nil
	}
	if mount.cmd.Process != nil {
		_ = mount.cmd.Process.Kill()
	}
	select {
	case <-mount.done:
	case <-time.After(4 * time.Second):
	}
	return nil
}

func (b *Bridge) stopAllRcloneMounts() {
	b.mountMu.Lock()
	drives := make([]string, 0, len(b.mounts))
	for drive := range b.mounts {
		drives = append(drives, drive)
	}
	b.mountMu.Unlock()
	for _, drive := range drives {
		_ = b.StopRcloneMount(drive)
	}
}

func tailLog(path string, cause error) string {
	f, err := os.Open(path)
	if err != nil {
		return cause.Error()
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line != "" {
			lines = append(lines, line)
			if len(lines) > 6 {
				lines = lines[1:]
			}
		}
	}
	if len(lines) == 0 {
		return cause.Error()
	}
	return strings.Join(lines, " · ")
}
