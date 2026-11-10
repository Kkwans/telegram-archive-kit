package main

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func remoteThumbnailPath(configDir, root, slug, rel string, size, modTime int64) string {
	key := fmt.Sprintf("%s\x00%s\x00%d\x00%d", slug, rel, size, modTime)
	sum := sha256.Sum256([]byte(key))
	return filepath.Join(remoteCacheDir(configDir, root), hex.EncodeToString(sum[:])+".preview")
}

func (b *Bridge) cacheRemoteThumbnail(ctx context.Context, abs, dst string, size, modTime int64) string {
	for {
		if cached, err := os.Stat(dst); err == nil && cached.Size() == size {
			return dst
		}
		done := make(chan struct{})
		if previous, busy := b.thumbFlights.LoadOrStore(dst, done); busy {
			select {
			case <-ctx.Done():
				return ""
			case <-previous.(chan struct{}):
			}
			continue
		}
		defer func() {
			b.thumbFlights.Delete(dst)
			close(done)
		}()
		break
	}
	if ctx.Err() != nil {
		return ""
	}
	in, err := os.Open(abs)
	if err != nil {
		return ""
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil || info.Size() != size || info.ModTime().UnixMilli() != modTime {
		return ""
	}
	dir := filepath.Dir(dst)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return ""
	}
	out, err := os.CreateTemp(dir, ".thumb-*")
	if err != nil {
		return ""
	}
	tmp := out.Name()
	defer os.Remove(tmp)
	_, copyErr := io.CopyN(out, mediaReader{ctx, in}, size)
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil || ctx.Err() != nil {
		return ""
	}
	if err := os.Rename(tmp, dst); err != nil {
		return ""
	}
	b.sweepRemoteThumbnails(dir)
	return dst
}

func (b *Bridge) sweepRemoteThumbnails(dir string) {
	now := time.Now()
	last, ok := b.remoteCacheSweeps.LoadOrStore(dir, now)
	if ok && (now.Sub(last.(time.Time)) < 10*time.Minute || !b.remoteCacheSweeps.CompareAndSwap(dir, last, now)) {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var total int64
	var files []os.FileInfo
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".preview") {
			continue
		}
		if info, err := entry.Info(); err == nil {
			files = append(files, info)
			total += info.Size()
		}
	}
	const limit = 8 << 30
	if total <= limit {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].ModTime().Before(files[j].ModTime()) })
	for _, file := range files {
		if total <= limit {
			break
		}
		if os.Remove(filepath.Join(dir, file.Name())) == nil {
			total -= file.Size()
		}
	}
}

func remoteCacheDir(configDir, root string) string {
	sum := sha1.Sum([]byte(strings.ToLower(filepath.Clean(root))))
	return filepath.Join(configDir, "remote-cache", hex.EncodeToString(sum[:8]))
}
