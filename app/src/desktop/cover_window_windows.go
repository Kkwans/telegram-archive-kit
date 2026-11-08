package main

import (
	"bytes"
	"encoding/base64"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
)

// A native cover window hides the frames where WebView2 still presents the old
// surface at the old size after the OS window has already grown. An in-page
// fixed overlay cannot paint outside the WebView texture, so the exposed strip
// would show the Mica base colour; this window covers the whole monitor with
// the same blurred frame until Chromium commits the resized surface.

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")
	gdi32    = windows.NewLazySystemDLL("gdi32.dll")

	procRegisterClassExW   = user32.NewProc("RegisterClassExW")
	procCreateWindowExW    = user32.NewProc("CreateWindowExW")
	procDefWindowProcW     = user32.NewProc("DefWindowProcW")
	procDestroyWindow      = user32.NewProc("DestroyWindow")
	procShowWindow         = user32.NewProc("ShowWindow")
	procSetWindowPos       = user32.NewProc("SetWindowPos")
	procBeginPaint         = user32.NewProc("BeginPaint")
	procEndPaint           = user32.NewProc("EndPaint")
	procGetClientRect      = user32.NewProc("GetClientRect")
	procInvalidateRect     = user32.NewProc("InvalidateRect")
	procGetDC              = user32.NewProc("GetDC")
	procReleaseDC          = user32.NewProc("ReleaseDC")
	procGetDpiForWindow    = user32.NewProc("GetDpiForWindow")
	procGetModuleHandleW   = kernel32.NewProc("GetModuleHandleW")
	procCreateSolidBrush   = gdi32.NewProc("CreateSolidBrush")
	procCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection   = gdi32.NewProc("CreateDIBSection")
	procSelectObject       = gdi32.NewProc("SelectObject")
	procDeleteObject       = gdi32.NewProc("DeleteObject")
	procDeleteDC           = gdi32.NewProc("DeleteDC")
	procSetStretchBltMode  = gdi32.NewProc("SetStretchBltMode")
	procStretchBlt         = gdi32.NewProc("StretchBlt")
	procSetLayeredAttrs    = user32.NewProc("SetLayeredWindowAttributes")
)

const (
	wsPopup        = 0x80000000
	wsExTopmost    = 0x00000008
	wsExToolWindow = 0x00000080
	wsExLayered    = 0x00080000
	wsExNoActivate = 0x08000000
	swpNoActivate  = 0x0010
	swpShowWindow  = 0x0040
	hwndTopmost    = ^uintptr(0) // -1
	swHide         = 0
	wmPaint        = 0x000F
	wmEraseBkgnd   = 0x0014
	halftone       = 4
	srcCopy        = 0x00CC0020
	biRGB          = 0
	dibRGBColors   = 0
	lwaAlpha       = 0x00000002
	coverClassName = "TAKFullscreenCover"
)

type winRect struct {
	Left, Top, Right, Bottom int32
}

type paintStruct struct {
	Hdc         uintptr
	FErase      int32
	RcPaint     winRect
	FRestore    int32
	FIncUpdate  int32
	RgbReserved [32]byte
}

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     windows.Handle
}

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

type bitmapInfo struct {
	Header bitmapInfoHeader
	Colors [1]uint32
}

var (
	coverMu    sync.Mutex
	coverHWND  uintptr
	coverMemDC uintptr
	coverDIB   uintptr
	coverBmpW  int
	coverBmpH  int
	coverProc  = syscall.NewCallback(coverWndProc)
	coverFade  atomic.Int64
)

func coverWndProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	switch msg {
	case wmEraseBkgnd:
		return 1
	case wmPaint:
		var ps paintStruct
		hdc, _, _ := procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		if hdc != 0 {
			coverMu.Lock()
			mem, bw, bh := coverMemDC, coverBmpW, coverBmpH
			if mem != 0 && bw > 0 && bh > 0 {
				var rc winRect
				procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rc)))
				procSetStretchBltMode.Call(hdc, halftone)
				procStretchBlt.Call(hdc, 0, 0, uintptr(rc.Right-rc.Left), uintptr(rc.Bottom-rc.Top), mem, 0, 0, uintptr(bw), uintptr(bh), srcCopy)
			}
			coverMu.Unlock()
			procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		}
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, msg, wparam, lparam)
	return r
}

func ensureCoverWindow() uintptr {
	if coverHWND != 0 {
		return coverHWND
	}
	instance, _, _ := procGetModuleHandleW.Call(0)
	class, _ := windows.UTF16PtrFromString(coverClassName)
	title, _ := windows.UTF16PtrFromString("")
	brush, _, _ := procCreateSolidBrush.Call(0x00130f0b)
	wc := wndClassEx{
		Size:       uint32(unsafe.Sizeof(wndClassEx{})),
		WndProc:    coverProc,
		Instance:   windows.Handle(instance),
		Background: windows.Handle(brush),
		ClassName:  class,
	}
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	hwnd, _, _ := procCreateWindowExW.Call(
		wsExTopmost|wsExToolWindow|wsExNoActivate|wsExLayered,
		uintptr(unsafe.Pointer(class)),
		uintptr(unsafe.Pointer(title)),
		wsPopup,
		0, 0, 0, 0,
		0, 0, instance, 0,
	)
	coverHWND = hwnd
	return hwnd
}

