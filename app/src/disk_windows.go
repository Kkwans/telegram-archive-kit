//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var procGetDiskFreeSpaceExW = kernel32.NewProc("GetDiskFreeSpaceExW")

func freeSpaceBytes(path string) uint64 {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0
	}
	var freeAvail, total, totalFree uint64
	r, _, _ := procGetDiskFreeSpaceExW.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&freeAvail)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&totalFree)))
	if r == 0 {
		return 0
	}
	return freeAvail
}
