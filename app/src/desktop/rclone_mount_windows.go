//go:build windows

package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"telegramarchivekit/internal/platform"
)

type rcloneMount struct {
	cmd  *exec.Cmd
	done chan struct{}
	err  error
}

func (b *Bridge) StartRcloneMount(remote, subpath, drive string) (string, error) {
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
	if len(drive) != 1 || drive[0] < 'A' || drive[0] > 'Z' {
		return "", errors.New("盘符必须是单个字母，例如 Z")
	}
	return b.startRemoteMount(context.Background(), remote+":"+subpath, drive, false, nil)
}

func (b *Bridge) startRemoteMount(ctx context.Context, spec, drive string, sshLibrary bool, options []string) (string, error) {
	exe := findRclone()
	if exe == "" || !hasWinFsp() {
		return "", errors.New("请先安装 rclone 和 WinFsp 挂载组件")
	}
	b.mountMu.Lock()
	occupied, err := windows.GetLogicalDrives()
	if err != nil {
		b.mountMu.Unlock()
		return "", fmt.Errorf("无法读取 Windows 盘符：%w", err)
	}
	inUse := func(letter byte) bool {
		return occupied&(1<<(letter-'A')) != 0 || b.mounts[string(letter)] != nil
	}
	if drive == "" {
		for letter := byte('Z'); letter >= 'D'; letter-- {
			if !inUse(letter) {
				drive = string(letter)
				break
			}
		}
		if drive == "" {
			b.mountMu.Unlock()
			return "", errors.New("没有可用的 Windows 盘符")
		}
	} else if inUse(drive[0]) {
		b.mountMu.Unlock()
		return "", fmt.Errorf("盘符 %s 已被占用", drive)
	}
	root := drive + `:\`
	logPath := filepath.Join(b.facade.ConfigDir(), "rclone-mount-"+drive+".log")
	logFile, err := os.Create(logPath)
	if err != nil {
		b.mountMu.Unlock()
		return "", err
	}
	args := []string{"mount", spec, drive + ":",
		"--volname", "TAK Remote",
		"--vfs-cache-mode", "writes",
		"--dir-cache-time", "30s",
	}
	// WinFsp network mode rejects the handle-relative subdirectory opens used
	// by the web publisher. Disk mode supports those opens on SSH mounts.
	if !sshLibrary {
		args = append(args, "--network-mode")
	}
	cmd := exec.Command(exe, append(args, options...)...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		b.mountMu.Unlock()
		logFile.Close()
		return "", err
	}
	mount := &rcloneMount{cmd: cmd, done: make(chan struct{})}
	b.mounts[drive] = mount
	var unmark func()
	if sshLibrary {
		unmark = platform.MarkManagedRemoteDrive(drive)
	}
	b.mountMu.Unlock()
	go func() {
		mount.err = cmd.Wait()
		_ = logFile.Close()
		b.mountMu.Lock()
		if unmark != nil {
			unmark()
		}
		delete(b.mounts, drive)
		b.mountMu.Unlock()
		close(mount.done)
	}()

	ctx, cancel := context.WithTimeout(ctx, 22*time.Second)
	defer cancel()
	tick := time.NewTicker(300 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-mount.done:
			return "", fmt.Errorf("rclone 挂载失败：%s", tailLog(logPath, mount.err))
		case <-ctx.Done():
			_ = stopRemoteMount(mount)
			return "", fmt.Errorf("连接远程档案库超时或已取消：%w", ctx.Err())
		case <-tick.C:
			drives, err := windows.GetLogicalDrives()
			if err != nil || drives&(1<<(drive[0]-'A')) == 0 {
				continue
			}
			ready := make(chan error, 1)
			go func() {
				if sshLibrary {
					if info, err := os.Stat(filepath.Join(root, "library.json")); err != nil || info.IsDir() {
						ready <- errors.New("未能读取 library.json，请选择 NAS 上的档案库根目录")
						return
					}
				}
				ready <- platform.ProbeDirectoryWrite(root)
			}()
			select {
			case err := <-ready:
				if err != nil {
					_ = stopRemoteMount(mount)
					return "", err
				}
				return root, nil
			case <-mount.done:
				return "", fmt.Errorf("rclone 挂载失败：%s", tailLog(logPath, mount.err))
			case <-ctx.Done():
				_ = stopRemoteMount(mount)
				return "", fmt.Errorf("验证远程档案库超时或已取消：%w", ctx.Err())
			}
		}
	}
}

func (b *Bridge) StopRcloneMount(drive string) error {
	drive = strings.ToUpper(strings.TrimSuffix(strings.TrimSpace(drive), ":"))
	b.mountMu.Lock()
	mount := b.mounts[drive]
	b.mountMu.Unlock()
	return stopRemoteMount(mount)
}

func stopRemoteMount(mount *rcloneMount) error {
	if mount == nil {
		return nil
	}
	if mount.cmd.Process != nil {
		_ = mount.cmd.Process.Kill()
	}
	select {
	case <-mount.done:
	case <-time.After(4 * time.Second):
		return errors.New("远程挂载尚未退出")
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
		return mountExitMessage(cause)
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
		return mountExitMessage(cause)
	}
	return strings.Join(lines, " · ")
}

func mountExitMessage(cause error) string {
	if cause == nil {
		return "挂载进程已退出"
	}
	return cause.Error()
}
