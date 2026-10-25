//go:build windows

package app

import (
	"path/filepath"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var (
	comdlg32                 = syscall.NewLazyDLL("comdlg32.dll")
	shell32                  = syscall.NewLazyDLL("shell32.dll")
	ole32                    = syscall.NewLazyDLL("ole32.dll")
	procGetOpenFileNameW     = comdlg32.NewProc("GetOpenFileNameW")
	procSHBrowseForFolderW   = shell32.NewProc("SHBrowseForFolderW")
	procSHGetPathFromIDListW = shell32.NewProc("SHGetPathFromIDListW")
	procCoTaskMemFree        = ole32.NewProc("CoTaskMemFree")
	procCoInitializeEx       = ole32.NewProc("CoInitializeEx")
	procCoUninitialize       = ole32.NewProc("CoUninitialize")
	procCoCreateInstance     = ole32.NewProc("CoCreateInstance")
)

type winGUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var (
	clsidFileOpenDialog = winGUID{0xDC1C5A9C, 0xE88A, 0x4DDE, [8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7}}
	iidIFileOpenDialog  = winGUID{0xD57C7288, 0xD4AD, 0x4768, [8]byte{0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60}}
)

const (
	clsctxInprocServer = 0x1
	fosPickFolders     = 0x00000020
	fosForceFileSystem = 0x00000040
	fosAllowMulti      = 0x00000200
	fosPathMustExist   = 0x00000800
	fosFileMustExist   = 0x00001000
	sigdnFileSysPath   = 0x80058000
	coinitApartment    = 0x2
)

func hresultFailed(hr uintptr) bool { return uint32(hr)&0x80000000 != 0 }

func comCall(obj unsafe.Pointer, slot uintptr, args ...uintptr) uintptr {
	if obj == nil {
		return ^uintptr(0)
	}
	vt := *(*unsafe.Pointer)(obj)
	fn := *(*uintptr)(unsafe.Add(vt, slot*unsafe.Sizeof(uintptr(0))))
	argv := make([]uintptr, 0, len(args)+2)
	argv = append(argv, fn, uintptr(obj))
	argv = append(argv, args...)
	r1, _, _ := syscall.SyscallN(argv[0], argv[1:]...)
	return r1
}

func comRelease(obj unsafe.Pointer) {
	if obj != nil {
		_ = comCall(obj, 2)
	}
}

func shellItemPath(item unsafe.Pointer) string {
	if item == nil {
		return ""
	}
	var p *uint16
	hr := comCall(item, 5, sigdnFileSysPath, uintptr(unsafe.Pointer(&p))) // IShellItem::GetDisplayName
	if hresultFailed(hr) || p == nil {
		return ""
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
	return syscall.UTF16ToString((*[1 << 20]uint16)(unsafe.Pointer(p))[:])
}

func withFileOpenDialog(options uint32, title string, multi bool) ([]string, bool) {
	hr, _, _ := procCoInitializeEx.Call(0, coinitApartment)
	if hr == 0 || hr == 1 {
		defer procCoUninitialize.Call()
	}
	var dlg unsafe.Pointer
	hr, _, _ = procCoCreateInstance.Call(
		uintptr(unsafe.Pointer(&clsidFileOpenDialog)), 0, clsctxInprocServer,
		uintptr(unsafe.Pointer(&iidIFileOpenDialog)), uintptr(unsafe.Pointer(&dlg)),
	)
	if hresultFailed(hr) || dlg == nil {
		return nil, false
	}
	defer comRelease(dlg)

	var old uint32
	if !hresultFailed(comCall(dlg, 10, uintptr(unsafe.Pointer(&old)))) { // GetOptions
		options |= old
	}
	_ = comCall(dlg, 9, uintptr(options)) // SetOptions
	if title != "" {
		t := utf16Ptr(title)
		_ = comCall(dlg, 17, uintptr(unsafe.Pointer(t))) // SetTitle
	}
	show := comCall(dlg, 3, 0) // Show
	if hresultFailed(show) {
		return nil, true // includes user cancel
	}

	if multi {
		var arr unsafe.Pointer
		if hresultFailed(comCall(dlg, 27, uintptr(unsafe.Pointer(&arr)))) || arr == nil { // IFileOpenDialog::GetResults
			return nil, true
		}
		defer comRelease(arr)
		var count uint32
		if hresultFailed(comCall(arr, 7, uintptr(unsafe.Pointer(&count)))) { // IShellItemArray::GetCount
			return nil, true
		}
		out := make([]string, 0, count)
		for i := uint32(0); i < count; i++ {
			var item unsafe.Pointer
			if !hresultFailed(comCall(arr, 8, uintptr(i), uintptr(unsafe.Pointer(&item)))) && item != nil { // GetItemAt
				p := shellItemPath(item)
				comRelease(item)
				if p != "" {
					out = append(out, p)
				}
			}
		}
		return out, true
	}
	var item unsafe.Pointer
	if hresultFailed(comCall(dlg, 20, uintptr(unsafe.Pointer(&item)))) || item == nil { // IFileDialog::GetResult
		return nil, true
	}
	p := shellItemPath(item)
	comRelease(item)
	if p == "" {
		return nil, true
	}
	return []string{p}, true
}

func utf16Ptr(s string) *uint16 {
	p, _ := syscall.UTF16PtrFromString(s)
	return p
}

func selectJSONFiles() ([]string, error) {
	// Modern IFileOpenDialog is Per-Monitor-DPI aware and stays crisp at Windows
	// 125/150/200% scaling. Filter by extension after selection; this avoids a
	// legacy common-dialog fallback being the normal path.
	if paths, ok := withFileOpenDialog(fosForceFileSystem|fosAllowMulti|fosFileMustExist|fosPathMustExist, "选择 Telegram Desktop 导出的 result.json（可多选）", true); ok {
		var out []string
		for _, p := range paths {
			if stringsEqualFold(filepath.Ext(p), ".json") {
				out = append(out, p)
			}
		}
		return out, nil
	}
	return legacySelectJSONFiles()
}

func selectFolder(title, initial string) (string, error) {
	if paths, ok := withFileOpenDialog(fosPickFolders|fosForceFileSystem|fosPathMustExist, title, false); ok {
		if len(paths) > 0 {
			return paths[0], nil
		}
		return "", nil
	}
	return legacySelectFolder(title, initial)
}

func stringsEqualFold(a, b string) bool {
	if len(a) != len(b) {
		// ASCII extensions only; avoid pulling more dependencies into the native dialog layer.
		return false
	}
	for i := range a {
		x, y := a[i], b[i]
		if x >= 'A' && x <= 'Z' {
			x += 'a' - 'A'
		}
		if y >= 'A' && y <= 'Z' {
			y += 'a' - 'A'
		}
		if x != y {
			return false
		}
	}
	return true
}

// Legacy fallbacks are retained for unusual Windows builds where the modern
// Shell COM dialog cannot be created.
type openFileNameW struct {
	StructSize                   uint32
	HwndOwner, HInstance         uintptr
	Filter, CustomFilter         *uint16
	MaxCustomFilter, FilterIndex uint32
	File                         *uint16
	MaxFile                      uint32
	FileTitle                    *uint16
	MaxFileTitle                 uint32
	InitialDir, Title            *uint16
	Flags                        uint32
	FileOffset, FileExtension    uint16
	DefExt                       *uint16
	CustData, Hook               uintptr
	TemplateName                 *uint16
	Reserved                     uintptr
	Reserved2, FlagsEx           uint32
}
type browseInfoW struct {
	HwndOwner, PidlRoot uintptr
	DisplayName, Title  *uint16
	Flags               uint32
	Callback, LParam    uintptr
	Image               int32
}

const (
	ofnExplorer       = 0x00080000
	ofnAllowMulti     = 0x00000200
	ofnFileMustExist  = 0x00001000
	ofnPathMustExist  = 0x00000800
	ofnNoChangeDir    = 0x00000008
	bifReturnOnlyFS   = 0x0001
	bifNewDialogStyle = 0x0040
	bifEditBox        = 0x0010
)

func utf16z(s string) []uint16 { r := utf16.Encode([]rune(s)); return append(r, 0) }
func filterUTF16() []uint16 {
	return utf16.Encode([]rune("Telegram result.json\x00result.json\x00JSON 文件 (*.json)\x00*.json\x00所有文件 (*.*)\x00*.*\x00\x00"))
}
func splitUTF16Multi(buf []uint16) []string {
	var parts []string
	start := 0
	for i, v := range buf {
		if v != 0 {
			continue
		}
		if i == start {
			break
		}
		parts = append(parts, string(utf16.Decode(buf[start:i])))
		start = i + 1
	}
	return parts
}
func legacySelectJSONFiles() ([]string, error) {
	fileBuf := make([]uint16, 64*1024)
	title := utf16z("选择 Telegram Desktop 导出的 result.json（可多选）")
	filter := filterUTF16()
	ofn := openFileNameW{StructSize: uint32(unsafe.Sizeof(openFileNameW{})), Filter: &filter[0], FilterIndex: 1, File: &fileBuf[0], MaxFile: uint32(len(fileBuf)), Title: &title[0], Flags: ofnExplorer | ofnAllowMulti | ofnFileMustExist | ofnPathMustExist | ofnNoChangeDir}
	r, _, _ := procGetOpenFileNameW.Call(uintptr(unsafe.Pointer(&ofn)))
	if r == 0 {
		return nil, nil
	}
	parts := splitUTF16Multi(fileBuf)
	if len(parts) == 0 {
		return nil, nil
	}
	if len(parts) == 1 {
		return []string{parts[0]}, nil
	}
	dir := parts[0]
	out := make([]string, 0, len(parts)-1)
	for _, n := range parts[1:] {
		out = append(out, filepath.Join(dir, n))
	}
	return out, nil
}
func legacySelectFolder(title, initial string) (string, error) {
	hr, _, _ := procCoInitializeEx.Call(0, coinitApartment)
	if hr == 0 || hr == 1 {
		defer procCoUninitialize.Call()
	}
	display := make([]uint16, 32768)
	t := utf16z(title)
	bi := browseInfoW{DisplayName: &display[0], Title: &t[0], Flags: bifReturnOnlyFS | bifNewDialogStyle | bifEditBox}
	pidl, _, _ := procSHBrowseForFolderW.Call(uintptr(unsafe.Pointer(&bi)))
	if pidl == 0 {
		return "", nil
	}
	defer procCoTaskMemFree.Call(pidl)
	path := make([]uint16, 32768)
	ok, _, _ := procSHGetPathFromIDListW.Call(pidl, uintptr(unsafe.Pointer(&path[0])))
	if ok == 0 {
		return "", nil
	}
	for i, v := range path {
		if v == 0 {
			return string(utf16.Decode(path[:i])), nil
		}
	}
	return string(utf16.Decode(path)), nil
}
