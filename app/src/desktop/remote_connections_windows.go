//go:build windows

package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unsafe"

	"golang.org/x/sys/windows"

	takapp "telegramarchivekit/internal/app"
	"telegramarchivekit/internal/platform"
)

const (
	remoteHealthInterval = 15 * time.Second
	remoteProbeTimeout   = 5 * time.Second
)

type remoteEndpoint struct {
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	Path       string `json:"path"`
	Drive      string `json:"drive,omitempty"`
	VolumeName string `json:"-"`
	SSHHost    string `json:"sshHost,omitempty"`
	SSHUser    string `json:"sshUser,omitempty"`
	SSHPort    int    `json:"sshPort,omitempty"`
	SSHKey     string `json:"sshKey,omitempty"`
	SSHUseRoot bool   `json:"sshUseSudo,omitempty"`
}

func (e remoteEndpoint) same(other remoteEndpoint) bool {
	if e.Kind != other.Kind || e.Name != other.Name || e.SSHHost != other.SSHHost || e.SSHUser != other.SSHUser || e.SSHPort != other.SSHPort || e.SSHKey != other.SSHKey || e.SSHUseRoot != other.SSHUseRoot {
		return false
	}
	if e.Kind == "unc" {
		return sameRemoteRoot(e.Path, other.Path)
	}
	return e.Path == other.Path
}

type savedRemoteConnection struct {
	remoteEndpoint
	ID               string   `json:"id"`
	Label            string   `json:"label"`
	Root             string   `json:"root"`
	AutoReconnect    bool     `json:"autoReconnect"`
	HasSavedPassword bool     `json:"hasSavedPassword,omitempty"`
	PreviousRoots    []string `json:"previousRoots,omitempty"`
}

func (c savedRemoteConnection) matchesRoot(root string) bool {
	if sameRemoteRoot(c.Root, root) || c.Kind == "unc" && sameRemoteRoot(c.Path, root) {
		return true
	}
	for _, previous := range c.PreviousRoots {
		if sameRemoteRoot(previous, root) {
			return true
		}
	}
	return false
}

func (c *savedRemoteConnection) updateRoot(root string) {
	if c.Root != "" && !sameRemoteRoot(c.Root, root) {
		found := false
		for _, previous := range c.PreviousRoots {
			if sameRemoteRoot(previous, c.Root) {
				found = true
				break
			}
		}
		if !found {
			c.PreviousRoots = append(append([]string(nil), c.PreviousRoots...), c.Root)
		}
	}
	c.Root = root
}

type remoteConnectionFile struct {
	Version     int                     `json:"version"`
	Connections []savedRemoteConnection `json:"connections"`
}

type remoteConnectionDTO struct {
	remoteEndpoint
	ID               string `json:"id"`
	Label            string `json:"label"`
	Root             string `json:"root"`
	AutoReconnect    bool   `json:"autoReconnect"`
	HasSavedPassword bool   `json:"hasSavedPassword,omitempty"`
	Mounted          bool   `json:"mounted,omitempty"`
	Active           bool   `json:"active"`
	Status           string `json:"status"`
	Message          string `json:"message,omitempty"`
	NextRetryAt      int64  `json:"nextRetryAt,omitempty"`
}

type remoteConnectionList struct {
	Connections []remoteConnectionDTO `json:"connections"`
}

type remoteFailure struct {
	status  string
	message string
}

func (e *remoteFailure) Error() string { return e.message }

func remoteError(status, message string) *remoteFailure {
	return &remoteFailure{status: status, message: message}
}

func classifyRemoteError(err error) *remoteFailure {
	var failure *remoteFailure
	switch {
	case errors.As(err, &failure):
		return failure
	case errors.Is(err, takapp.ErrLibraryIdentity):
		return remoteError("identity_mismatch", "远程目录与保存的档案库身份不符，请核对路径与远程配置")
	case errors.Is(err, takapp.ErrOperationRunning):
		return remoteError("busy", "档案任务正在运行，任务结束后可重试")
	case errors.Is(err, takapp.ErrLibraryReadOnly):
		return remoteError("error", "远程档案库不可写，请检查共享与目录写入权限")
	case errors.Is(err, windows.ERROR_LOGON_FAILURE), errors.Is(err, windows.ERROR_INVALID_PASSWORD),
		errors.Is(err, windows.ERROR_SESSION_CREDENTIAL_CONFLICT), errors.Is(err, windows.ERROR_NETWORK_ACCESS_DENIED),
		errors.Is(err, windows.ERROR_PASSWORD_EXPIRED), errors.Is(err, windows.ERROR_ACCOUNT_DISABLED),
		errors.Is(err, windows.ERROR_ACCOUNT_LOCKED_OUT), errors.Is(err, os.ErrPermission):
		return remoteError("authentication_required", "没有访问远程目录的权限，请检查系统凭据与共享权限")
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), errors.Is(err, os.ErrNotExist),
		errors.Is(err, windows.ERROR_BAD_NETPATH), errors.Is(err, windows.ERROR_BAD_NET_NAME),
		errors.Is(err, windows.ERROR_NETNAME_DELETED), errors.Is(err, windows.ERROR_NETWORK_UNREACHABLE),
		errors.Is(err, windows.ERROR_NO_NETWORK), errors.Is(err, windows.ERROR_CONNECTION_UNAVAIL),
		errors.Is(err, windows.ERROR_DEVICE_NOT_CONNECTED), errors.Is(err, windows.ERROR_NOT_READY),
		errors.Is(err, windows.ERROR_UNEXP_NET_ERR), errors.Is(err, windows.ERROR_NETWORK_BUSY),
		errors.Is(err, windows.ERROR_SEM_TIMEOUT):
		return remoteError("offline", "远程目录暂时不可访问，请检查网络和远程设备")
	}
	// The application and publication layers do not yet expose typed lock
	// errors. Report those actionable messages without forwarding path errors.
	msg := err.Error()
	if strings.HasPrefix(msg, "请先停止网页部署") || strings.HasPrefix(msg, "档案库正由另一个进程使用") {
		return remoteError("busy", msg)
	}
	return remoteError("error", "无法打开远程档案库，请检查路径与读写权限后重试")
}

