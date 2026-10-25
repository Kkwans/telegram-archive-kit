//go:build windows

package main

import (
	"os"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var (
	advapi32                = syscall.NewLazyDLL("advapi32.dll")
	user32Path              = syscall.NewLazyDLL("user32.dll")
	procRegOpenKeyExW       = advapi32.NewProc("RegOpenKeyExW")
	procRegQueryValueExW    = advapi32.NewProc("RegQueryValueExW")
	procRegSetValueExW      = advapi32.NewProc("RegSetValueExW")
	procRegCloseKey         = advapi32.NewProc("RegCloseKey")
	procSendMessageTimeoutW = user32Path.NewProc("SendMessageTimeoutW")
)

const (
	hkeyCurrentUser = uintptr(0x80000001)
	keyQueryValue   = 0x0001
	keySetValue     = 0x0002
	regExpandSZ     = 2
	wmSettingChange = 0x001A
	hwndBroadcast   = uintptr(0xFFFF)
	smtoAbortIfHung = 0x0002
)

func addUserPath(dir string) error {
	envKey, _ := syscall.UTF16PtrFromString(`Environment`)
	valueName, _ := syscall.UTF16PtrFromString("Path")
	var h uintptr
	r, _, _ := procRegOpenKeyExW.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(envKey)), 0, keyQueryValue|keySetValue, uintptr(unsafe.Pointer(&h)))
	if r != 0 {
		return syscall.Errno(r)
	}
	defer procRegCloseKey.Call(h)

	var typ uint32
	var size uint32
	procRegQueryValueExW.Call(h, uintptr(unsafe.Pointer(valueName)), 0, uintptr(unsafe.Pointer(&typ)), 0, uintptr(unsafe.Pointer(&size)))
	var existing string
	if size > 2 {
		buf := make([]uint16, size/2+2)
		if rr, _, _ := procRegQueryValueExW.Call(h, uintptr(unsafe.Pointer(valueName)), 0, uintptr(unsafe.Pointer(&typ)), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size))); rr == 0 {
			n := 0
			for n < len(buf) && buf[n] != 0 {
				n++
			}
			existing = string(utf16.Decode(buf[:n]))
		}
	}
	found := false
	for _, part := range strings.Split(existing, ";") {
		if strings.EqualFold(strings.TrimSpace(part), dir) {
			found = true
			break
		}
	}
	if !found {
		if strings.TrimSpace(existing) == "" {
			existing = dir
		} else {
			existing = strings.TrimRight(existing, ";") + ";" + dir
		}
		data := utf16z(existing)
		bytes := uint32(len(data) * 2)
		if rr, _, _ := procRegSetValueExW.Call(h, uintptr(unsafe.Pointer(valueName)), 0, regExpandSZ, uintptr(unsafe.Pointer(&data[0])), uintptr(bytes)); rr != 0 {
			return syscall.Errno(rr)
		}
		environment, _ := syscall.UTF16PtrFromString("Environment")
		var out uintptr
		procSendMessageTimeoutW.Call(hwndBroadcast, wmSettingChange, 0, uintptr(unsafe.Pointer(environment)), smtoAbortIfHung, 3000, uintptr(unsafe.Pointer(&out)))
	}
	// Also update this process immediately, so no terminal restart is needed.
	cur := os.Getenv("PATH")
	if !strings.Contains(strings.ToLower(cur), strings.ToLower(dir)) {
		_ = os.Setenv("PATH", cur+string(os.PathListSeparator)+dir)
	}
	return nil
}
