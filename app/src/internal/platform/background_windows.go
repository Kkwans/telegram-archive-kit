//go:build windows

package platform

import "syscall"

var (
	kernel32Bg            = syscall.NewLazyDLL("kernel32.dll")
	procGetCurrentProcess = kernel32Bg.NewProc("GetCurrentProcess")
	procSetPriorityClass  = kernel32Bg.NewProc("SetPriorityClass")
)

const (
	processModeBackgroundBegin = 0x00100000
	processModeBackgroundEnd   = 0x00200000
)

func Background() func() {
	h, _, _ := procGetCurrentProcess.Call()
	if h == 0 {
		return func() {}
	}
	r, _, _ := procSetPriorityClass.Call(h, processModeBackgroundBegin)
	if r == 0 {
		return func() {}
	}
	return func() { _, _, _ = procSetPriorityClass.Call(h, processModeBackgroundEnd) }
}