type remoteSelection struct {
	root       string
	id         string
	ready      bool
	mount      *rcloneMount
	generation uint64
}

type remoteProgress struct {
	status   string
	message  string
	failures int
	next     time.Time
}

type remoteFlight struct {
	id        string
	automatic bool
	cancel    context.CancelFunc
	done      chan struct{}
	err       error // published by closing done
}

type remoteProbe struct {
	done chan struct{}
	id   string
	err  error
}

type remoteConnections struct {
	b      *Bridge
	file   string
	ctx    context.Context
	cancel context.CancelFunc
	wake   chan struct{}
	wg     sync.WaitGroup

	// Library changes are serialized separately from cached status and network
	// probes so polling never waits for a Windows filesystem operation.
	activation sync.Mutex
	mu         sync.Mutex
	closed     bool
	loadErr    error
	records    []savedRemoteConnection
	current    remoteSelection
	progress   map[string]remoteProgress
	flight     *remoteFlight

	probeMu sync.Mutex
	probes  map[string]*remoteProbe
}

func newRemoteConnections(b *Bridge) *remoteConnections {
	ctx, cancel := context.WithCancel(context.Background())
	s := &remoteConnections{
		b: b, file: filepath.Join(b.facade.ConfigDir(), "remote-connections.json"),
		ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1),
		progress: make(map[string]remoteProgress), probes: make(map[string]*remoteProbe),
	}
	s.refreshSelection()
	s.records, s.loadErr = readRemoteConnections(s.file)
	return s
}

func readRemoteConnections(file string) ([]savedRemoteConnection, error) {
	raw, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("无法读取保存的远程连接，请检查客户端配置目录")
	}
	var data remoteConnectionFile
	invalid := errors.New("保存的远程连接格式无效，请检查客户端配置目录")
	if err := json.Unmarshal(raw, &data); err != nil || data.Version != 1 {
		return nil, invalid
	}
	seen := make(map[string]bool, len(data.Connections))
	for _, c := range data.Connections {
		decoded, err := hex.DecodeString(c.ID)
		if err != nil || len(decoded) != 16 || c.ID != strings.ToLower(c.ID) || seen[c.ID] || c.Root == "" {
			return nil, invalid
		}
		if _, err := c.remoteEndpoint.normalized(); err != nil {
			return nil, invalid
		}
		seen[c.ID] = true
	}
	return data.Connections, nil
}

func (e remoteEndpoint) normalized() (remoteEndpoint, error) {
	switch e.Kind {
	case "unc":
		return uncEndpoint(e.Path)
	case "ssh":
		e.Drive = normalizeMountDrive(e.Drive)
		if err := validateSSHDrive(e.Drive); err != nil {
			return remoteEndpoint{}, err
		}
		if e.SSHHost != "" {
			return normalizePasswordEndpoint(e)
		}
		alias, err := sshEndpoint(e.Name, e.Path)
		alias.Drive = e.Drive
		return alias, err
	case "rclone":
		return rcloneEndpoint(e.Name, e.Path, e.Drive)
	}
	return remoteEndpoint{}, errors.New("不支持该远程连接类型")
}

func (s *remoteConnections) start() {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		tick := time.NewTicker(3 * time.Second)
		defer tick.Stop()
		var lastHealth time.Time
		var lastGeneration uint64
		for s.ctx.Err() == nil {
			s.poll(&lastHealth, &lastGeneration)
			select {
			case <-s.ctx.Done():
				return
			case <-s.wake:
			case <-tick.C:
			}
		}
	}()
}

func (s *remoteConnections) close() {
	s.mu.Lock()
	s.closed = true
	s.cancel()
	s.mu.Unlock()
	s.wg.Wait()
	// Wait for a foreground save or switch to leave the Facade before the
	// bridge shuts it down and unmounts the drives.
	s.activation.Lock()
	s.activation.Unlock()
}

