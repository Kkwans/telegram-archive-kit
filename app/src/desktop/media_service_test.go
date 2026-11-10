package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"

	takapp "telegramarchivekit/internal/app"
)

func TestMediaServiceRangesAndRejectsAnotherLibrary(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TAK_CONFIG_DIR", t.TempDir())
	t.Setenv("TAK_LIBRARY_ROOT", root)
	const slug = "chat-2026-01-01"
	const rel = "media/example.mp4"
	path := filepath.Join(root, "chats", slug, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("0123456789"), 0600); err != nil {
		t.Fatal(err)
	}
	facade, err := takapp.OpenFacade()
	if err != nil {
		t.Fatal(err)
	}
	bridge := NewBridge(facade)
	query := url.Values{"slug": {slug}, "f": {rel}, "k": {facade.LibraryKey()}, "prefetch": {"1"}}
	request := httptest.NewRequest(http.MethodGet, "/api/media?"+query.Encode(), nil)
	request.Header.Set("Range", "bytes=4-7")
	response := httptest.NewRecorder()
	bridge.serveMedia(response, request)
	if response.Code != http.StatusPartialContent || response.Header().Get("Content-Range") != "bytes 4-7/10" || response.Body.String() != "4567" {
		t.Fatalf("incorrect range response: %d %s %q", response.Code, response.Header(), response.Body.String())
	}
	query.Set("k", "another-library")
	response = httptest.NewRecorder()
	bridge.serveMedia(response, httptest.NewRequest(http.MethodGet, "/api/media?"+query.Encode(), nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("foreign library request returned %d", response.Code)
	}
}

func TestRemoteThumbnailCacheUsesLibraryAndFingerprint(t *testing.T) {
	root, config := t.TempDir(), t.TempDir()
	source := filepath.Join(root, "cover.jpg")
	if err := os.WriteFile(source, []byte("preview"), 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(source)
	if err != nil {
		t.Fatal(err)
	}
	size, mtime := info.Size(), info.ModTime().UnixMilli()
	cache := remoteThumbnailPath(config, root, "chat", "thumbs/cover.jpg", size, mtime)
	if cache == remoteThumbnailPath(config, t.TempDir(), "chat", "thumbs/cover.jpg", size, mtime) ||
		cache == remoteThumbnailPath(config, root, "chat", "thumbs/cover.jpg", size, mtime+1) {
		t.Fatal("cache key ignored the library or version")
	}
	var bridge Bridge
	var group sync.WaitGroup
	for range 4 {
		group.Add(1)
		go func() {
			defer group.Done()
			if got := bridge.cacheRemoteThumbnail(context.Background(), source, cache, size, mtime); got != cache {
				t.Error("cache fill failed")
			}
		}()
	}
	group.Wait()
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	if got := bridge.cacheRemoteThumbnail(context.Background(), source, cache, size, mtime); got != cache {
		t.Fatal("cache hit accessed the source")
	}
	data, err := os.ReadFile(cache)
	if err != nil || string(data) != "preview" {
		t.Fatal("cache corrupted the preview")
	}
	entries, err := os.ReadDir(filepath.Dir(cache))
	if err != nil || len(entries) != 1 {
		t.Fatal("temporary cache files leaked")
	}
}
