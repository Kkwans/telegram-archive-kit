package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/png"
	"math"
	"syscall"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/w32"
)

var procPrintWindow = syscall.NewLazyDLL("user32.dll").NewProc("PrintWindow")

// CaptureWindow snapshots the current window for the dialog glass layer. The
// frontend hides the dialog before calling it, so the captured frame contains
// the page that will appear blurred behind the panel.
func (b *Bridge) CaptureWindow() (string, error) {
	if b.window == nil {
		return "", errors.New("窗口尚未就绪")
	}
	native := b.window.NativeWindow()
	if native == nil {
		return "", errors.New("窗口尚未就绪")
	}
	hwnd := w32.HWND(uintptr(native))
	rect := w32.GetWindowRect(hwnd)
	width := int(rect.Right - rect.Left)
	height := int(rect.Bottom - rect.Top)
	if width <= 0 || height <= 0 {
		return "", errors.New("窗口尺寸无效")
	}
	bmi := w32.BITMAPINFO{BmiHeader: w32.BITMAPINFOHEADER{
		BiSize:        uint32(unsafe.Sizeof(w32.BITMAPINFOHEADER{})),
		BiWidth:       int32(width),
		BiHeight:      int32(-height),
		BiPlanes:      1,
		BiBitCount:    32,
		BiCompression: w32.BI_RGB,
		BiSizeImage:   uint32(width * height * 4),
	}}
	var bits unsafe.Pointer
	bitmap := w32.CreateDIBSection(0, &bmi, w32.DIB_RGB_COLORS, &bits, 0, 0)
	if bitmap == 0 || bits == nil {
		return "", errors.New("无法创建截图位图")
	}
	defer w32.DeleteObject(w32.HGDIOBJ(bitmap))
	dc := w32.CreateCompatibleDC(0)
	defer w32.DeleteDC(dc)
	old := w32.SelectObject(dc, w32.HGDIOBJ(bitmap))
	defer w32.SelectObject(dc, old)
	if ret, _, callErr := procPrintWindow.Call(uintptr(hwnd), uintptr(dc), 2); ret == 0 {
		return "", fmt.Errorf("窗口截图失败：%v", callErr)
	}
	raw := unsafe.Slice((*byte)(bits), width*height*4)
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		src := raw[y*width*4 : (y+1)*width*4]
		dst := img.Pix[y*img.Stride:]
		for x := 0; x < width; x++ {
			dst[x*4+0] = src[x*4+2]
			dst[x*4+1] = src[x*4+1]
			dst[x*4+2] = src[x*4+0]
			dst[x*4+3] = 255
		}
	}
	// The glass layer is blurred, so a smaller snapshot is visually identical
	// but much faster to encode and transfer on 2K/4K windows.
	const maxWidth, maxHeight = 1600, 1200
	if width > maxWidth || height > maxHeight {
		scale := math.Min(float64(maxWidth)/float64(width), float64(maxHeight)/float64(height))
		scaledWidth := max(1, int(float64(width)*scale))
		scaledHeight := max(1, int(float64(height)*scale))
		scaled := image.NewRGBA(image.Rect(0, 0, scaledWidth, scaledHeight))
		for y := 0; y < scaledHeight; y++ {
			sourceY := y * height / scaledHeight
			destination := scaled.Pix[y*scaled.Stride:]
			for x := 0; x < scaledWidth; x++ {
				source := img.PixOffset(x*width/scaledWidth, sourceY)
				copy(destination[x*4:x*4+4], img.Pix[source:source+4])
			}
		}
		img = scaled
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}
