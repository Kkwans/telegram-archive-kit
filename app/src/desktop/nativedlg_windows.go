//go:build windows

package main

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Native file/folder pickers. Wails v3's dialog helpers deadlocked when called
// from the bridge's HTTP handler, leaving a frozen blank window and no dialog.
// IFileOpenDialog is driven from a dedicated STA thread instead, which is safe
// regardless of which goroutine handles the RPC.

var (
	ole32Native     = windows.NewLazySystemDLL("ole32.dll")
	user32Native    = windows.NewLazySystemDLL("user32.dll")
	procCoInit      = ole32Native.NewProc("CoInitializeEx")
	procCoUninit    = ole32Native.NewProc("CoUninitialize")
	procCoCreate    = ole32Native.NewProc("CoCreateInstance")
	procCoTaskFree  = ole32Native.NewProc("CoTaskMemFree")
	procMessageBoxW = user32Native.NewProc("MessageBoxW")
	procPeekMessage = user32Native.NewProc("PeekMessageW")
	procGetAncestor = user32Native.NewProc("GetAncestor")

	clsidFileOpenDialog = comGUID{0xDC1C5A9C, 0xE88A, 0x4DDE, [8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7}}
	iidFileOpenDialog   = comGUID{0xD57C7288, 0xD4AD, 0x4768, [8]byte{0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60}}
)

const (
	coinitApartmentThreaded = 0x2
	clsctxInprocServer      = 0x1

	fosPickFolders     = 0x20
	fosForceFilesystem = 0x40
	fosAllowMulti      = 0x200
	fosPathMustExist   = 0x800
	fosFileMustExist   = 0x1000

	sigdnFileSysPath = 0x80058000

	hrCancelled = 0x800704C7
)

type comFilterSpec struct {
	Name *uint16
	Spec *uint16
}

type fileDialogOptions struct {
	Title      string
	FilterName string
	FilterSpec string
	Multiple   bool
	Folder     bool
}

func comCall(obj unsafe.Pointer, index int, args ...uintptr) uintptr {
	vtable := *(*unsafe.Pointer)(obj)
	fn := *(*uintptr)(unsafe.Pointer(uintptr(vtable) + uintptr(index)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{uintptr(obj)}, args...)...)
	return r
}

func comRelease(obj unsafe.Pointer) {
	if obj != nil {
		comCall(obj, 2)
	}
}

// showFileDialog runs the dialog on its own STA thread so it never depends on
// the Wails main loop.
func showFileDialog(owner uintptr, opt fileDialogOptions) ([]string, error) {
	type outcome struct {
		paths []string
		err   error
	}
	ch := make(chan outcome, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		paths, err := runFileDialog(owner, opt)
		ch <- outcome{paths, err}
	}()
	out := <-ch
	return out.paths, out.err
}

func runFileDialog(owner uintptr, opt fileDialogOptions) ([]string, error) {
	hr, _, _ := procCoInit.Call(0, coinitApartmentThreaded)
	if int32(hr) >= 0 || uint32(hr) == 1 {
		defer procCoUninit.Call()
	}
	var dlg unsafe.Pointer
	var msg struct {
		hwnd     uintptr
		message  uint32
		pad      uint32
		wParam   uintptr
		lParam   uintptr
		time     uint32
		x, y     int32
		lPrivate uint32
	}
	procPeekMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 0) // PM_NOREMOVE: force a message queue
	hr, _, _ = procCoCreate.Call(
		uintptr(unsafe.Pointer(&clsidFileOpenDialog)),
		0,
		clsctxInprocServer,
		uintptr(unsafe.Pointer(&iidFileOpenDialog)),
		uintptr(unsafe.Pointer(&dlg)),
	)
	if int32(hr) < 0 || dlg == nil {
		return nil, fmt.Errorf("无法打开文件选择器（0x%x）", uint32(hr))
	}
	defer comRelease(dlg)

	var current uint32
	comCall(dlg, 10, uintptr(unsafe.Pointer(&current)))
	options := current | fosForceFilesystem | fosPathMustExist
	if opt.Folder {
		options |= fosPickFolders
	} else {
		options |= fosFileMustExist
		if opt.Multiple {
			options |= fosAllowMulti
		}
	}
	comCall(dlg, 9, uintptr(options))

	if opt.Title != "" {
		if title, err := windows.UTF16PtrFromString(opt.Title); err == nil {
			comCall(dlg, 17, uintptr(unsafe.Pointer(title)))
		}
	}
	if !opt.Folder && opt.FilterSpec != "" {
		name, e1 := windows.UTF16PtrFromString(opt.FilterName)
		spec, e2 := windows.UTF16PtrFromString(opt.FilterSpec)
		if e1 == nil && e2 == nil {
			filters := []comFilterSpec{{Name: name, Spec: spec}}
			comCall(dlg, 4, 1, uintptr(unsafe.Pointer(&filters[0])))
		}
	}

	hr = comCall(dlg, 3, owner) // Show
	if int32(hr) < 0 {
		if uint32(hr) == hrCancelled {
			return nil, nil
		}
		return nil, fmt.Errorf("文件选择器返回错误（0x%x）", uint32(hr))
	}

	displayName := func(item unsafe.Pointer) string {
		var namePtr *uint16
		if int32(comCall(item, 5, sigdnFileSysPath, uintptr(unsafe.Pointer(&namePtr)))) < 0 || namePtr == nil {
			return ""
		}
		defer procCoTaskFree.Call(uintptr(unsafe.Pointer(namePtr)))
		return windows.UTF16PtrToString(namePtr)
	}

	if !opt.Multiple || opt.Folder {
		var item unsafe.Pointer
		if int32(comCall(dlg, 20, uintptr(unsafe.Pointer(&item)))) < 0 || item == nil {
			return nil, nil
		}
		defer comRelease(item)
		if name := displayName(item); name != "" {
			return []string{name}, nil
		}
		return nil, nil
	}

	var items unsafe.Pointer
	if int32(comCall(dlg, 27, uintptr(unsafe.Pointer(&items)))) < 0 || items == nil {
		return nil, nil
	}
	defer comRelease(items)
	var count uint32
	comCall(items, 7, uintptr(unsafe.Pointer(&count)))
	out := make([]string, 0, count)
	for i := uint32(0); i < count; i++ {
		var item unsafe.Pointer
		if int32(comCall(items, 8, uintptr(i), uintptr(unsafe.Pointer(&item)))) < 0 || item == nil {
			continue
		}
		if name := displayName(item); name != "" {
			out = append(out, name)
		}
		comRelease(item)
	}
	return out, nil
}

// rootOwner resolves the top-level window for dialog ownership.
func rootOwner(w uintptr) uintptr {
	if w == 0 {
		return 0
	}
	if root, _, _ := procGetAncestor.Call(w, 2); root != 0 { // GA_ROOT
		return root
	}
	return w
}

// askHideOrQuit shows a native question; true means hide to tray.
func askHideOrQuit(owner uintptr, message string) bool {
	text, _ := windows.UTF16PtrFromString(message)
	title, _ := windows.UTF16PtrFromString("Telegram Archive Kit")
	const mbYesNo = 0x4
	const mbIconQuestion = 0x20
	const mbSetForeground = 0x10000
	const idYes = 6
	res, _, _ := procMessageBoxW.Call(owner, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), mbYesNo|mbIconQuestion|mbSetForeground)
	return res == idYes
}
