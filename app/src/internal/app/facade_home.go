package app

import (
	"strings"
	"syscall"
	"unsafe"
)

// HomeStatsDTO powers the overview home page.
type HomeStatsDTO struct {
	Chats        int   `json:"chats"`
	Messages     int   `json:"messages"`
	Media        int   `json:"media"`
	Missing      int   `json:"missing"`
	Pages        int   `json:"pages"`
	Official     int   `json:"official"`
	Images       int   `json:"images"`
	Videos       int   `json:"videos"`
	Audio        int   `json:"audio"`
	Files        int   `json:"files"`
	MediaBytes   int64 `json:"mediaBytes"`
	DiskFree     int64 `json:"diskFree"`
	DiskTotal    int64 `json:"diskTotal"`
	LibraryBytes int64 `json:"libraryBytes"`
	PendingMedia int   `json:"pendingMedia"`
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

func (f *Facade) HomeStats() HomeStatsDTO {
	out := HomeStatsDTO{}
	for _, c := range f.ListChats() {
		out.Chats++
		out.Messages += c.Messages
		out.Missing += c.Missing
		out.Pages += c.Pages
		out.Official += c.Official
		if !c.MediaReady {
			out.PendingMedia++
			continue
		}
		out.Media += c.Media
		out.Images += c.Images
		out.Videos += c.Videos
		out.Audio += c.Audio
		out.Files += c.Files
		out.MediaBytes += c.TotalBytes
	}
	out.LibraryBytes = out.MediaBytes
	out.DiskFree, out.DiskTotal = diskFreeSpace(f.libraryRoot())
	return out
}
