package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	dwmapi                = windows.NewLazySystemDLL("dwmapi.dll")
	dwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
	getWindowLong         = windows.NewLazySystemDLL("user32.dll").NewProc("GetWindowLongW")
	getForegroundWindow   = windows.NewLazySystemDLL("user32.dll").NewProc("GetForegroundWindow")
)

func windowIsTopmost(hwnd uintptr) bool {
	const wsExTopmost = 0x00000008
	style, _, _ := getWindowLong.Call(hwnd, ^uintptr(19)) // GWL_EXSTYLE = -20
	return style&wsExTopmost != 0
}

func raiseActiveFullscreen(hwnd uintptr) {
	if foreground, _, _ := getForegroundWindow.Call(); foreground != hwnd || hwnd == 0 {
		return
	}
	markFullscreen(hwnd, true)
	procSetWindowPos.Call(hwnd, hwndTopmost, 0, 0, 0, 0, swpNoActivate|swpNoMove|swpNoSize)
}

// applyDarkWindowFrame switches the native frame to dark mode so the Mica
// backdrop uses its dark base colour. During a window resize the WebView2
// surface lags a frame or two behind the native window; without this the
// exposed strip shows the light Mica base (#F2F2F2) as a white flash.
func applyDarkWindowFrame(hwnd unsafe.Pointer) (int32, int32) {
	if hwnd == nil {
		return -1, -1
	}
	on := int32(1)
	// 20 is DWMWA_USE_IMMERSIVE_DARK_MODE on Windows 10 2004+ and 11;
	// 19 is the same attribute on builds 17763-19041.
	r1, _, _ := dwmSetWindowAttribute.Call(uintptr(hwnd), 20, uintptr(unsafe.Pointer(&on)), unsafe.Sizeof(on))
	r2, _, _ := dwmSetWindowAttribute.Call(uintptr(hwnd), 19, uintptr(unsafe.Pointer(&on)), unsafe.Sizeof(on))
	return int32(r1), int32(r2)
}
