//go:build windows

package platform

import (
	"syscall"
	"unsafe"
)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procGetDiskFreeSpaceExW = kernel32.NewProc("GetDiskFreeSpaceExW")
)

func diskSpace(path string) (free, total int64) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0
	}
	var freeAvail, totalBytes, totalFree uint64
	r, _, _ := procGetDiskFreeSpaceExW.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&freeAvail)), uintptr(unsafe.Pointer(&totalBytes)), uintptr(unsafe.Pointer(&totalFree)))
	if r == 0 {
		return 0, 0
	}
	return int64(freeAvail), int64(totalBytes)
}