func decodeCoverImage(dataURL string) (int, int, []byte, error) {
	comma := strings.IndexByte(dataURL, ',')
	if comma < 0 {
		return 0, 0, nil, errCoverImage
	}
	raw, err := base64.StdEncoding.DecodeString(dataURL[comma+1:])
	if err != nil {
		return 0, 0, nil, err
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return 0, 0, nil, err
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return 0, 0, nil, errCoverImage
	}
	pix := make([]byte, w*h*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			r, g, bl, _ := img.At(b.Min.X+x, b.Min.Y+y).RGBA()
			o := (y*w + x) * 4
			pix[o] = byte(bl >> 8)
			pix[o+1] = byte(g >> 8)
			pix[o+2] = byte(r >> 8)
			pix[o+3] = 255
		}
	}
	return w, h, pix, nil
}

func setCoverBitmap(w, h int, pix []byte) {
	dc, _, _ := procGetDC.Call(0)
	if dc == 0 {
		return
	}
	mem, _, _ := procCreateCompatibleDC.Call(dc)
	var bmi bitmapInfo
	bmi.Header.Size = uint32(unsafe.Sizeof(bmi.Header))
	bmi.Header.Width = int32(w)
	bmi.Header.Height = -int32(h)
	bmi.Header.Planes = 1
	bmi.Header.BitCount = 32
	bmi.Header.Compression = biRGB
	var bits unsafe.Pointer
	dib, _, _ := procCreateDIBSection.Call(dc, uintptr(unsafe.Pointer(&bmi)), dibRGBColors, uintptr(unsafe.Pointer(&bits)), 0, 0)
	procReleaseDC.Call(0, dc)
	if mem == 0 || dib == 0 || bits == nil {
		if mem != 0 {
			procDeleteDC.Call(mem)
		}
		if dib != 0 {
			procDeleteObject.Call(dib)
		}
		return
	}
	procSelectObject.Call(mem, dib)
	copy(unsafe.Slice((*byte)(bits), len(pix)), pix)

	coverMu.Lock()
	oldDC, oldDIB := coverMemDC, coverDIB
	coverMemDC, coverDIB = mem, dib
	coverBmpW, coverBmpH = w, h
	coverMu.Unlock()
	if oldDC != 0 {
		procDeleteDC.Call(oldDC)
	}
	if oldDIB != 0 {
		procDeleteObject.Call(oldDIB)
	}
}

func showCoverWindow() {
	hwnd := ensureCoverWindow()
	if hwnd == 0 {
		return
	}
	screen := application.Get().Screen.GetPrimary()
	if screen == nil {
		return
	}
	dpi, _, _ := procGetDpiForWindow.Call(hwnd)
	if dpi == 0 {
		dpi = 96
	}
	scale := float64(dpi) / 96
	x := int32(math.Round(float64(screen.Bounds.X) * scale))
	y := int32(math.Round(float64(screen.Bounds.Y) * scale))
	w := int32(math.Round(float64(screen.Bounds.Width) * scale))
	h := int32(math.Round(float64(screen.Bounds.Height) * scale))
	procSetWindowPos.Call(hwnd, hwndTopmost, uintptr(x), uintptr(y), uintptr(w), uintptr(h), swpNoActivate|swpShowWindow)
	procSetLayeredAttrs.Call(hwnd, 0, 255, lwaAlpha)
	procInvalidateRect.Call(hwnd, 0, 0)
}

// showFsCover paints dataURL over the primary monitor before the window is
// resized. It must run on the Wails main thread, which owns the message loop
// that dispatches the cover window's paint messages.
func showFsCover(dataURL string) bool {
	if dataURL == "" {
		return false
	}
	w, h, pix, err := decodeCoverImage(dataURL)
	if err != nil {
		return false
	}
	coverFade.Add(1) // cancel a fade that may still be running
	application.InvokeSync(func() {
		setCoverBitmap(w, h, pix)
		showCoverWindow()
	})
	return true
}

// hideFsCover removes the cover. A non-zero fadeMs cross-fades the native
// window into the page-owned cover, which is what makes the exit hand-off
// invisible: both surfaces show the same blurred frame at the same geometry.
func hideFsCover(fadeMs int) {
	gen := coverFade.Add(1)
	var hwnd uintptr
	application.InvokeSync(func() {
		hwnd = coverHWND
		if hwnd != 0 {
			procSetLayeredAttrs.Call(hwnd, 0, 255, lwaAlpha)
		}
	})
	if hwnd == 0 {
		return
	}
	if fadeMs <= 0 {
		application.InvokeSync(func() {
			if coverHWND == hwnd {
				procShowWindow.Call(hwnd, swHide)
				procSetLayeredAttrs.Call(hwnd, 0, 255, lwaAlpha)
			}
		})
		return
	}
	go func() {
		duration := time.Duration(fadeMs) * time.Millisecond
		started := time.Now()
		for {
			if coverFade.Load() != gen {
				return
			}
			elapsed := time.Since(started)
			if elapsed >= duration {
				break
			}
			alpha := uintptr(math.Round(255 * (1 - float64(elapsed)/float64(duration))))
			procSetLayeredAttrs.Call(hwnd, 0, alpha, lwaAlpha)
			time.Sleep(16 * time.Millisecond)
		}
		if coverFade.Load() != gen {
			return
		}
		application.InvokeSync(func() {
			if coverHWND != hwnd {
				return
			}
			procShowWindow.Call(hwnd, swHide)
			procSetLayeredAttrs.Call(hwnd, 0, 255, lwaAlpha)
		})
	}()
}

type coverError string

func (e coverError) Error() string { return string(e) }

const errCoverImage = coverError("cover image is empty")
