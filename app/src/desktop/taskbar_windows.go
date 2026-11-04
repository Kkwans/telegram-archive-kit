//go:build windows

package main

import (
	"sync"
	"syscall"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"

	takapp "telegramarchivekit/internal/app"
)

// Minimal ITaskbarList3 binding: the taskbar progress needs COM vtable calls,
// and Wails v3 has no wrapper for them.

type comGUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var (
	clsidTaskbarList = comGUID{0x56FDF344, 0xFD6D, 0x11d0, [8]byte{0x95, 0x8A, 0x00, 0x60, 0x97, 0xC9, 0xA0, 0x90}}
	iidTaskbarList3  = comGUID{0xEA1AFB91, 0x9E28, 0x4B86, [8]byte{0x90, 0xE9, 0xE3, 0x99, 0xC7, 0x93, 0xF4, 0x60}}

	ole32Once sync.Once
	ole32DLL  = syscall.NewLazyDLL("ole32.dll")
	coInit    = ole32DLL.NewProc("CoInitializeEx")
	coCreate  = ole32DLL.NewProc("CoCreateInstance")
)

const (
	tbpNoProgress    = 0x0
	tbpIndeterminate = 0x1
	tbpNormal        = 0x2
)

type taskbarCom struct {
	ptr unsafe.Pointer
}

var (
	taskbarMu   sync.Mutex
	taskbarInst *taskbarCom
)

func taskbarInstance() *taskbarCom {
	ole32Once.Do(func() {
		_, _, _ = coInit.Call(0, 0x2) // COINIT_APARTMENTTHREADED
	})
	taskbarMu.Lock()
	defer taskbarMu.Unlock()
	if taskbarInst != nil {
		return taskbarInst
	}
	var ptr unsafe.Pointer
	hr, _, _ := coCreate.Call(
		uintptr(unsafe.Pointer(&clsidTaskbarList)),
		0,
		1, // CLSCTX_INPROC_SERVER
		uintptr(unsafe.Pointer(&iidTaskbarList3)),
		uintptr(unsafe.Pointer(&ptr)),
	)
	if int32(hr) < 0 || ptr == nil {
		return nil
	}
	t := &taskbarCom{ptr: ptr}
	if t.call(3) != 0 { // ITaskbarList::HrInit
		t.release()
		return nil
	}
	taskbarInst = t
	return t
}

func (t *taskbarCom) call(index int, args ...uintptr) uintptr {
	vtable := *(*unsafe.Pointer)(t.ptr)
	fn := *(*uintptr)(unsafe.Pointer(uintptr(vtable) + uintptr(index)*unsafe.Sizeof(uintptr(0))))
	callArgs := append([]uintptr{uintptr(t.ptr)}, args...)
	r, _, _ := syscall.SyscallN(fn, callArgs...)
	return r
}

func (t *taskbarCom) setState(hwnd uintptr, state uint32) {
	t.call(10, hwnd, uintptr(state))
}

func (t *taskbarCom) setProgress(hwnd uintptr, completed, total uint64) {
	t.call(9, hwnd, uintptr(completed), uintptr(total))
}

func (t *taskbarCom) release() {
	if t.ptr != nil {
		t.call(2)
		t.ptr = nil
	}
}

// updateTaskbar mirrors downloads into the Windows taskbar button.
func (b *Bridge) updateTaskbar(st takapp.DesktopState) {
	if b.window == nil {
		return
	}
	hwnd := uintptr(b.window.NativeWindow())
	if hwnd == 0 {
		return
	}
	active := st.Running
	percent := 0.0
	indeterminate := false
	if st.Download != nil {
		active = active || st.Download.Total > 0 && st.Download.State != "done"
		percent = st.Download.Percent
		if st.Download.Total == 0 {
			indeterminate = true
		}
	} else if st.Operation != nil && st.Operation.Total > 0 {
		active = active || st.Running
		percent = float64(st.Operation.Current) * 100 / float64(st.Operation.Total)
	}
	if !active {
		percent = 0
	}
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	application.InvokeSync(func() {
		t := taskbarInstance()
		if t == nil {
			return
		}
		switch {
		case !active:
			t.setState(hwnd, tbpNoProgress)
		case indeterminate:
			t.setState(hwnd, tbpIndeterminate)
		default:
			t.setState(hwnd, tbpNormal)
			t.setProgress(hwnd, uint64(percent*10), 1000)
		}
	})
}
