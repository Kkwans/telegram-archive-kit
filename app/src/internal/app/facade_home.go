package app

import (
	"strings"
	"syscall"
	"unsafe"
)

type HomeStorageDTO struct {
	DiskFree  int64 `json:"diskFree"`
	DiskTotal int64 `json:"diskTotal"`
}

var (
	diskKernel32      = syscall.NewLazyDLL("kernel32.dll")
	procGetDiskFreeEx = diskKernel32.NewProc("GetDiskFreeSpaceExW")
)

func diskFreeSpace(root string) (free, total int64) {
	if strings.TrimSpace(root) == "" {
		return 0, 0
	}
	path, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return 0, 0
	}
	var freeBytes, totalBytes, totalFree uint64
	r, _, _ := procGetDiskFreeEx.Call(
		uintptr(unsafe.Pointer(path)),
		uintptr(unsafe.Pointer(&freeBytes)),
		uintptr(unsafe.Pointer(&totalBytes)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if r == 0 {
		return 0, 0
	}
	return int64(freeBytes), int64(totalBytes)
}

func (f *Facade) HomeStorage() HomeStorageDTO {
	free, total := diskFreeSpace(f.libraryRoot())
	return HomeStorageDTO{DiskFree: free, DiskTotal: total}
}
