package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var sshTargetPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]*(@[A-Za-z0-9_][A-Za-z0-9_.-]*)?$`)

func sshAliases() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	config, err := os.Open(filepath.Join(home, ".ssh", "config"))
	if err != nil {
		return nil
	}
	defer config.Close()
	var aliases []string
	seen := make(map[string]bool)
	scan := bufio.NewScanner(config)
	for scan.Scan() {
		line, _, _ := strings.Cut(scan.Text(), "#")
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.EqualFold(fields[0], "Host") {
			continue
		}
		for _, name := range fields[1:] {
			key := strings.ToLower(name)
			if !seen[key] && sshTargetPattern.MatchString(name) {
				seen[key] = true
				aliases = append(aliases, name)
			}
		}
	}
	return aliases
}

func (b *Bridge) StartSSHMount(ctx context.Context, target, directory string) (string, error) {
	endpoint, err := sshEndpoint(target, directory)
	if err != nil {
		return "", err
	}
	root, _, err := b.mountSSH(ctx, endpoint, b.expectedMountID(endpoint), true)
	return root, err
}

func sshEndpoint(target, directory string) (remoteEndpoint, error) {
	target = strings.TrimSpace(target)
	if !sshTargetPattern.MatchString(target) {
		return remoteEndpoint{}, errors.New("请输入 SSH 主机别名或 用户名@主机")
	}
	directory = strings.TrimSpace(directory)
	if strings.ContainsAny(directory, "\\\x00\r\n") {
		return remoteEndpoint{}, errors.New("请输入 服务器上使用 / 分隔的目录路径")
	}
	if directory != "" {
		directory = path.Clean(directory)
	}
	// An empty remote path addresses the SFTP login directory.
	if directory == "." {
		directory = ""
	}
	return remoteEndpoint{Kind: "ssh", Name: target, Path: directory}, nil
}

func (b *Bridge) mountSSH(ctx context.Context, endpoint remoteEndpoint, expectedID string, checkLibraryFile bool) (string, *rcloneMount, error) {
	if endpoint.SSHHost != "" {
		return "", nil, remoteError("authentication_required", "请重新输入 SSH 登录密码")
	}
	options, err := aliasMountOptions(endpoint.Name, endpoint.SSHUseRoot)
	if err != nil {
		return "", nil, err
	}
	var validate func(string) error
	if checkLibraryFile {
		validate = verifySSHLibrary
	}
	return b.startRemoteMount(ctx, endpoint, ":sftp:", expectedID, false, options, nil, validate)
}

func aliasMountOptions(target string, useSudo bool) ([]string, error) {
	ssh, err := exec.LookPath("ssh.exe")
	if err != nil {
		return nil, remoteError("missing_tools", "未检测到 Windows OpenSSH 客户端")
	}
	// rclone parses this as a space-separated argument list and starts ssh
	// directly. The host never supplies options, and OpenSSH verifies the key.
	sshCommand := `"` + ssh + `" -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes -o ForwardAgent=no -o ConnectTimeout=8 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 ` + target
	options := []string{
		"--config", "NUL", "--log-level", "ERROR", "--sftp-ssh", sshCommand,
		"--sftp-disable-hashcheck", "--sftp-shell-type", "none", "--retries", "1", "--timeout", "12s",
	}
	if useSudo {
		options = append(options, "--sftp-server-command", sudoSFTPServer, "--transfers", "1")
	}
	return options, nil
}

func installMountTools(ctx context.Context) error {
	var missing []string
	if !hasWinFsp() {
		missing = append(missing, "WinFsp.WinFsp")
	}
	if findRclone() == "" {
		missing = append(missing, "Rclone.Rclone")
	}
	for _, pkg := range missing {
		install, cancel := context.WithTimeout(ctx, 4*time.Minute)
		err := hiddenCommandContext(install, "winget", "install", "--id", pkg, "--exact", "--source", "winget", "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity").Run()
		cancel()
		if err != nil && !(pkg == "Rclone.Rclone" && findRclone() != "" || pkg == "WinFsp.WinFsp" && hasWinFsp()) {
			return fmt.Errorf("安装 %s 失败：%w", pkg, err)
		}
	}
	if !hasWinFsp() || findRclone() == "" {
		return errors.New("未检测到安装后的 rclone 或 WinFsp，请检查 WinGet 安装结果后重新检测")
	}
	return nil
}
