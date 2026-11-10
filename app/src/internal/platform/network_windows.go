//go:build windows

package platform

import (
	"strings"
	"syscall"
	"unsafe"
)

var procGetDriveTypeW = kernel32.NewProc("GetDriveTypeW")

const driveRemote = 4

// NetworkPathKind reports whether path lives on SMB/UNC or a mapped network
// drive. It is intentionally a cheap classification, not a reachability test.
func NetworkPathKind(path string) (bool, string) {
	p := strings.TrimSpace(path)
	if strings.HasPrefix(p, `\\`) || strings.HasPrefix(p, "//") {
		return true, "unc"
	}
	if len(p) >= 2 && p[1] == ':' {
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
