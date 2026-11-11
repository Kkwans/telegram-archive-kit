package main

import (
	"bytes"
	"encoding/base64"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"log"
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
	procBitBlt             = gdi32.NewProc("BitBlt")
	procSetLayeredAttrs    = user32.NewProc("SetLayeredWindowAttributes")
	procCreateRoundRectRgn = gdi32.NewProc("CreateRoundRectRgn")
	procSelectClipRgn      = gdi32.NewProc("SelectClipRgn")
	procUpdateLayered      = user32.NewProc("UpdateLayeredWindow")
)

const (
	wsPopup          = 0x80000000
	wsExTopmost      = 0x00000008
	wsExToolWindow   = 0x00000080
	wsExLayered      = 0x00080000
	wsExNoActivate   = 0x08000000
	swpNoActivate    = 0x0010
	swpShowWindow    = 0x0040
	swpNoMove        = 0x0002
	swpNoSize        = 0x0001
	hwndTopmost      = ^uintptr(0) // -1
	swHide           = 0
	swShowNoActivate = 8
	wmPaint          = 0x000F
	wmEraseBkgnd     = 0x0014
	halftone         = 4
	srcCopy          = 0x00CC0020
	biRGB            = 0
	dibRGBColors     = 0
	lwaAlpha         = 0x00000002
	coverClassName   = "TAKFullscreenCover"
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

type coverPoint struct {
	X, Y int32
}

type coverSize struct {
	CX, CY int32
}

type blendFunction struct {
	BlendOp             byte
	BlendFlags          byte
	SourceConstantAlpha byte
	AlphaFormat         byte
}

// coverRect uses physical screen pixels relative to the primary monitor.
type coverRect struct {
	X, Y, W, H int32
}

func (r coverRect) valid() bool { return r.W > 2 && r.H > 2 }

var (
	coverMu      sync.Mutex
	coverHWND    uintptr
	coverMemDC   uintptr
	coverDIB     uintptr
	coverBmpW    int
	coverBmpH    int
	coverProc    = syscall.NewCallback(coverWndProc)
	coverFade    atomic.Int64
	coverVisible atomic.Bool

	coverSharpDC  uintptr
	coverSharpDIB uintptr
	coverSharpW   int
	coverSharpH   int

	coverFrom      coverRect
	coverTo        coverRect
	coverRadius    int32
	coverAnimStart time.Time
	coverAnimDur   time.Duration
	coverAnimating bool
	coverAnimGen   atomic.Int64
	coverAlpha     atomic.Int32

	coverComposeDC   uintptr
	coverComposeDIB  uintptr
	coverComposeW    int
	coverComposeH    int
	coverBackdropDC  uintptr
	coverBackdropDIB uintptr
	coverBackdropW   int
	coverBackdropH   int
)

// ensureCoverCompose returns a memory DC backed by a DIB the size of the cover
// client. The whole frame is composed there and copied to the window in one
// BitBlt, so DWM never composites the blurred background without the sharp
// media frame while the animation is running.
func ensureCoverCompose(w, h int) uintptr {
	if w <= 0 || h <= 0 {
		return 0
	}
	if coverComposeDC != 0 && coverComposeW == w && coverComposeH == h {
		return coverComposeDC
	}
	if coverComposeDC != 0 {
		procDeleteDC.Call(coverComposeDC)
		coverComposeDC = 0
	}
	if coverComposeDIB != 0 {
		procDeleteObject.Call(coverComposeDIB)
		coverComposeDIB = 0
	}
	mem, dib := buildCoverDIB(w, h, nil)
	if mem == 0 {
		return 0
	}
	coverComposeDC, coverComposeDIB = mem, dib
	coverComposeW, coverComposeH = w, h
	return mem
}

// The blur does not move during the zoom. Scale it once per transition and
// copy it into the frame buffer before drawing the moving sharp image.
func resetCoverBackdrop() {
	if coverBackdropDC != 0 {
		procDeleteDC.Call(coverBackdropDC)
		procDeleteObject.Call(coverBackdropDIB)
		coverBackdropDC, coverBackdropDIB = 0, 0
	}
}

func scaledCoverBackdrop(w, h int32, src uintptr, srcW, srcH int) uintptr {
	if coverBackdropDC != 0 && coverBackdropW == int(w) && coverBackdropH == int(h) {
		return coverBackdropDC
	}
	resetCoverBackdrop()
	mem, dib := buildCoverDIB(int(w), int(h), nil)
	if mem == 0 {
		return 0
	}
	procSetStretchBltMode.Call(mem, halftone)
	if ok, _, _ := procStretchBlt.Call(mem, 0, 0, uintptr(w), uintptr(h), src, 0, 0, uintptr(srcW), uintptr(srcH), srcCopy); ok == 0 {
		procDeleteDC.Call(mem)
		procDeleteObject.Call(dib)
		return 0
	}
	coverBackdropDC, coverBackdropDIB = mem, dib
	coverBackdropW, coverBackdropH = int(w), int(h)
	return mem
}

// paintCover composes the blurred background and the sharp media frame into
// one surface and updates the layered window atomically. GDI painting directly
// to the window could let DWM composite the background before the sharp frame,
// which looked like the media disappeared for a frame.
func paintCover() {
	updateCoverSurface()
}

func updateCoverSurface() bool {
	hwnd := coverHWND
	if hwnd == 0 || !coverVisible.Load() {
		return false
	}
	var rc winRect
	procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rc)))
	cw, ch := rc.Right-rc.Left, rc.Bottom-rc.Top
	compose := ensureCoverCompose(int(cw), int(ch))
	if compose == 0 {
		return false
	}
	coverMu.Lock()
	mem, bw, bh := coverMemDC, coverBmpW, coverBmpH
	sharp, sw, sh := coverSharpDC, coverSharpW, coverSharpH
	from, to, radius := coverFrom, coverTo, coverRadius
	animating, started, duration := coverAnimating, coverAnimStart, coverAnimDur
	coverMu.Unlock()
	if mem == 0 || bw <= 0 || bh <= 0 {
		return false
	}
	procSetStretchBltMode.Call(compose, halftone)
	var copied uintptr
	if bg := scaledCoverBackdrop(cw, ch, mem, bw, bh); bg != 0 {
		copied, _, _ = procBitBlt.Call(compose, 0, 0, uintptr(cw), uintptr(ch), bg, 0, 0, srcCopy)
	}
	if copied == 0 {
		if ok, _, _ := procStretchBlt.Call(compose, 0, 0, uintptr(cw), uintptr(ch), mem, 0, 0, uintptr(bw), uintptr(bh), srcCopy); ok == 0 {
			return false
		}
	}
	if sharp != 0 && sw > 0 && sh > 0 {
		rect := from
		if animating && duration > 0 {
			t := float64(time.Since(started)) / float64(duration)
			if t > 1 {
				t = 1
			}
			ease := 1 - math.Pow(1-t, 3)
			rect = coverRect{
				X: int32(math.Round(float64(from.X) + float64(to.X-from.X)*ease)),
				Y: int32(math.Round(float64(from.Y) + float64(to.Y-from.Y)*ease)),
				W: int32(math.Round(float64(from.W) + float64(to.W-from.W)*ease)),
				H: int32(math.Round(float64(from.H) + float64(to.H-from.H)*ease)),
			}
		}
		if rect.valid() {
			rgn, _, _ := procCreateRoundRectRgn.Call(uintptr(rect.X), uintptr(rect.Y), uintptr(rect.X+rect.W+1), uintptr(rect.Y+rect.H+1), uintptr(radius*2), uintptr(radius*2))
			if rgn != 0 {
				procSelectClipRgn.Call(compose, rgn)
			}
			procStretchBlt.Call(compose, uintptr(rect.X), uintptr(rect.Y), uintptr(rect.W), uintptr(rect.H), sharp, 0, 0, uintptr(sw), uintptr(sh), srcCopy)
			if rgn != 0 {
				procSelectClipRgn.Call(compose, 0)
				procDeleteObject.Call(rgn)
			}
		}
	}
	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return false
	}
	sz := coverSize{CX: int32(cw), CY: int32(ch)}
	src := coverPoint{0, 0}
	// AlphaFormat must stay 0: the composed DIB is fully opaque and GDI does
	// not preserve the alpha byte through StretchBlt, so AC_SRC_ALPHA would
	// make most of the surface transparent and let the WebView show through.
	blend := blendFunction{BlendOp: 0, BlendFlags: 0, SourceConstantAlpha: byte(coverAlpha.Load()), AlphaFormat: 0}
	ok, _, _ := procUpdateLayered.Call(hwnd, screen, 0, uintptr(unsafe.Pointer(&sz)), compose, uintptr(unsafe.Pointer(&src)), 0, uintptr(unsafe.Pointer(&blend)), 2)
	procReleaseDC.Call(0, screen)
	return ok != 0
}

func coverWndProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	switch msg {
	case wmEraseBkgnd:
		return 1
	case wmPaint:
		var ps paintStruct
		hdc, _, _ := procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		if hdc != 0 {
			procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		}
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, msg, wparam, lparam)
	return r
}

func ensureCoverWindow(owner uintptr) uintptr {
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
		owner, 0, instance, 0,
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

func buildCoverDIB(w, h int, pix []byte) (uintptr, uintptr) {
	dc, _, _ := procGetDC.Call(0)
	if dc == 0 {
		return 0, 0
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
		return 0, 0
	}
	procSelectObject.Call(mem, dib)
	if len(pix) > 0 {
		copy(unsafe.Slice((*byte)(bits), len(pix)), pix)
	}
	return mem, dib
}

func setCoverBitmap(w, h int, pix []byte) bool {
	mem, dib := buildCoverDIB(w, h, pix)
	if mem == 0 {
		return false
	}
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
	return true
}

func setSharpBitmap(w, h int, pix []byte) bool {
	var mem, dib uintptr
	if len(pix) > 0 {
		mem, dib = buildCoverDIB(w, h, pix)
		if mem == 0 {
			return false
		}
	}
	coverMu.Lock()
	oldDC, oldDIB := coverSharpDC, coverSharpDIB
	coverSharpDC, coverSharpDIB = mem, dib
	coverSharpW, coverSharpH = w, h
	coverMu.Unlock()
	if oldDC != 0 {
		procDeleteDC.Call(oldDC)
	}
	if oldDIB != 0 {
		procDeleteObject.Call(oldDIB)
	}
	return true
}

func coverDPIScale(hwnd uintptr) float64 {
	dpi, _, _ := procGetDpiForWindow.Call(hwnd)
	if dpi == 0 {
		dpi = 96
	}
	return float64(dpi) / 96
}

func coverRectFromCSS(values []int, scale float64) coverRect {
	if len(values) < 4 {
		return coverRect{}
	}
	return coverRect{
		X: int32(math.Round(float64(values[0]) * scale)),
		Y: int32(math.Round(float64(values[1]) * scale)),
		W: int32(math.Round(float64(values[2]) * scale)),
		H: int32(math.Round(float64(values[3]) * scale)),
	}
}

var flushComposition = dwmapi.NewProc("DwmFlush")

// Wait off the UI thread so a slow composition frame cannot block input.
func waitCoverFrame() {
	started := time.Now()
	hr, _, _ := flushComposition.Call()
	if hr != 0 {
		time.Sleep(8 * time.Millisecond)
	} else if time.Since(started) < time.Millisecond {
		time.Sleep(time.Millisecond)
	}
}

func startCoverTicker(hwnd uintptr, gen int64, duration time.Duration) {
	if hwnd == 0 || duration <= 0 {
		return
	}
	go func() {
		deadline := time.Now().Add(duration)
		for {
			waitCoverFrame()
			done := application.InvokeSyncWithResult(func() bool {
				if coverAnimGen.Load() != gen || coverHWND != hwnd || !coverVisible.Load() {
					return true
				}
				paintCover()
				return !time.Now().Before(deadline)
			})
			if done {
				return
			}
		}
	}()
}

// showFsCoverAnimated paints a blurred full-screen background plus the sharp
// media frame and optionally animates that frame from one screen rect to
// another. Running the zoom in the native cover keeps the media visible while
// the OS window and WebView2 surface are being resized.
func showFsCoverAnimated(owner uintptr, coverURL, sharpURL string, from, to []int, radius, durationMS int) bool {
	if coverURL == "" || sharpURL == "" {
		return false
	}
	bw, bh, bpix, err := decodeCoverImage(coverURL)
	if err != nil {
		log.Printf("cover anim: background decode failed: %v", err)
		return false
	}
	sw, sh, spix, err := decodeCoverImage(sharpURL)
	if err != nil {
		log.Printf("cover anim: sharp decode failed: %v", err)
		return false
	}
	coverFade.Add(1)
	coverAnimGen.Add(1)
	return application.InvokeSyncWithResult(func() bool {
		hwnd := ensureCoverWindow(owner)
		if hwnd == 0 {
			return false
		}
		hideCoverWindow(hwnd)
		if !setCoverBitmap(bw, bh, bpix) || !setSharpBitmap(sw, sh, spix) {
			return false
		}
		coverAlpha.Store(255)
		coverVisible.Store(true)
		placeCoverWindow(hwnd, false)
		scale := coverDPIScale(hwnd)
		cfrom := coverRectFromCSS(from, scale)
		cto := coverRectFromCSS(to, scale)
		coverMu.Lock()
		coverFrom, coverTo = cfrom, cto
		coverRadius = int32(math.Round(float64(radius) * scale))
		coverAnimStart = time.Now()
		coverAnimDur = time.Duration(durationMS) * time.Millisecond
		coverAnimating = durationMS > 0 && cto.valid()
		coverMu.Unlock()
		if !updateCoverSurface() {
			hideCoverWindow(hwnd)
			return false
		}
		procShowWindow.Call(hwnd, swShowNoActivate)
		if durationMS > 0 {
			startCoverTicker(hwnd, coverAnimGen.Load(), coverAnimDur)
		}
		return true
	})
}

// animateFsCover updates the native sharp frame animation without reloading
// the bitmaps; the enter transition measures its final rect after the resize.
func animateFsCover(from, to []int, radius, durationMS int) bool {
	var ok bool
	application.InvokeSync(func() {
		hwnd := coverHWND
		if hwnd == 0 || coverSharpDC == 0 {
			return
		}
		scale := coverDPIScale(hwnd)
		cfrom := coverRectFromCSS(from, scale)
		cto := coverRectFromCSS(to, scale)
		gen := coverAnimGen.Add(1)
		coverMu.Lock()
		coverFrom, coverTo = cfrom, cto
		coverRadius = int32(math.Round(float64(radius) * scale))
		coverAnimStart = time.Now()
		coverAnimDur = time.Duration(durationMS) * time.Millisecond
		coverAnimating = durationMS > 0 && cto.valid()
		coverMu.Unlock()
		paintCover()
		if durationMS > 0 {
			startCoverTicker(hwnd, gen, coverAnimDur)
		}
		ok = true
	})
	return ok
}

// raiseFsCover keeps the cover above the main window after the main window is
// switched to topmost.
func raiseFsCover() {
	application.InvokeSync(func() {
		if coverHWND != 0 && coverVisible.Load() {
			procSetWindowPos.Call(coverHWND, hwndTopmost, 0, 0, 0, 0, swpNoActivate|swpNoMove|swpNoSize|swpShowWindow)
			paintCover()
		}
	})
}

// placeCoverWindow positions and sizes the cover to the primary monitor. The
// caller paints the fresh frame before showing it: a layered window keeps its
// last surface while hidden, and showing it first would flash the previous
// video's cover for a frame when entering fullscreen on a new item.
func placeCoverWindow(hwnd uintptr, show bool) {
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
	flags := uintptr(swpNoActivate)
	if show {
		flags |= swpShowWindow
	}
	procSetWindowPos.Call(hwnd, hwndTopmost, uintptr(x), uintptr(y), uintptr(w), uintptr(h), flags)
}

func hideCoverWindow(hwnd uintptr) {
	procShowWindow.Call(hwnd, swHide)
	coverVisible.Store(false)
	coverAlpha.Store(255)
	resetCoverBackdrop()
}

// showFsCover paints dataURL over the primary monitor before the window is
// resized. It must run on the Wails main thread, which owns the message loop
// that dispatches the cover window's paint messages.
func showFsCover(owner uintptr, dataURL string) bool {
	if dataURL == "" {
		return false
	}
	w, h, pix, err := decodeCoverImage(dataURL)
	if err != nil {
		return false
	}
	coverFade.Add(1) // cancel a fade that may still be running
	coverAnimGen.Add(1)
	return application.InvokeSyncWithResult(func() bool {
		hwnd := ensureCoverWindow(owner)
		if hwnd == 0 {
			return false
		}
		hideCoverWindow(hwnd)
		setSharpBitmap(0, 0, nil)
		if !setCoverBitmap(w, h, pix) {
			return false
		}
		coverAlpha.Store(255)
		coverVisible.Store(true)
		placeCoverWindow(hwnd, false)
		if !updateCoverSurface() {
			hideCoverWindow(hwnd)
			return false
		}
		procShowWindow.Call(hwnd, swShowNoActivate)
		return true
	})
}

// hideFsCover signals when the cover is hidden or superseded. This allows the
// WebView to keep its still frame until the native layer actually withdraws.
func hideFsCover(fadeMs int, afterHide func()) <-chan struct{} {
	done := make(chan struct{})
	coverAnimGen.Add(1)
	gen := coverFade.Add(1)
	var hwnd uintptr
	application.InvokeSync(func() {
		hwnd = coverHWND
	})
	if hwnd == 0 {
		application.InvokeSync(afterHide)
		close(done)
		return done
	}
	finish := func() {
		if coverHWND == hwnd && coverFade.Load() == gen {
			hideCoverWindow(hwnd)
			afterHide()
		}
	}
	if fadeMs <= 0 {
		application.InvokeSync(finish)
		close(done)
		return done
	}
	go func() {
		defer close(done)
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
			alpha := int32(math.Round(255 * (1 - float64(elapsed)/float64(duration))))
			application.InvokeSync(func() {
				if coverFade.Load() == gen {
					coverAlpha.Store(alpha)
					paintCover()
				}
			})
			waitCoverFrame()
		}
		application.InvokeSync(finish)
	}()
	return done
}

type coverError string

func (e coverError) Error() string { return string(e) }

const errCoverImage = coverError("cover image is empty")
