//go:build windows

package platform

import (
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

var procGetDriveTypeW = kernel32.NewProc("GetDriveTypeW")
var managedRemoteDrives sync.Map

const driveRemote = 4

// MarkManagedRemoteDrive records a session mount that Windows presents as a disk.
func MarkManagedRemoteDrive(drive string) (unmark func()) {
	drive = strings.ToUpper(drive)
	managedRemoteDrives.Store(drive, struct{}{})
	return func() { managedRemoteDrives.Delete(drive) }
}

// NetworkPathKind reports whether path lives on SMB/UNC or a mapped network
// drive. It is intentionally a cheap classification, not a reachability test.
func NetworkPathKind(path string) (bool, string) {
	p := strings.TrimSpace(path)
	if strings.HasPrefix(p, `\\`) || strings.HasPrefix(p, "//") {
		return true, "unc"
	}
	if len(p) >= 2 && p[1] == ':' {
		if _, managed := managedRemoteDrives.Load(strings.ToUpper(p[:1])); managed {
			return true, "mapped"
		}
		root := p[:2] + `\`
		ptr, err := syscall.UTF16PtrFromString(root)
		if err == nil {
			t, _, _ := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(ptr)))
			switch int(t) {
			case driveRemote:
				return true, "mapped"
			case 2, 3, 5, 6: // removable, fixed, optical, RAM
				return false, "local"
			}
		}
	}
	return false, "unknown"
}
