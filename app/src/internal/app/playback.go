package app

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"telegramarchivekit/internal/media"
)

var (
	playbackLocks  sync.Map
	playbackMax    int64 = 4 << 30
	playbackFormat       = map[string]bool{".mp4": true, ".m4v": true, ".mov": true}
)

// PlayableMediaPath returns a browser-friendly copy for MP4 files whose moov
// atom sits after mdat. Chromium otherwise has to fetch the whole file before
// it can even render the first frame, which makes a local 100 MB video feel
// like a network stream. The cache is copied (not re-encoded) and capped.
func (f *Facade) PlayableMediaPath(ctx context.Context, root, slug, rel string, remux bool) (string, error) {
	workspace, err := checkedWorkspaceDir(root, slug)
	if err != nil {
		return "", err
	}
	abs, _, err := checkedWorkspaceFile(workspace, rel, nil)
	if err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	ext := strings.ToLower(filepath.Ext(abs))
	if !remux || !playbackFormat[ext] {
		return abs, nil
	}
	st, err := os.Stat(abs)
	if err != nil {
		return abs, nil
	}
	sum := sha1.Sum([]byte(fmt.Sprintf("%s|%d|%d", abs, st.Size(), st.ModTime().UnixNano())))
	cacheDir := filepath.Join(f.a.ConfigDir, "playback-cache")
	dst := filepath.Join(cacheDir, hex.EncodeToString(sum[:])+ext)
	if fileExists(dst) {
		return dst, nil
	}
	if hasFaststart(abs) {
		return abs, nil
	}
	exe := media.FindFFmpeg()
	if exe == "" {
		return abs, nil
	}
	for {
		done := make(chan struct{})
		if previous, busy := playbackLocks.LoadOrStore(dst, done); busy {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-previous.(chan struct{}):
			}
			if fileExists(dst) {
				return dst, nil
			}
			continue
		}
		defer func() {
			playbackLocks.Delete(dst)
			close(done)
		}()
		break
	}
	if fileExists(dst) {
		return dst, nil
	}
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		return abs, nil
	}
	file, err := os.CreateTemp(cacheDir, ".playback-*"+ext)
	if err != nil {
		return abs, nil
	}
	tmp := file.Name()
	defer os.Remove(tmp)
	if err := file.Close(); err != nil {
		return abs, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	cmd := hideWindow(exec.CommandContext(ctx, exe,
		"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-i", abs, "-map", "0", "-c", "copy", "-movflags", "+faststart", tmp,
	))
	if err := cmd.Run(); err != nil {
		return abs, nil
	}
	if err := os.Rename(tmp, dst); err != nil {
		return abs, nil
	}
	prunePlaybackCache(cacheDir, playbackMax)
	return dst, nil
}

// hasFaststart reports true when a moov box appears before mdat. Only box
// headers are read, so checking a 100 MB file is cheap.
func hasFaststart(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return false
	}
	size := st.Size()
	var pos int64
	for pos < size {
		if _, err := f.Seek(pos, 0); err != nil {
			return false
		}
		head := make([]byte, 16)
		n, _ := f.Read(head)
		if n < 8 {
			return false
		}
		boxLen := int64(head[0])<<24 | int64(head[1])<<16 | int64(head[2])<<8 | int64(head[3])
		typ := string(head[4:8])
		header := int64(8)
		if boxLen == 1 {
			if n < 16 {
				return false
			}
			boxLen = int64(head[8])<<56 | int64(head[9])<<48 | int64(head[10])<<40 | int64(head[11])<<32 |
				int64(head[12])<<24 | int64(head[13])<<16 | int64(head[14])<<8 | int64(head[15])
			header = 16
		}
		if boxLen == 0 {
			boxLen = size - pos
		}
		if boxLen < header {
			return false
		}
		if typ == "moov" {
			return true
		}
		if typ == "mdat" {
			return false
		}
		pos += boxLen
	}
	return false
}

func prunePlaybackCache(dir string, limit int64) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type item struct {
		path string
		size int64
		mod  time.Time
	}
	items := make([]item, 0, len(entries))
	var total int64
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		items = append(items, item{filepath.Join(dir, e.Name()), info.Size(), info.ModTime()})
		total += info.Size()
	}
	if total <= limit {
		return
	}
	sort.Slice(items, func(i, j int) bool { return items[i].mod.Before(items[j].mod) })
	for _, it := range items {
		if total <= limit {
			break
		}
		if os.Remove(it.path) == nil {
			total -= it.size
		}
	}
}
