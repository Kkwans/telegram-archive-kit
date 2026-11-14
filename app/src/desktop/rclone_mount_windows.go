//go:build windows

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unsafe"

	"golang.org/x/sys/windows"

	takapp "telegramarchivekit/internal/app"
	"telegramarchivekit/internal/platform"
)

type rcloneMount struct {
	cmd           *exec.Cmd
	processHandle windows.Handle
	libraryRoot   string
	done          chan struct{}
	endpoint      remoteEndpoint
	markerDir     string
	options       []string
	env           []string
	ready         bool // protected by Bridge.mountMu
	report        mountReport
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

func (b *Bridge) availableMountDrives() ([]string, error) {
	b.mountMu.Lock()
	defer b.mountMu.Unlock()
	occupied, err := windows.GetLogicalDrives()
	if err != nil {
		return nil, err
	}
	drives := make([]string, 0, 23)
	for letter := byte('D'); letter <= 'Z'; letter++ {
		if occupied&(1<<(letter-'A')) == 0 && b.mounts[string(letter)] == nil {
			drives = append(drives, string(letter))
		}
	}
	return drives, nil
}

func mountVolumeName(endpoint remoteEndpoint) string {
	label := strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`\/:*?"<>|`, r) {
			return ' '
		}
		return r
	}, endpoint.VolumeName))
	if label == "" {
		return "TAK Remote"
	}
	return label
}

func (b *Bridge) mountRclone(ctx context.Context, endpoint remoteEndpoint, expectedID string, useAnyDrive bool) (string, *rcloneMount, error) {
	return b.startRemoteMount(ctx, endpoint, endpoint.Name+":", expectedID, useAnyDrive, nil, nil, nil)
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
func (b *Bridge) startRemoteMount(ctx context.Context, endpoint remoteEndpoint, prefix, expectedID string, useAnyDrive bool, options, env []string, validate func(string) error) (string, *rcloneMount, error) {
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
		if err := verifyRcloneMarker(ctx, exe, markerDir, expectedID, options, env); err != nil {
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
			return mount.libraryRoot, nil, nil
		}
		if mount.ready && endpoint.Kind == "ssh" && endpoint.Drive != "" && letter != endpoint.Drive {
			// A saved SSH connection can move to a free letter. Keep the
			// original mount available until the library switch succeeds.
			continue
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
	mountPath := endpoint.Path
	dirCacheTime := "30s"
	if endpoint.Kind == "ssh" && strings.HasPrefix(endpoint.Path, "/") {
		// The drive exposes the SFTP root while TAK opens only the chosen library.
		root = filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(endpoint.Path, "/")))
		mountPath = "/"
		dirCacheTime = "1m"
	}
	// The write-back interval lets close-and-rename writes reach their final
	// name before the upload starts. Immediate write-back can upload the temp
	// name and leave the renamed file visible only in the mounted view.
	args := []string{"mount", prefix + mountPath, drive + ":",
		"--volname", mountVolumeName(endpoint),
		"--vfs-cache-mode", "writes",
		"--vfs-write-back", "5s",
		"--dir-cache-time", dirCacheTime,
		"--network-mode=false",
		"--ask-password=false",
	}
	if endpoint.SSHUseRoot || endpoint.SSHUser == "root" {
		args = append(args, "--file-perms", "0600", "--dir-perms", "0700")
	}
	if endpoint.Kind == "ssh" && endpoint.SSHUseRoot {
		// Keep elevated VFS writes separate from the ordinary mount's cache.
		cacheKey := sha256.Sum256([]byte(endpoint.Name + "\x00" + endpoint.SSHKey))
		args = append(args, "--cache-dir", filepath.Join(b.facade.ConfigDir(), "ssh-sudo-cache", fmt.Sprintf("%x", cacheKey), drive))
	}
	// WinFsp disk mode supports the handle-relative opens used to verify library
	// identity and contain publication media paths.
	cmd := exec.Command(exe, append(args, options...)...)
	cmd.Env = env
	mount := &rcloneMount{cmd: cmd, libraryRoot: root, done: make(chan struct{}), endpoint: endpoint, markerDir: markerDir, options: options, env: env}
	cmd.Stdout, cmd.Stderr = &mount.report, &mount.report
	cmd.WaitDelay = 2 * time.Second
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	var job windows.Handle
	if endpoint.Kind == "ssh" {
		cmd.Stdout, cmd.Stderr = nil, nil
		cmd.SysProcAttr.CreationFlags = windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_NO_WINDOW
		err = cmd.Start()
	} else {
		job, err = startManagedMountProcess(cmd)
	}
	if err != nil {
		b.mountMu.Unlock()
		return "", nil, remoteError("error", "无法启动受管理的 rclone 挂载，请检查挂载组件后重试")
	}
	if b.mounts == nil {
		b.mounts = make(map[string]*rcloneMount)
	}
	b.mounts[drive] = mount
	unmark := platform.MarkManagedRemoteDrive(drive)
	b.mountMu.Unlock()
	go func() {
		_ = cmd.Wait()
		if job != 0 {
			_ = windows.CloseHandle(job)
		}
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
			var persistErr error
			if stillOwned && endpoint.Kind == "ssh" {
				persistErr = b.rememberSSHMount(drive, mount)
			}
			mount.ready = stillOwned && persistErr == nil
			b.mountMu.Unlock()
			if persistErr != nil {
				_ = stopRemoteMount(mount)
				return "", nil, fmt.Errorf("无法登记 SSH 挂载：%w", persistErr)
			}
			if !stillOwned {
				return "", nil, mount.report.failure(false)
			}
			return root, mount, nil
		}
	}
}

