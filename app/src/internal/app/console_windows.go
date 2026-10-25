//go:build windows

package app

import (
	"syscall"
	"time"
	"unsafe"
)

var (
	user32                      = syscall.NewLazyDLL("user32.dll")
	procSetProcessDpiAwareness  = user32.NewProc("SetProcessDpiAwarenessContext")
	kernel32                    = syscall.NewLazyDLL("kernel32.dll")
	procGetStdHandle            = kernel32.NewProc("GetStdHandle")
	procGetConsoleMode          = kernel32.NewProc("GetConsoleMode")
	procSetConsoleMode          = kernel32.NewProc("SetConsoleMode")
	procSetConsoleOutputCP      = kernel32.NewProc("SetConsoleOutputCP")
	procSetConsoleCP            = kernel32.NewProc("SetConsoleCP")
	procReadConsoleInputW       = kernel32.NewProc("ReadConsoleInputW")
	procFlushConsoleInputBuffer = kernel32.NewProc("FlushConsoleInputBuffer")
	procWaitForSingleObject     = kernel32.NewProc("WaitForSingleObject")
)

const (
	stdInputHandle                  = ^uintptr(9)  // -10
	stdOutputHandle                 = ^uintptr(10) // -11
	keyEventType                    = 0x0001
	waitObject0                     = 0x00000000
	waitTimeout                     = 0x00000102
	infinite                        = 0xFFFFFFFF
	leftAltPressed                  = 0x0002
	rightAltPressed                 = 0x0001
	leftCtrlPressed                 = 0x0008
	rightCtrlPressed                = 0x0004
	shiftPressed                    = 0x0010
	enableVirtualTerminalProcessing = 0x0004
)

type keyEventRecord struct {
	KeyDown         int32
	RepeatCount     uint16
	VirtualKeyCode  uint16
	VirtualScanCode uint16
	UnicodeChar     uint16
	ControlKeyState uint32
}

type inputRecord struct {
	EventType uint16
	Padding   uint16
	Event     [16]byte
}

func stdHandle(which uintptr) syscall.Handle {
	r, _, _ := procGetStdHandle.Call(which)
	return syscall.Handle(r)
}

func enablePerMonitorDPI() {
	// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == (HANDLE)-4.
	// Set it before any common dialog is created so Windows 150%/200% scaling
	// renders file/folder pickers at native resolution instead of bitmap scaling.
	const dpiPerMonitorV2 = ^uintptr(3)
	_, _, _ = procSetProcessDpiAwareness.Call(dpiPerMonitorV2)
}

func terminalInit() {
	_, _, _ = procSetConsoleOutputCP.Call(65001)
	_, _, _ = procSetConsoleCP.Call(65001)
	h := stdHandle(stdOutputHandle)
	var mode uint32
	if r, _, _ := procGetConsoleMode.Call(uintptr(h), uintptr(unsafe.Pointer(&mode))); r != 0 {
		_, _, _ = procSetConsoleMode.Call(uintptr(h), uintptr(mode|enableVirtualTerminalProcessing))
	}
}

func readKey() Key {
	for {
		if k, ok := readConsoleKey(infinite); ok {
			return k
		}
	}
}

func pollKey(timeout time.Duration) (Key, bool) {
	ms := uint32(timeout / time.Millisecond)
	if ms == 0 && timeout > 0 {
		ms = 1
	}
	return readConsoleKey(ms)
}

func readConsoleKey(timeoutMS uint32) (Key, bool) {
	h := stdHandle(stdInputHandle)
	wait, _, _ := procWaitForSingleObject.Call(uintptr(h), uintptr(timeoutMS))
	if wait == waitTimeout {
		return Key{}, false
	}
	if wait != waitObject0 {
		return Key{}, false
	}
	for {
		var rec inputRecord
		var read uint32
		r, _, _ := procReadConsoleInputW.Call(uintptr(h), uintptr(unsafe.Pointer(&rec)), 1, uintptr(unsafe.Pointer(&read)))
		if r == 0 || read == 0 {
			return Key{}, false
		}
		if rec.EventType != keyEventType {
			if timeoutMS != infinite {
				return Key{}, false
			}
			continue
		}
		ke := (*keyEventRecord)(unsafe.Pointer(&rec.Event[0]))
		if ke.KeyDown == 0 {
			if timeoutMS != infinite {
				return Key{}, false
			}
			continue
		}
		k := Key{Rune: rune(ke.UnicodeChar), Ctrl: ke.ControlKeyState&(leftCtrlPressed|rightCtrlPressed) != 0, Alt: ke.ControlKeyState&(leftAltPressed|rightAltPressed) != 0, Shift: ke.ControlKeyState&shiftPressed != 0}
		switch ke.VirtualKeyCode {
		case 0x26:
			k.Code = keyUp
		case 0x28:
			k.Code = keyDown
		case 0x25:
			k.Code = keyLeft
		case 0x27:
			k.Code = keyRight
		case 0x0D:
			k.Code = keyEnter
		case 0x1B:
			k.Code = keyEsc
		case 0x24:
			k.Code = keyHome
		case 0x23:
			k.Code = keyEnd
		case 0x21:
			k.Code = keyPageUp
		case 0x22:
			k.Code = keyPageDown
		default:
			k.Code = keyUnknown
		}
		return k, true
	}
}

type coordW struct{ X, Y int16 }
type smallRectW struct{ Left, Top, Right, Bottom int16 }
type consoleScreenBufferInfoW struct {
	Size              coordW
	CursorPosition    coordW
	Attributes        uint16
	Window            smallRectW
	MaximumWindowSize coordW
}

func terminalWidth() int {
	h := stdHandle(stdOutputHandle)
	var info consoleScreenBufferInfoW
	proc := kernel32.NewProc("GetConsoleScreenBufferInfo")
	if r, _, _ := proc.Call(uintptr(h), uintptr(unsafe.Pointer(&info))); r != 0 {
		w := int(info.Window.Right-info.Window.Left) + 1
		if w > 0 {
			return w
		}
	}
	return 100
}

func flushInput() {
	h := stdHandle(stdInputHandle)
	_, _, _ = procFlushConsoleInputBuffer.Call(uintptr(h))
}
