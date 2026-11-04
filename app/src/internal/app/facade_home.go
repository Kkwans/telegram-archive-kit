package app

import (
	"encoding/json"
	"os"
	"path/filepath"
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
		out.Media += c.Media
		out.Missing += c.Missing
		out.Pages += c.Pages
		out.Official += c.Official
		data, err := os.ReadFile(filepath.Join(f.a.workspaceDir(c.Slug), "data", "archive-data.js"))
		if err == nil {
			text := string(data)
			if i := strings.IndexByte(text, '{'); i >= 0 {
				var parsed archiveDataFile
				dec := json.NewDecoder(strings.NewReader(text[i:]))
				if dec.Decode(&parsed) == nil {
					for _, m := range parsed.Messages {
						for _, x := range m.Media {
							out.MediaBytes += x.Size
							switch x.Kind {
							case "image":
								out.Images++
							case "video":
								out.Videos++
							case "audio":
								out.Audio++
							default:
								out.Files++
							}
						}
					}
				}
			}
		}
	}
	out.LibraryBytes = out.MediaBytes
	out.DiskFree, out.DiskTotal = diskFreeSpace(f.a.Settings.LibraryRoot)
	return out
}