// A private Windows job also releases the drive when the client crashes or
// Windows terminates it before the ordinary shutdown code runs.
func startManagedMountProcess(cmd *exec.Cmd) (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		_ = windows.CloseHandle(job)
		return 0, err
	}
	if err = cmd.Start(); err != nil {
		_ = windows.CloseHandle(job)
		return 0, err
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err == nil {
		err = windows.AssignProcessToJobObject(job, process)
		_ = windows.CloseHandle(process)
	}
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		_ = windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func verifyRcloneMarker(ctx context.Context, exe, markerDir, expectedID string, options, env []string) error {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	args := []string{"cat", markerDir, "--include", "/library-id", "--max-depth", "1", "--count", "33",
		"--ask-password=false", "--retries", "1", "--contimeout", "8s"}
	cmd := hiddenCommandContext(ctx, exe, append(args, options...)...)
	cmd.Env = env
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
		err := verifyRcloneMarker(ctx, m.cmd.Path, m.markerDir, expectedID, m.options, m.env)
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
	if len(root) < 3 || root[1:3] != `:\` {
		return nil
	}
	b.mountMu.Lock()
	defer b.mountMu.Unlock()
	mount := b.mounts[strings.ToUpper(root[:1])]
	if mount != nil && mount.ready && sameRemoteRoot(root, mount.libraryRoot) {
		return mount
	}
	return nil
}

func stopRemoteMount(mount *rcloneMount) error {
	if mount == nil {
		return nil
	}
	if mount.cmd != nil && mount.cmd.Process != nil {
		_ = mount.cmd.Process.Kill()
	} else if mount.processHandle != 0 {
		_ = windows.TerminateProcess(mount.processHandle, 0)
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
	for drive, mount := range b.mounts {
		if mount.endpoint.Kind != "ssh" || !mount.ready {
			drives = append(drives, drive)
		}
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
	case strings.Contains(msg, "a password is required"), strings.Contains(msg, "not allowed to execute"), strings.Contains(msg, "must have a tty"), strings.Contains(msg, "not in the sudoers"):
		status = "sudo_required"
	case strings.Contains(msg, "tak_sftp_server_missing"):
		status = "sftp_server_missing"
	case strings.Contains(msg, "host key verification failed"), strings.Contains(msg, "remote host identification has changed"), strings.Contains(msg, "knownhosts"), strings.Contains(msg, "host key mismatch"), strings.Contains(msg, "host key did not match"):
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
	case "sudo_required":
		return remoteError("authentication_required", "服务器未允许当前 SSH 账号免交互启动 SFTP。请检查 sudo 权限，或关闭 sudo 模式")
	case "sftp_server_missing":
		return remoteError("error", "服务器未在常见安装路径提供独立的 OpenSSH SFTP 服务程序")
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
