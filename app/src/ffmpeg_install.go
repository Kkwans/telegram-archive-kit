package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// FFmpeg Windows binaries are obtained from a provider listed on ffmpeg.org.
// The package is NOT bundled in TAK. An independent publisher-provided SHA-256
// is required before we extract the executable. No administrator access needed.
const ffmpegReleaseZip = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
const ffmpegReleaseHash = ffmpegReleaseZip + ".sha256"

func portableFFmpegPath() string {
	base, e := os.UserConfigDir()
	if e != nil || base == "" {
		base = os.TempDir()
	}
	if runtime.GOOS == "windows" {
		if p := os.Getenv("LOCALAPPDATA"); p != "" {
			base = p
		}
	}
	return filepath.Join(base, "Programs", "TelegramArchiveKit", "ffmpeg", "bin", "ffmpeg.exe")
}

func validatedFFmpeg(path string) bool {
	if !fileExists(path) {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, path, "-hide_banner", "-version").Run() == nil
}

func ffmpegClient() *http.Client {
	return &http.Client{Timeout: 0, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 30 * time.Second}}
}
func ffmpegHash(ctx context.Context, c *http.Client) (string, error) {
	req, e := http.NewRequestWithContext(ctx, "GET", ffmpegReleaseHash, nil)
	if e != nil {
		return "", e
	}
	resp, e := c.Do(req)
	if e != nil {
		return "", e
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("hash HTTP %d", resp.StatusCode)
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, 512))
	if e != nil {
		return "", e
	}
	for _, p := range strings.Fields(string(b)) {
		if len(p) == 64 {
			if _, e = hex.DecodeString(p); e == nil {
				return strings.ToLower(p), nil
			}
		}
	}
	return "", errors.New("FFmpeg 发布页没有返回合法 SHA-256")
}

// ensureFFmpegInstalled is called by preflight when local video thumbnails are enabled.
// progress is (downloaded bytes, total bytes, phase).
func ensureFFmpegInstalled(ctx context.Context, progress func(int64, int64, string)) (string, error) {
	if exe := findFFmpeg(); exe != "" && validatedFFmpeg(exe) {
		return exe, nil
	}
	if runtime.GOOS != "windows" {
		return "", errors.New("请通过系统包管理器安装 FFmpeg")
	}
	out := portableFFmpegPath()
	if validatedFFmpeg(out) {
		return out, nil
	}
	if e := os.MkdirAll(filepath.Dir(out), 0755); e != nil {
		return "", e
	}
	client := ffmpegClient()
	sum, e := ffmpegHash(ctx, client)
	if e != nil {
		return "", fmt.Errorf("无法验证 FFmpeg 来源：%w", e)
	}
	req, e := http.NewRequestWithContext(ctx, "GET", ffmpegReleaseZip, nil)
	if e != nil {
		return "", e
	}
	resp, e := client.Do(req)
	if e != nil {
		return "", fmt.Errorf("下载 FFmpeg: %w", e)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("FFmpeg 下载 HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > 250<<20 {
		return "", errors.New("FFmpeg 下载包超过 250 MB 安全限额")
	}
	tmp, e := os.CreateTemp(filepath.Dir(out), ".ffmpeg-*.zip.part")
	if e != nil {
		return "", e
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	hasher := sha256.New()
	w := io.MultiWriter(tmp, hasher)
	buf := make([]byte, 1024*1024)
	var bytes int64
	for {
		if e = ctx.Err(); e != nil {
			return "", e
		}
		n, re := resp.Body.Read(buf)
		if n > 0 {
			bytes += int64(n)
			if bytes > 250<<20 {
				return "", errors.New("下载文件超过安全限额")
			}
			if _, e = w.Write(buf[:n]); e != nil {
				return "", e
			}
			if progress != nil {
				progress(bytes, resp.ContentLength, "正在下载 FFmpeg 视频解码器")
			}
		}
		if re == io.EOF {
			break
		}
		if re != nil {
			return "", re
		}
	}
	if actual := hex.EncodeToString(hasher.Sum(nil)); actual != sum {
		return "", fmt.Errorf("FFmpeg SHA-256 不匹配：期望 %s，实际 %s", sum, actual)
	}
	if e = tmp.Sync(); e != nil {
		return "", e
	}
	if progress != nil {
		progress(bytes, bytes, "校验成功，正在安装 FFmpeg")
	}
	z, e := zip.OpenReader(tmp.Name())
	if e != nil {
		return "", e
	}
	defer z.Close()
	var binary *zip.File
	for _, f := range z.File {
		if strings.EqualFold(filepath.Base(filepath.FromSlash(f.Name)), "ffmpeg.exe") && strings.Contains(strings.ToLower(filepath.ToSlash(f.Name)), "/bin/") {
			binary = f
			break
		}
	}
	if binary == nil {
		return "", errors.New("已下载的 FFmpeg 包缺少 bin/ffmpeg.exe")
	}
	if binary.UncompressedSize64 > 250<<20 {
		return "", errors.New("FFmpeg 可执行文件体积异常")
	}
	src, e := binary.Open()
	if e != nil {
		return "", e
	}
	defer src.Close()
	part := out + ".installing"
	dst, e := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0755)
	if e != nil {
		return "", e
	}
	written, e := io.Copy(dst, io.LimitReader(src, 250<<20))
	if se := dst.Sync(); e == nil {
		e = se
	}
	if ce := dst.Close(); e == nil {
		e = ce
	}
	if e != nil {
		os.Remove(part)
		return "", e
	}
	if written <= 0 {
		os.Remove(part)
		return "", errors.New("FFmpeg 解压产生空文件")
	}
	if fileExists(out) && !validatedFFmpeg(out) {
		_ = os.Remove(out)
	}
	if fileExists(out) && !validatedFFmpeg(out) {
		_ = os.Remove(out)
	}
	if e = os.Rename(part, out); e != nil {
		os.Remove(part)
		return "", e
	}
	if !validatedFFmpeg(out) {
		os.Remove(out)
		return "", errors.New("FFmpeg 下载成功但无法运行；请检查 Windows Defender 或 Windows 版本")
	}
	if progress != nil {
		progress(bytes, bytes, "FFmpeg 安装完成，视频缩略图已就绪")
	}
	return out, nil
}
