package media

import (
	"context"
	"fmt"
	"image"
	imagecolor "image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"math"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const ThumbMaxSide = 720

// MediaLocalPath resolves a stored media path (relative, absolute or file://)
// against the workspace root.
func MediaLocalPath(workspace, p string) string {
	if strings.HasPrefix(strings.ToLower(p), "file://") {
		if u, err := url.Parse(p); err == nil {
			path := u.Path
			if len(path) >= 3 && path[0] == '/' && path[2] == ':' {
				path = path[1:]
			}
			return filepath.FromSlash(path)
		}
	}
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(workspace, filepath.FromSlash(p))
}

func CreateImageThumbnail(src, dst string, maxSide int) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	img, _, err := image.Decode(f)
	_ = f.Close()
	if err != nil {
		// Windows has no native HEIC/WebP decoder in Go's standard image package.
		// When FFmpeg is available, decode these formats through it instead.
		if FindFFmpeg() != "" {
			return createFFmpegStill(src, dst, false)
		}
		return err
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return fmt.Errorf("invalid image dimensions")
	}
	scale := math.Min(1, float64(maxSide)/float64(max(w, h)))
	nw := max(1, int(math.Round(float64(w)*scale)))
	nh := max(1, int(math.Round(float64(h)*scale)))
	var out image.Image = img
	if nw != w || nh != h {
		out = resizeBilinear(img, nw, nh)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	o, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer o.Close()
	return jpeg.Encode(o, out, &jpeg.Options{Quality: 84})
}

func resizeBilinear(src image.Image, dw, dh int) *image.RGBA {
	sb := src.Bounds()
	sw, sh := sb.Dx(), sb.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	if dw == 1 || dh == 1 || sw == 1 || sh == 1 {
		for y := 0; y < dh; y++ {
			for x := 0; x < dw; x++ {
				sx := sb.Min.X + x*sw/dw
				sy := sb.Min.Y + y*sh/dh
				dst.Set(x, y, src.At(sx, sy))
			}
		}
		return dst
	}
	for y := 0; y < dh; y++ {
		fy := (float64(y)+0.5)*float64(sh)/float64(dh) - 0.5
		y0 := int(math.Floor(fy))
		wy := fy - float64(y0)
		if y0 < 0 {
			y0 = 0
			wy = 0
		}
		y1 := min(y0+1, sh-1)
		for x := 0; x < dw; x++ {
			fx := (float64(x)+0.5)*float64(sw)/float64(dw) - 0.5
			x0 := int(math.Floor(fx))
			wx := fx - float64(x0)
			if x0 < 0 {
				x0 = 0
				wx = 0
			}
			x1 := min(x0+1, sw-1)
			c00 := imagecolor.RGBAModel.Convert(src.At(sb.Min.X+x0, sb.Min.Y+y0)).(imagecolor.RGBA)
			c10 := imagecolor.RGBAModel.Convert(src.At(sb.Min.X+x1, sb.Min.Y+y0)).(imagecolor.RGBA)
			c01 := imagecolor.RGBAModel.Convert(src.At(sb.Min.X+x0, sb.Min.Y+y1)).(imagecolor.RGBA)
			c11 := imagecolor.RGBAModel.Convert(src.At(sb.Min.X+x1, sb.Min.Y+y1)).(imagecolor.RGBA)
			lerp := func(a, b uint8, t float64) float64 { return float64(a) + (float64(b)-float64(a))*t }
			r0, g0, b0, a0 := lerp(c00.R, c10.R, wx), lerp(c00.G, c10.G, wx), lerp(c00.B, c10.B, wx), lerp(c00.A, c10.A, wx)
			r1, g1, b1, a1 := lerp(c01.R, c11.R, wx), lerp(c01.G, c11.G, wx), lerp(c01.B, c11.B, wx), lerp(c01.A, c11.A, wx)
			dst.SetRGBA(x, y, imagecolor.RGBA{uint8(lerp(uint8(r0), uint8(r1), wy)), uint8(lerp(uint8(g0), uint8(g1), wy)), uint8(lerp(uint8(b0), uint8(b1), wy)), uint8(lerp(uint8(a0), uint8(a1), wy))})
		}
	}
	return dst
}

// FindFFmpeg locates an optional decoder on PATH or in the application tools dir.
func FindFFmpeg() string {
	if exe := portableFFmpegPath(); fileExists(exe) {
		return exe
	}
	if exe, err := exec.LookPath("ffmpeg"); err == nil && fileExists(exe) {
		return exe
	}
	if exe, err := os.Executable(); err == nil {
		for _, p := range []string{filepath.Join(filepath.Dir(exe), "app", "tools", "ffmpeg.exe"), filepath.Join(filepath.Dir(exe), "ffmpeg.exe")} {
			if fileExists(p) {
				return p
			}
		}
	}
	return ""
}

// CreateVideoThumbnail needs a real decoder, not an HTML video seek. ffmpeg is
// optional; failure preserves the original movie and the Viewer falls back.
func CreateVideoThumbnail(src, dst string) error { return createFFmpegStill(src, dst, true) }

func createFFmpegStill(src, dst string, isVideo bool) error {
	exe := FindFFmpeg()
	if exe == "" {
		return fmt.Errorf("ffmpeg not installed: video poster unavailable")
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	tmp := dst + ".tak-preview.jpg"
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	// Input seeks a little way in, avoiding black first frames when possible.
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error"}
	if isVideo {
		args = append(args, "-ss", "00:00:00.6")
	}
	args = append(args, "-i", src, "-vf", "scale=w=720:h=720:force_original_aspect_ratio=decrease", "-frames:v", "1", "-q:v", "4", "-y", tmp)
	cmd := exec.CommandContext(ctx, exe, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		if isVideo {
			// Very short videos and corrupt timestamps may reject a 0.6-second seek.
			// Retry at the first decodable frame before reporting a missing poster.
			fallbackArgs := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-i", src, "-vf", "scale=w=720:h=720:force_original_aspect_ratio=decrease", "-frames:v", "1", "-q:v", "4", "-y", tmp}
			if retryOut, retryErr := exec.CommandContext(ctx, exe, fallbackArgs...).CombinedOutput(); retryErr == nil && fileExists(tmp) {
				return os.Rename(tmp, dst)
			} else {
				_ = retryOut
			}
		}
		os.Remove(tmp)
		return fmt.Errorf("ffmpeg thumbnail: %w: %s", err, string(out))
	}
	if !fileExists(tmp) {
		return fmt.Errorf("ffmpeg produced no thumbnail")
	}
	return os.Rename(tmp, dst)
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
