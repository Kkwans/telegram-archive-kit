//go:build windows

package platform

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	shell32           = syscall.NewLazyDLL("shell32.dll")
	procShellExecuteW = shell32.NewProc("ShellExecuteW")
)

func Open(target string) error {
	op, _ := syscall.UTF16PtrFromString("open")
	t, _ := syscall.UTF16PtrFromString(target)
	r, _, _ := procShellExecuteW.Call(0, uintptr(unsafe.Pointer(op)), uintptr(unsafe.Pointer(t)), 0, 0, 1)
	if r <= 32 {
		return fmt.Errorf("Windows 无法打开目标（ShellExecute code %d）：%s", r, target)
	}
	return nil
}