func (s *remoteConnections) notify() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *remoteConnections) refreshSelection() {
	root, id := s.b.facade.CurrentLibrarySelection()
	ready := id != "" && s.b.facade.ActivePlanLibraryID() == id
	var mount *rcloneMount
	if ready {
		mount = s.b.remoteMountAt(root)
	}
	s.mu.Lock()
	previous := s.current
	if root != previous.root || id != previous.id || ready != previous.ready || mount != previous.mount {
		s.current = remoteSelection{root: root, id: id, ready: ready, mount: mount, generation: previous.generation + 1}
	}
	changed := s.current.generation != previous.generation
	s.mu.Unlock()
	s.notify()
	if changed {
		if s.b.syncPlans != nil {
			s.b.syncPlans.Wake()
		}
		if window := s.b.window; window != nil {
			// ExecJS can synchronously marshal to the UI thread. Do not let
			// a reconnect worker hold up quit while that thread closes it.
			go func() {
				if s.ctx.Err() == nil {
					window.ExecJS(`window.dispatchEvent(new Event('tak:remote-library-changed'))`)
				}
			}()
		}
	}
}

func (s *remoteConnections) entryLocked(c savedRemoteConnection) remoteConnectionDTO {
	out := remoteConnectionDTO{
		remoteEndpoint: c.remoteEndpoint, ID: c.ID, Label: c.Label, Root: c.Root,
		AutoReconnect: c.AutoReconnect, HasSavedPassword: c.HasSavedPassword, Active: s.current.id == c.ID,
		Status: "offline",
	}
	out.Mounted = c.Kind == "ssh" && s.b.existingSSHMount(c.remoteEndpoint) != ""
	if out.Active {
		out.Root = s.current.root
	}
	if progress := s.progress[c.ID]; progress.status != "" {
		out.Status, out.Message = progress.status, progress.message
		if c.AutoReconnect && out.Active && !progress.next.IsZero() {
			out.NextRetryAt = progress.next.UnixMilli()
		}
	}
	if out.Active && s.current.ready {
		out.Status, out.Message, out.NextRetryAt = "connected", "", 0
	}
	return out
}

func (s *remoteConnections) list() (remoteConnectionList, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loadErr != nil {
		return remoteConnectionList{}, s.loadErr
	}
	out := remoteConnectionList{Connections: make([]remoteConnectionDTO, 0, len(s.records))}
	for _, c := range s.records {
		out.Connections = append(out.Connections, s.entryLocked(c))
	}
	return out, nil
}

func (s *remoteConnections) recordLocked(id string) (int, savedRemoteConnection, bool) {
	for i, c := range s.records {
		if c.ID == id {
			return i, c, true
		}
	}
	return -1, savedRemoteConnection{}, false
}

func (s *remoteConnections) expectedMountID(endpoint remoteEndpoint) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.records {
		if c.remoteEndpoint.same(endpoint) {
			return c.ID
		}
		if c.Kind == "ssh" && c.SSHHost != "" && endpoint.Kind == "ssh" &&
			strings.EqualFold(c.SSHHost, endpoint.SSHHost) && c.SSHPort == endpoint.SSHPort &&
			c.SSHUser == endpoint.SSHUser && c.Path == endpoint.Path {
			return c.ID
		}
	}
	return ""
}

func (s *remoteConnections) persistLocked(records []savedRemoteConnection) error {
	if s.loadErr != nil {
		return s.loadErr
	}
	data, err := json.MarshalIndent(remoteConnectionFile{Version: 1, Connections: records}, "", "  ")
	if err == nil {
		err = platform.AtomicWriteFile(s.file, append(data, '\n'), 0600)
	}
	if err != nil {
		return errors.New("无法保存远程连接，请检查客户端配置目录的写入权限")
	}
	s.records = records
	return nil
}

func (s *remoteConnections) replaceLocked(c savedRemoteConnection) error {
	i, _, _ := s.recordLocked(c.ID)
	records := append([]savedRemoteConnection{}, s.records...)
	if i == -1 {
		records = append(records, c)
	} else {
		records[i] = c
	}
	return s.persistLocked(records)
}

