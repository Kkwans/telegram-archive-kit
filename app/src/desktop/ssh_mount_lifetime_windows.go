package main

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
	"telegramarchivekit/internal/platform"
)

type sshMountRecord struct {
	Endpoint   remoteEndpoint
	Root       string
	Executable string
	PID        uint32
	Created    windows.Filetime
	FullRoot   bool
}

func (b *Bridge) sshMountRecordPath(drive string) string {
	return filepath.Join(b.facade.ConfigDir(), "ssh-mounts", drive+".json")
}

func (b *Bridge) rememberSSHMount(drive string, mount *rcloneMount) error {
	record := sshMountRecord{Endpoint: mount.endpoint, Root: mount.libraryRoot, Executable: mount.cmd.Path, PID: uint32(mount.cmd.Process.Pid), FullRoot: mount.fullRoot}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, record.PID)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	var exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &record.Created, &exited, &kernel, &user); err != nil {
		return err
	}
	file := b.sshMountRecordPath(drive)
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return platform.AtomicWriteFile(file, data, 0600)
}

func (b *Bridge) adoptSSHMounts() {
	occupied, err := windows.GetLogicalDrives()
	if err != nil {
		return
	}
	for letter := byte('D'); letter <= 'Z'; letter++ {
		if occupied&(1<<(letter-'A')) == 0 {
			continue
		}
		drive := string(letter)
		raw, err := os.ReadFile(b.sshMountRecordPath(drive))
		if err != nil {
			continue
		}
		var record sshMountRecord
		if json.Unmarshal(raw, &record) != nil || record.Endpoint.Kind != "ssh" || !strings.EqualFold(filepath.VolumeName(record.Root), drive+":") ||
			!strings.EqualFold(filepath.Base(record.Executable), "rclone.exe") {
			continue
		}
		handle, err := verifiedSSHMountProcess(record)
		if err != nil || handle == 0 {
			continue
		}
		mount := &rcloneMount{libraryRoot: record.Root, endpoint: record.Endpoint, fullRoot: record.FullRoot, done: make(chan struct{}), processHandle: handle, ready: true,
			markerDir: ":sftp:" + path.Join(record.Endpoint.Path, ".runtime")}
		b.mountMu.Lock()
		b.mounts[drive] = mount
		b.mountMu.Unlock()
		unmark := platform.MarkManagedRemoteDrive(drive)
		go func() {
			_, _ = windows.WaitForSingleObject(handle, windows.INFINITE)
			b.mountMu.Lock()
			unmark()
			delete(b.mounts, drive)
			close(mount.done)
			b.mountMu.Unlock()
			_ = windows.CloseHandle(handle)
		}()
	}
}

func verifiedSSHMountProcess(record sshMountRecord) (windows.Handle, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, record.PID)
	if err != nil {
		return 0, err
	}
	var created, exited, kernel, user windows.Filetime
	path := make([]uint16, 32768)
	size := uint32(len(path))
	if windows.GetProcessTimes(handle, &created, &exited, &kernel, &user) == nil && created == record.Created &&
		windows.QueryFullProcessImageName(handle, 0, &path[0], &size) == nil &&
		strings.EqualFold(windows.UTF16ToString(path[:size]), record.Executable) {
		return handle, nil
	}
	_ = windows.CloseHandle(handle)
	return 0, nil
}

func (b *Bridge) existingSSHMount(endpoint remoteEndpoint) string {
	if endpoint.Kind != "ssh" {
		return ""
	}
	b.mountMu.Lock()
	defer b.mountMu.Unlock()
	for drive, mount := range b.mounts {
		if mount.ready && mount.endpoint.Kind == "ssh" && mount.endpoint.same(endpoint) && (endpoint.Drive == "" || endpoint.Drive == drive) {
			return mount.libraryRoot
		}
	}
	return ""
}

func (b *Bridge) reusableSSHMount(endpoint remoteEndpoint) string {
	root := b.existingSSHMount(endpoint)
	if endpoint.SSHUseRoot {
		if mount := b.remoteMountAt(root); mount == nil || !mount.fullRoot {
			return ""
		}
	}
	return root
}
