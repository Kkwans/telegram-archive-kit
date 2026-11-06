package main

import (
	"crypto/sha1"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"telegramarchivekit/internal/platform"
)

// cachedRemoteThumb keeps frequently requested remote thumbnails on the local
// disk. Full media still streams from the library; only the thumbnail burst is
// cached, which is what makes a NAS grid feel responsive.
func (b *Bridge) cachedRemoteThumb(abs, slug, name string) string {
	settings := b.facade.GetSettings()
	remote, _ := platform.NetworkPathKind(settings.LibraryRoot)
	cleanName := filepath.ToSlash(name)
	if !remote || !strings.HasPrefix(cleanName, "thumbs/") {
		return ""
	}
	src, err := os.Stat(abs)
	if err != nil {
		return ""
	}
	cacheDir := remoteCacheDir(b.facade.ConfigDir(), settings.LibraryRoot)
	cachePath := filepath.Join(cacheDir, slug, filepath.Base(abs))
	if cached, err := os.Stat(cachePath); err == nil && cached.Size() == src.Size() && cached.ModTime().Equal(src.ModTime()) {
		return cachePath
	}
	if err := os.MkdirAll(filepath.Dir(cachePath), 0755); err != nil {
		return ""
	}
	in, err := os.Open(abs)
	if err != nil {
		return ""
	}
	defer in.Close()
	tmp := cachePath + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return ""
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(tmp)
		return ""
	}
	if err := os.Rename(tmp, cachePath); err != nil {
		_ = os.Remove(tmp)
		return ""
	}
	_ = os.Chtimes(cachePath, time.Now(), src.ModTime())
	return cachePath
}

func remoteCacheDir(configDir, root string) string {
	sum := sha1.Sum([]byte(strings.ToLower(filepath.Clean(root))))
	return filepath.Join(configDir, "remote-cache", hex.EncodeToString(sum[:8]))
}
