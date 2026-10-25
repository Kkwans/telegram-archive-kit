//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

var procShellExecuteW = shell32.NewProc("ShellExecuteW")

func systemOpen(target string) error {
	op, _ := syscall.UTF16PtrFromString("open")
	t, _ := syscall.UTF16PtrFromString(target)
	r, _, _ := procShellExecuteW.Call(0, uintptr(unsafe.Pointer(op)), uintptr(unsafe.Pointer(t)), 0, 0, 1)
	if r <= 32 {
		return fmt.Errorf("Windows 无法打开目标（ShellExecute code %d）：%s", r, target)
	}
	return nil
}
