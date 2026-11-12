//go:build windows

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"

	"golang.org/x/sys/windows"

	takapp "telegramarchivekit/internal/app"
	"telegramarchivekit/internal/platform"
)

type rcloneMount struct {
	cmd       *exec.Cmd
	done      chan struct{}
	endpoint  remoteEndpoint
	markerDir string
	options   []string
	ready     bool // protected by Bridge.mountMu
	report    mountReport
}

func (b *Bridge) StartRcloneMount(ctx context.Context, remote, subpath, drive string) (string, error) {
	endpoint, err := rcloneEndpoint(remote, subpath, drive)
	if err != nil {
		return "", err
	}
	root, _, err := b.mountRclone(ctx, endpoint, b.expectedMountID(endpoint), false)
	return root, err
}

func rcloneEndpoint(remote, subpath, drive string) (remoteEndpoint, error) {
	remote = strings.TrimSuffix(strings.TrimSpace(remote), ":")
	singleDriveLetter := len(remote) == 1 && strings.Contains("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", remote)
	if remote == "" || singleDriveLetter || strings.HasPrefix(remote, "-") || strings.HasSuffix(remote, " ") {
		return remoteEndpoint{}, errors.New("请选择有效的 rclone remote")
	}
	for _, c := range remote {
		if !unicode.IsLetter(c) && !unicode.IsNumber(c) && !strings.ContainsRune("_.-+@ ", c) {
			return remoteEndpoint{}, errors.New("请选择有效的 rclone remote")
		}
	}
	subpath = strings.Trim(strings.ReplaceAll(strings.TrimSpace(subpath), "\\", "/"), "/")
	for _, part := range strings.Split(subpath, "/") {
		if part == ".." || strings.ContainsAny(part, ":\x00\r\n") {
			return remoteEndpoint{}, errors.New("remote 子路径不合法")
		}
	}
	if subpath != "" {
		subpath = path.Clean(subpath)
		if subpath == "." {
			subpath = ""
		}
	}
	drive = normalizeMountDrive(drive)
	if len(drive) != 1 || drive[0] < 'A' || drive[0] > 'Z' {
		return remoteEndpoint{}, errors.New("盘符必须是单个字母，例如 Z")
	}
	return remoteEndpoint{Kind: "rclone", Name: remote, Path: subpath, Drive: drive}, nil
}

func normalizeMountDrive(drive string) string {
	return strings.ToUpper(strings.TrimSuffix(strings.TrimSpace(drive), ":"))
}

func (b *Bridge) mountRclone(ctx context.Context, endpoint remoteEndpoint, expectedID string, useAnyDrive bool) (string, *rcloneMount, error) {
	return b.startRemoteMount(ctx, endpoint, endpoint.Name+":", expectedID, useAnyDrive, nil, nil)
}

func (b *Bridge) expectedMountID(endpoint remoteEndpoint) string {
	if b.remoteConnections != nil {
		return b.remoteConnections.expectedMountID(endpoint)
	}
	return ""
}