func sameRemoteRoot(a, b string) bool {
	return a != "" && b != "" && strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func (s *remoteConnections) beginActivation() error {
	if !s.activation.TryLock() {
		return remoteError("busy", "档案库正在切换，请稍后重试")
	}
	if s.ctx.Err() != nil {
		s.activation.Unlock()
		return errors.New("远程连接服务已关闭")
	}
	return nil
}

func (s *remoteConnections) withPublicationSwitch(change func() error) error {
	if s.b.publication != nil {
		return s.b.publication.SwitchLibrary(change)
	}
	return change()
}

func (s *remoteConnections) resolveSelection(root string, newRemoteMount bool) (string, string, *rcloneMount, error) {
	if abs, err := filepath.Abs(strings.TrimSpace(root)); err == nil && strings.TrimSpace(root) != "" {
		root = abs
	}
	mount := s.b.remoteMountAt(root)
	if newRemoteMount && mount == nil {
		return "", "", nil, errors.New("新挂载已断开，请重新挂载后再打开")
	}
	var endpoint remoteEndpoint
	if mount != nil {
		endpoint = mount.endpoint
	} else if remote, kind := platform.NetworkPathKind(root); remote && kind == "mapped" {
		// Resolve a different mapping to the same saved UNC endpoint too.
		endpoint, _ = resolveUNC(root)
	}
	s.mu.Lock()
	current := s.current
	var id, endpointID string
	matches := 0
	for _, c := range s.records {
		if c.remoteEndpoint.same(endpoint) {
			endpointID = c.ID
		}
		if !newRemoteMount && c.matchesRoot(root) {
			id = c.ID
			matches++
		}
	}
	if !newRemoteMount && sameRemoteRoot(current.root, root) && current.id != "" {
		id, matches = current.id, 1
	}
	if matches == 0 {
		id = endpointID
	}
	s.mu.Unlock()
	if matches > 1 {
		return "", "", nil, errors.New("该盘符曾用于多个远程档案库，请从保存的连接选择要打开的库")
	}
	return root, id, mount, nil
}

func (s *remoteConnections) validateExplicitProbe(ctx context.Context, root string, newRemoteMount bool) error {
	root, id, mount, err := s.resolveSelection(root, newRemoteMount)
	if err != nil || id == "" {
		return err
	}
	s.mu.Lock()
	_, c, exists := s.recordLocked(id)
	s.mu.Unlock()
	if exists && c.Kind != "unc" && (mount == nil || !mount.endpoint.same(c.remoteEndpoint)) {
		return remoteError("offline", "请从保存的连接重新连接档案库")
	}
	if err := s.verify(ctx, root, id); err != nil {
		return classifyRemoteError(err)
	}
	return nil
}

func (s *remoteConnections) switchLibrary(ctx context.Context, root string, newRemoteMount bool) (any, error) {
	root, id, mount, err := s.resolveSelection(root, newRemoteMount)
	if err != nil {
		return nil, err
	}
	if id != "" && !newRemoteMount {
		_, flight, err := s.reconnect(id)
		if err != nil || flight == nil {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-flight.done:
			return nil, flight.err
		}
	}
	if err := s.beginActivation(); err != nil {
		return nil, err
	}
	defer s.activation.Unlock()
	if !s.b.archiveMu.TryLock() {
		return nil, takapp.ErrOperationRunning
	}
	defer s.b.archiveMu.Unlock()
	if mount != nil && s.b.remoteMountAt(root) != mount {
		return nil, errors.New("挂载已断开，请重新挂载后再打开")
	}
	previousRoot, previousID := s.b.facade.CurrentLibrarySelection()
	err = s.withPublicationSwitch(func() error {
		if mount != nil && id != "" {
			return s.b.facade.RestoreLibrary(ctx, root, id, previousRoot, previousID)
		}
		if mount != nil {
			return s.b.facade.SwitchManagedLibrary(root)
		}
		return s.b.facade.SwitchLibrary(root)
	})
	if err == nil {
		s.refreshSelection()
		if id != "" && id == previousID && mount != nil && !sameRemoteRoot(previousRoot, root) {
			if previous := s.b.remoteMountAt(previousRoot); previous != nil && previous.endpoint.same(mount.endpoint) {
				_ = stopRemoteMount(previous)
			}
		}
	}
	return nil, err
}

func (s *remoteConnections) save(ctx context.Context, root, label, sshPassword string, auto bool) (remoteConnectionDTO, error) {
	if err := s.beginActivation(); err != nil {
		return remoteConnectionDTO{}, err
	}
	defer s.activation.Unlock()
	if !s.b.archiveMu.TryLock() {
		return remoteConnectionDTO{}, takapp.ErrOperationRunning
	}
	defer s.b.archiveMu.Unlock()
	s.mu.Lock()
	current, loadErr := s.current, s.loadErr
	s.mu.Unlock()
	if loadErr != nil {
		return remoteConnectionDTO{}, loadErr
	}
	if root == "" {
		root = current.root
	}
	if !sameRemoteRoot(current.root, root) || current.id != "" && !current.ready {
		return remoteConnectionDTO{}, errors.New("请先打开要保存的远程档案库")
	}
	root = current.root
	if err := validateRemoteLabel(label, true); err != nil {
		return remoteConnectionDTO{}, err
	}
	mount := s.b.remoteMountAt(root)
	var endpoint remoteEndpoint
	var err error
	if mount != nil {
		endpoint = mount.endpoint
	} else {
		endpoint, err = resolveUNC(root)
		if err != nil {
			return remoteConnectionDTO{}, err
		}
	}
	id := current.id
	if id == "" {
		id, err = s.b.facade.RegisterCurrentLibrary()
		if err != nil {
			return remoteConnectionDTO{}, classifyRemoteError(err)
		}
	} else if err := s.verify(ctx, root, id); err != nil {
		return remoteConnectionDTO{}, classifyRemoteError(err)
	}
	if endpoint.Kind == "unc" && !sameRemoteRoot(endpoint.Path, root) {
		if err := s.verify(ctx, endpoint.Path, id); err != nil {
			return remoteConnectionDTO{}, err
		}
	} else if mount != nil {
		if s.b.remoteMountAt(root) != mount {
			return remoteConnectionDTO{}, remoteError("offline", "挂载已断开，请重新挂载后再保存")
		}
		if mount.cmd != nil {
			if err := mount.confirmMarker(ctx, id); err != nil {
				return remoteConnectionDTO{}, classifyRemoteError(err)
			}
		}
		if endpoint.SSHHost != "" && sshPassword != "" {
			env, err := passwordMountEnv(ctx, endpoint, sshPassword)
			if err != nil {
				return remoteConnectionDTO{}, err
			}
			if err := verifyRcloneMarker(ctx, findRclone(), mount.markerDir, id, sshPasswordOptions(endpoint), env); err != nil {
				return remoteConnectionDTO{}, classifyRemoteError(err)
			}
		}
	}
	if err := s.b.facade.SetCurrentLibraryIdentity(root, id); err != nil {
		return remoteConnectionDTO{}, classifyRemoteError(err)
	}
	s.refreshSelection()
	s.mu.Lock()
	defer s.mu.Unlock()
	_, record, _ := s.recordLocked(id)
	previousTarget := s.credentialTarget(record)
	record.ID, record.remoteEndpoint, record.AutoReconnect = id, endpoint, auto
	target := s.credentialTarget(record)
	var previousPassword string
	if target != "" {
		previousPassword, err = readSSHPassword(target)
		if err != nil && !errors.Is(err, windows.ERROR_NOT_FOUND) {
			return remoteConnectionDTO{}, fmt.Errorf("无法读取 Windows 凭据管理器：%w", err)
		}
		if sshPassword == "" && auto && previousPassword == "" {
			return remoteConnectionDTO{}, errors.New("请先补录 SSH 登录密码")
		}
		if sshPassword != "" {
			if err := writeSSHPassword(target, sshPassword); err != nil {
				return remoteConnectionDTO{}, err
			}
		}
	}
	record.HasSavedPassword = target != "" && (sshPassword != "" || previousPassword != "")
	record.updateRoot(root)
	if label = strings.TrimSpace(label); label != "" {
		record.Label = label
	} else if record.Label == "" {
		record.Label = endpoint.VolumeName
		if record.Label == "" {
			record.Label = endpoint.Name
		}
		if record.Label == "" {
			record.Label = endpoint.Path
		}
	}
	if err := s.replaceLocked(record); err != nil {
		if target != "" && sshPassword != "" {
			if previousPassword == "" {
				err = errors.Join(err, deleteSSHPassword(target))
			} else {
				err = errors.Join(err, writeSSHPassword(target, previousPassword))
			}
		}
		return remoteConnectionDTO{}, err
	}
	delete(s.progress, id)
	if previousTarget != "" && previousTarget != target {
		if err := deleteSSHPassword(previousTarget); err != nil {
			return s.entryLocked(record), err
		}
	}
	return s.entryLocked(record), nil
}

func validateRemoteLabel(label string, allowEmpty bool) error {
	label = strings.TrimSpace(label)
	if label == "" && !allowEmpty || len([]rune(label)) > 120 || strings.ContainsFunc(label, unicode.IsControl) {
		return errors.New("请输入 1–120 个字符的连接名称")
	}
	return nil
}

func (s *remoteConnections) renameOrSetAuto(id, label string, auto *bool) (remoteConnectionDTO, error) {
	if auto == nil {
		if err := validateRemoteLabel(label, false); err != nil {
			return remoteConnectionDTO{}, err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return remoteConnectionDTO{}, errors.New("远程连接服务已关闭")
	}
	_, c, ok := s.recordLocked(id)
	if !ok {
		return remoteConnectionDTO{}, errors.New("找不到保存的远程连接")
	}
	wasAuto := c.AutoReconnect
	if auto != nil {
		if *auto && c.SSHHost != "" {
			if _, err := readSSHPassword(s.credentialTarget(c)); err != nil {
				return remoteConnectionDTO{}, errors.New("请先补录 SSH 登录密码，再开启自动重连")
			}
			c.HasSavedPassword = true
		}
		c.AutoReconnect = *auto
	} else {
		c.Label = strings.TrimSpace(label)
	}
	if err := s.replaceLocked(c); err != nil {
		return remoteConnectionDTO{}, err
	}
	if wasAuto != c.AutoReconnect {
		if c.AutoReconnect {
			delete(s.progress, id)
		} else if s.flight != nil && s.flight.id == id && s.flight.automatic {
			s.flight.cancel()
		}
		s.notify()
	}
	return s.entryLocked(c), nil
}

func (s *remoteConnections) forget(id string) error {
	if err := s.beginActivation(); err != nil {
		return err
	}
	defer s.activation.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	i, record, ok := s.recordLocked(id)
	if !ok {
		return nil
	}
	records := append([]savedRemoteConnection{}, s.records[:i]...)
	records = append(records, s.records[i+1:]...)
	target := s.credentialTarget(record)
	var password string
	if target != "" {
		var err error
		password, err = readSSHPassword(target)
		if err != nil && !errors.Is(err, windows.ERROR_NOT_FOUND) {
			return fmt.Errorf("无法读取 Windows 凭据管理器：%w", err)
		}
		if err := deleteSSHPassword(target); err != nil {
			return err
		}
	}
	if err := s.persistLocked(records); err != nil {
		if password != "" {
			return errors.Join(err, writeSSHPassword(target, password))
		}
		return err
	}
	delete(s.progress, id)
	if s.flight != nil && s.flight.id == id {
		s.flight.cancel()
	}
	s.notify()
	return nil
}

func (s *remoteConnections) rpc(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	var p struct {
		ID            string `json:"id"`
		Root          string `json:"root"`
		Label         string `json:"label"`
		SSHPassword   string `json:"sshPassword"`
		AutoReconnect *bool  `json:"autoReconnect"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, errors.New("远程连接参数无效")
		}
	}
	switch method {
	case "remoteConnectionList":
		return s.list()
	case "remoteConnectionSave":
		return s.save(ctx, p.Root, p.Label, p.SSHPassword, p.AutoReconnect != nil && *p.AutoReconnect)
	case "remoteConnectionReconnect":
		entry, _, err := s.reconnect(p.ID)
		return entry, err
	case "remoteConnectionSetAuto":
		if p.AutoReconnect == nil {
			return nil, errors.New("请选择是否自动连接")
		}
		return s.renameOrSetAuto(p.ID, "", p.AutoReconnect)
	case "remoteConnectionRename":
		return s.renameOrSetAuto(p.ID, p.Label, nil)
	case "remoteConnectionForget":
		s.mu.Lock()
		_, record, found := s.recordLocked(p.ID)
		s.mu.Unlock()
		if found && record.Kind == "ssh" {
			if existing := s.b.existingSSHMount(record.remoteEndpoint); existing != "" {
				s.mu.Lock()
				active := s.current.id == record.ID && s.current.ready
				s.mu.Unlock()
				if active {
					return nil, errors.New("请先切换到其他档案库，再移除并卸载此连接")
				}
				if err := stopRemoteMount(s.b.remoteMountAt(existing)); err != nil {
					return nil, err
				}
			}
		}
		return nil, s.forget(p.ID)
	case "remoteConnectionUnmount":
		if err := s.beginActivation(); err != nil {
			return nil, err
		}
		defer s.activation.Unlock()
		s.mu.Lock()
		_, record, found := s.recordLocked(p.ID)
		active := s.current.id == p.ID && s.current.ready
		s.mu.Unlock()
		if !found || record.Kind != "ssh" {
			return nil, errors.New("未找到 SSH 连接")
		}
		if active {
			return nil, errors.New("请先切换到其他档案库，再卸载此盘符")
		}
		if err := stopRemoteMount(s.b.remoteMountAt(s.b.existingSSHMount(record.remoteEndpoint))); err != nil {
			return nil, err
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		_, latest, found := s.recordLocked(p.ID)
		if !found {
			return nil, errors.New("未找到 SSH 连接")
		}
		return s.entryLocked(latest), nil
	}
	return nil, errors.New("未知的远程连接操作")
}

func (s *remoteConnections) reconnect(id string) (remoteConnectionDTO, *remoteFlight, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, c, ok := s.recordLocked(id)
	if !ok {
		return remoteConnectionDTO{}, nil, errors.New("找不到保存的远程连接，请从原网络位置重新打开")
	}
	if s.current.id == id && s.current.ready {
		return s.entryLocked(c), nil, nil
	}
	if s.flight != nil {
		if s.flight.id == id {
			return s.entryLocked(c), s.flight, nil
		}
		return s.entryLocked(c), nil, remoteError("busy", "正在连接另一档案库，请稍后重试")
	}
	if s.closed {
		return remoteConnectionDTO{}, nil, errors.New("远程连接服务已关闭")
	}
	delete(s.progress, id)
	f := s.launchLocked(c, false)
	return s.entryLocked(c), f, nil
}

func (s *remoteConnections) launchLocked(c savedRemoteConnection, automatic bool) *remoteFlight {
	ctx, cancel := context.WithCancel(s.ctx)
	f := &remoteFlight{id: c.ID, automatic: automatic, cancel: cancel, done: make(chan struct{})}
	s.flight = f
	p := s.progress[c.ID]
	p.status, p.message, p.next = "connecting", "", time.Time{}
	s.progress[c.ID] = p
	previous := s.current
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer cancel()
		root, err := s.connect(ctx, c, previous)
		s.mu.Lock()
		defer s.mu.Unlock()
		defer close(f.done)
		s.flight = nil
		_, latest, exists := s.recordLocked(c.ID)
		if err != nil {
			f.err = classifyRemoteError(err)
			if exists {
				s.recordFailureLocked(latest, err)
			}
		} else {
			delete(s.progress, c.ID)
			if exists && !sameRemoteRoot(latest.Root, root) {
				latest.updateRoot(root)
				_ = s.replaceLocked(latest)
			}
		}
		s.notify()
	}()
	return f
}

func (s *remoteConnections) connect(ctx context.Context, c savedRemoteConnection, previous remoteSelection) (string, error) {
	endpoint, err := c.remoteEndpoint.normalized()
	if err != nil {
		return "", err
	}
	if endpoint.Kind == "ssh" {
		endpoint.VolumeName = c.Label
	}
	if s.b.publication != nil && s.b.publication.Requested() {
		return "", remoteError("busy", "请先停止网页部署，再切换档案库")
	}
	root := endpoint.Path
	var newMount *rcloneMount
	switch endpoint.Kind {
	case "ssh":
		if existing := s.b.existingSSHMount(endpoint); existing != "" {
			root = existing
		} else if endpoint.SSHHost == "" {
			root, newMount, err = s.b.mountSSH(ctx, endpoint, c.ID, false)
		} else {
			password, readErr := readSSHPassword(s.credentialTarget(c))
			if readErr != nil {
				return "", remoteError("authentication_required", "请补录 SSH 登录密码，再重新连接")
			}
			env, envErr := passwordMountEnv(ctx, endpoint, password)
			if envErr != nil {
				return "", envErr
			}
			root, newMount, err = s.b.startRemoteMount(ctx, endpoint, ":sftp:", c.ID, false, sshPasswordOptions(endpoint), env, nil)
		}
	case "rclone":
		root, newMount, err = s.b.mountRclone(ctx, endpoint, c.ID, true)
	}
	if err != nil {
		return "", err
	}
	activated := false
	defer func() {
		if !activated && newMount != nil {
			_ = stopRemoteMount(newMount)
		}
	}()
	mount := s.b.remoteMountAt(root)
	if endpoint.Kind != "unc" && (mount == nil || !mount.endpoint.same(endpoint)) {
		return "", remoteError("offline", "挂载已断开，请重新连接")
	}
	if err := s.verify(ctx, root, c.ID); err != nil {
		if mount != nil && !errors.Is(err, takapp.ErrLibraryIdentity) {
			if classified := mount.report.failure(false); classified.status == "authentication_required" {
				return "", classified
			}
		}
		return "", err
	}
	if err := s.beginActivation(); err != nil {
		return "", err
	}
	defer s.activation.Unlock()
	if !s.b.archiveMu.TryLock() {
		return "", takapp.ErrOperationRunning
	}
	defer s.b.archiveMu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	s.mu.Lock()
	unchanged := s.current == previous
	s.mu.Unlock()
	if !unchanged {
		return "", remoteError("busy", "当前档案库已更改，请重新选择要连接的档案库")
	}
	if mount != nil && s.b.remoteMountAt(root) != mount {
		return "", remoteError("offline", "挂载已断开，请重新连接")
	}
	// The Facade checks both the previous selection and the expected identity
	// again before writing or replacing the current library.
	err = s.withPublicationSwitch(func() error {
		return s.b.facade.RestoreLibrary(ctx, root, c.ID, previous.root, previous.id)
	})
	if err != nil {
		return "", err
	}
	activated = true
	s.refreshSelection()
	return root, nil
}

func (s *remoteConnections) recordFailureLocked(c savedRemoteConnection, err error) {
	failure := classifyRemoteError(err)
	progress := remoteProgress{status: failure.status, message: failure.message}
	if c.AutoReconnect && s.current.id == c.ID && !s.current.ready && (failure.status == "offline" || failure.status == "busy") {
		progress.failures = s.progress[c.ID].failures + 1
		delay := min(60*time.Second, 5*time.Second<<min(4, progress.failures-1))
		progress.next = time.Now().Add(delay)
	}
	s.progress[c.ID] = progress
}

func (s *remoteConnections) poll(lastHealth *time.Time, lastGeneration *uint64) {
	s.mu.Lock()
	current := s.current
	_, c, exists := s.recordLocked(current.id)
	if !exists && current.id != "" && !current.ready {
		if mount := s.b.remoteMountAt(current.root); mount != nil && mount.endpoint.Kind == "ssh" {
			c = savedRemoteConnection{ID: current.id, remoteEndpoint: mount.endpoint}
			exists = true
		}
	}
	p := s.progress[current.id]
	if !s.closed && !current.ready && exists && (c.AutoReconnect || s.b.existingSSHMount(c.remoteEndpoint) != "") && s.flight == nil &&
		(p.status == "" || !p.next.IsZero() && !time.Now().Before(p.next)) {
		s.launchLocked(c, true)
	}
	s.mu.Unlock()
	if current.id == "" || !current.ready {
		return
	}
	var err error
	if current.mount != nil || exists && c.Kind != "unc" {
		if mount := s.b.remoteMountAt(current.root); mount == nil || mount != current.mount {
			err = remoteError("offline", "远程挂载已断开，请重新连接")
		}
	}
	if err == nil {
		if *lastGeneration == current.generation && time.Since(*lastHealth) < remoteHealthInterval {
			return
		}
		*lastGeneration, *lastHealth = current.generation, time.Now()
		err = s.verify(s.ctx, current.root, current.id)
		if err == nil && exists && c.Kind == "unc" && !sameRemoteRoot(c.Path, current.root) {
			err = s.verify(s.ctx, c.Path, current.id)
		}
	}
	if err == nil || s.ctx.Err() != nil || !s.activation.TryLock() {
		return
	}
	defer s.activation.Unlock()
	s.mu.Lock()
	unchanged := s.current == current
	s.mu.Unlock()
	if unchanged {
		s.b.facade.SuspendRemoteLibrary(current.root, current.id)
		s.refreshSelection()
		s.mu.Lock()
		if _, latest, ok := s.recordLocked(current.id); ok {
			s.recordFailureLocked(latest, err)
		}
		s.mu.Unlock()
	}
}

func (s *remoteConnections) verify(ctx context.Context, root, id string) error {
	ctx, cancel := context.WithTimeout(ctx, remoteProbeTimeout)
	defer cancel()
	key := strings.ToLower(filepath.Clean(root))
	s.probeMu.Lock()
	probe := s.probes[key]
	if probe == nil {
		if len(s.probes) >= 2 {
			s.probeMu.Unlock()
			return remoteError("offline", "Windows 正在等待网络目录响应，请稍后重试")
		}
		probe = &remoteProbe{done: make(chan struct{})}
		s.probes[key] = probe
		go func() {
			probe.id, probe.err = takapp.ReadLibraryID(root)
			if errors.Is(probe.err, os.ErrNotExist) {
				// A missing marker on a reachable root is an identity mismatch.
				if info, statErr := os.Stat(root); statErr == nil && info.IsDir() {
					probe.err = takapp.ErrLibraryIdentity
				}
			}
			s.probeMu.Lock()
			delete(s.probes, key)
			close(probe.done)
			s.probeMu.Unlock()
		}()
	}
	s.probeMu.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-probe.done:
		if probe.err != nil {
			return probe.err
		}
		if probe.id != id {
			return takapp.ErrLibraryIdentity
		}
		return nil
	}
}

func uncEndpoint(root string) (remoteEndpoint, error) {
	root = strings.ReplaceAll(strings.TrimSpace(root), "/", `\`)
	if !strings.HasPrefix(root, `\\`) || strings.ContainsAny(root, "<>:\"|?*\x00\r\n") {
		return remoteEndpoint{}, errors.New("请输入有效的 SMB / UNC 共享路径")
	}
	parts := strings.Split(strings.TrimPrefix(root, `\\`), `\`)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" ||
		parts[0] == "." || parts[0] == ".." || parts[1] == "." || parts[1] == ".." {
		return remoteEndpoint{}, errors.New("请输入包含服务器和共享名的 UNC 路径")
	}
	return remoteEndpoint{Kind: "unc", Path: filepath.Clean(root)}, nil
}

var wNetGetConnectionW = windows.NewLazySystemDLL("mpr.dll").NewProc("WNetGetConnectionW")

func resolveUNC(root string) (remoteEndpoint, error) {
	if strings.HasPrefix(root, `\\`) || strings.HasPrefix(root, "//") {
		return uncEndpoint(root)
	}
	volume := filepath.VolumeName(root)
	if len(volume) != 2 || volume[1] != ':' || !filepath.IsAbs(root) {
		return remoteEndpoint{}, errors.New("请选择 UNC 路径、可解析的映射盘或客户端挂载的远程档案库")
	}
	local, err := windows.UTF16PtrFromString(volume)
	if err != nil {
		return remoteEndpoint{}, err
	}
	size := uint32(1024)
	for {
		buf := make([]uint16, size)
		result, _, _ := wNetGetConnectionW.Call(uintptr(unsafe.Pointer(local)), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
		if result == 0 {
			share := windows.UTF16ToString(buf)
			relative := strings.TrimLeft(strings.TrimPrefix(root, volume), `\/`)
			return uncEndpoint(filepath.Join(share, relative))
		}
		if result != uintptr(windows.ERROR_MORE_DATA) || size <= uint32(len(buf)) || size > 32768 {
			return remoteEndpoint{}, errors.New("无法解析此映射盘的原始网络位置，请使用 UNC 路径重新打开档案库")
		}
	}
}