// Pending VFS writes can be uploaded as soon as a writable mount starts. For a
// saved remote, validate its marker directly before allowing that process to
// start, then let the caller validate the mounted view before using it.
func (b *Bridge) startRemoteMount(ctx context.Context, endpoint remoteEndpoint, prefix, expectedID string, useAnyDrive bool, options []string, validate func(string) error) (string, *rcloneMount, error) {
	if service := b.remoteConnections; service != nil {
		service.mu.Lock()
		if service.closed {
			service.mu.Unlock()
			return "", nil, context.Canceled
		}
		service.wg.Add(1)
		service.mu.Unlock()
		defer service.wg.Done()
		var cancel context.CancelFunc
		ctx, cancel = context.WithCancel(ctx)
		defer cancel()
		stop := context.AfterFunc(service.ctx, cancel)
		defer stop()
	}
	exe := findRclone()
	if exe == "" || !hasWinFsp() {
		return "", nil, remoteError("missing_tools", "请先安装 rclone 和 WinFsp 挂载组件")
	}
	markerDir := prefix + path.Join(endpoint.Path, ".runtime")
	if expectedID != "" {
		if err := verifyRcloneMarker(ctx, exe, markerDir, expectedID, options); err != nil {
			return "", nil, err
		}
	}
	b.mountMu.Lock()
	if err := ctx.Err(); err != nil {
		b.mountMu.Unlock()
		return "", nil, err
	}
	for letter, mount := range b.mounts {
		if !mount.endpoint.same(endpoint) {
			continue
		}
		if mount.ready && (useAnyDrive || endpoint.Drive == "" || letter == endpoint.Drive) {
			b.mountMu.Unlock()
			return letter + `:\`, nil, nil
		}
		b.mountMu.Unlock()
		return "", nil, remoteError("busy", "该远程位置正在挂载或已挂载到其他盘符")
	}
	occupied, err := windows.GetLogicalDrives()
	if err != nil {
		b.mountMu.Unlock()
		return "", nil, fmt.Errorf("无法读取 Windows 盘符：%w", err)
	}
	inUse := func(letter byte) bool {
		return occupied&(1<<(letter-'A')) != 0 || b.mounts[string(letter)] != nil
	}
	drive := endpoint.Drive
	if drive == "" || (useAnyDrive && inUse(drive[0])) {
		drive = ""
		for letter := byte('Z'); letter >= 'D'; letter-- {
			if !inUse(letter) {
				drive = string(letter)
				break
			}
		}
		if drive == "" {
			b.mountMu.Unlock()
			return "", nil, remoteError("busy", "没有可用的 Windows 盘符，请释放一个盘符后重试")
		}
	} else if inUse(drive[0]) {
		b.mountMu.Unlock()
		return "", nil, fmt.Errorf("盘符 %s 已被占用", drive)
	}
	root := drive + `:\`
	// The write-back interval lets close-and-rename writes reach their final
	// name before the upload starts. Immediate write-back can upload the temp
	// name and leave the renamed file visible only in the mounted view.
	args := []string{"mount", prefix + endpoint.Path, drive + ":",
		"--volname", "TAK Remote",
		"--vfs-cache-mode", "writes",
		"--vfs-write-back", "5s",
		"--dir-cache-time", "30s",
		"--network-mode=false",
		"--ask-password=false",
	}
	// WinFsp disk mode supports the handle-relative opens used to verify library
	// identity and contain publication media paths.
	cmd := exec.Command(exe, append(args, options...)...)
	mount := &rcloneMount{cmd: cmd, done: make(chan struct{}), endpoint: endpoint, markerDir: markerDir, options: options}
	cmd.Stdout, cmd.Stderr = &mount.report, &mount.report
	cmd.WaitDelay = 2 * time.Second
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		b.mountMu.Unlock()
		return "", nil, remoteError("error", "无法启动 rclone，请检查挂载组件后重试")
	}
	if b.mounts == nil {
		b.mounts = make(map[string]*rcloneMount)
	}
	b.mounts[drive] = mount
	unmark := platform.MarkManagedRemoteDrive(drive)
	b.mountMu.Unlock()
	go func() {
		_ = cmd.Wait()
		b.mountMu.Lock()
		unmark()
		delete(b.mounts, drive)
		close(mount.done)
		b.mountMu.Unlock()
		if b.remoteConnections != nil {
			b.remoteConnections.notify()
		}
	}()

	ctx, cancel := context.WithTimeout(ctx, 22*time.Second)
	defer cancel()
	tick := time.NewTicker(300 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-mount.done:
			return "", nil, mount.report.failure(false)
		case <-ctx.Done():
			_ = stopRemoteMount(mount)
			return "", nil, mount.report.failure(true)
		case <-tick.C:
			drives, err := windows.GetLogicalDrives()
			if err != nil || drives&(1<<(drive[0]-'A')) == 0 {
				continue
			}
			if validate != nil {
				ready := make(chan error, 1)
				go func() { ready <- validate(root) }()
				select {
				case err := <-ready:
					if err != nil {
						_ = stopRemoteMount(mount)
						return "", nil, err
					}
				case <-mount.done:
					return "", nil, mount.report.failure(false)
				case <-ctx.Done():
					_ = stopRemoteMount(mount)
					return "", nil, mount.report.failure(true)
				}
			}
			b.mountMu.Lock()
			stillOwned := b.mounts[drive] == mount
			mount.ready = stillOwned
			b.mountMu.Unlock()
			if !stillOwned {
				return "", nil, mount.report.failure(false)
			}
			return root, mount, nil
		}
	}
}

func verifyRcloneMarker(ctx context.Context, exe, markerDir, expectedID string, options []string) error {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	args := []string{"cat", markerDir, "--include", "/library-id", "--max-depth", "1", "--count", "33",
		"--ask-password=false", "--retries", "1", "--contimeout", "8s"}
	cmd := hiddenCommandContext(ctx, exe, append(args, options...)...)
	var marker bytes.Buffer
	var report mountReport
	cmd.Stdout, cmd.Stderr = &marker, &report
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Run(); err != nil {
		return report.failure(ctx.Err() != nil)
	}
	if marker.String() != expectedID {
		return takapp.ErrLibraryIdentity
	}
	return nil
}

// Mount writes are buffered locally. A freshly created marker must reach the
// backend before the mount recipe is saved, otherwise a rapid restart would
// fail the direct read-only verification.
func (m *rcloneMount) confirmMarker(ctx context.Context, expectedID string) error {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	waitingForUpload := false
	for {
		err := verifyRcloneMarker(ctx, m.cmd.Path, m.markerDir, expectedID, m.options)
		if waitingForUpload && errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return remoteError("error", "远程服务器尚未确认档案库标识，请检查写入权限后再次保存")
		}
		if err == nil || classifyRemoteError(err).status != "identity_mismatch" {
			return err
		}
		waitingForUpload = true
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.Canceled) {
				return ctx.Err()
			}
			return remoteError("error", "远程服务器尚未确认档案库标识，请检查写入权限后再次保存")
		case <-m.done:
			return remoteError("offline", "挂载已断开，请重新挂载后再保存")
		case <-tick.C:
		}
	}
}

func (b *Bridge) StopRcloneMount(drive string) error {
	drive = normalizeMountDrive(drive)
	b.mountMu.Lock()
	mount := b.mounts[drive]
	b.mountMu.Unlock()
	return stopRemoteMount(mount)
}

func (b *Bridge) remoteMountAt(root string) *rcloneMount {
	if len(root) != 3 || root[1:] != `:\` {
		return nil
	}
	b.mountMu.Lock()
	defer b.mountMu.Unlock()
	mount := b.mounts[strings.ToUpper(root[:1])]
	if mount != nil && mount.ready {
		return mount
	}
	return nil
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

// Mount errors can contain backend credentials. Classify the diagnostic text
// immediately and keep only a status code.
type mountReport struct {
	mu     sync.Mutex
	status string
}

func (r *mountReport) Write(data []byte) (int, error) {
	msg := strings.ToLower(string(data))
	status := ""
	switch {
	case strings.Contains(msg, "host key verification failed"), strings.Contains(msg, "remote host identification has changed"), strings.Contains(msg, "knownhosts"):
		status = "host_key"
	case strings.Contains(msg, "permission denied"), strings.Contains(msg, "authentication"), strings.Contains(msg, "invalid_grant"), strings.Contains(msg, "401 unauthorized"), strings.Contains(msg, "config password"), strings.Contains(msg, "decrypt config"):
		status = "authentication_required"
	case strings.Contains(msg, "didn't find section in config file"), strings.Contains(msg, "didn't find section in config"):
		status = "configuration_required"
	case strings.Contains(msg, "object not found"), strings.Contains(msg, "directory not found"):
		status = "identity_mismatch"
	case strings.Contains(msg, "timeout"), strings.Contains(msg, "timed out"), strings.Contains(msg, "connection refused"), strings.Contains(msg, "no such host"), strings.Contains(msg, "network is unreachable"), strings.Contains(msg, "connection reset"):
		status = "offline"
	}
	if status != "" {
		r.mu.Lock()
		if r.status == "" || r.status == "offline" || status == "host_key" {
			r.status = status
		}
		r.mu.Unlock()
	}
	return len(data), nil
}

func (r *mountReport) failure(timedOut bool) *remoteFailure {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch r.status {
	case "host_key":
		return remoteError("authentication_required", "SSH 主机密钥未获信任或已变更，请核对后在 Windows OpenSSH 中更新信任")
	case "authentication_required":
		return remoteError(r.status, "远程认证失败，请检查 Windows OpenSSH 或现有 rclone 配置")
	case "configuration_required":
		return remoteError("error", "现有 rclone 配置中找不到该远程位置，请检查 rclone config")
	case "identity_mismatch":
		return remoteError(r.status, "远程目录缺少保存时的档案库标识，请核对路径与远程配置")
	case "offline":
		return remoteError(r.status, "远程主机暂时不可访问，请检查网络连接")
	}
	if timedOut {
		return remoteError("offline", "远程挂载超时，请检查网络连接后重试")
	}
	return remoteError("error", "远程挂载进程已退出，请检查远程配置与挂载组件")
}
