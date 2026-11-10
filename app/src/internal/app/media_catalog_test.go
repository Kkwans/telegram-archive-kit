package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func catalogFixture(t *testing.T) (*Facade, string, string) {
	t.Helper()
	root, config, slug := t.TempDir(), t.TempDir(), "chat-catalog"
	ws := filepath.Join(root, "chats", slug)
	catalogWrite(t, filepath.Join(ws, "workspace.json"), `{}`)
	f := &Facade{a: &App{ConfigDir: config, Settings: Settings{LibraryRoot: root}}}
	return f, root, slug
}

func catalogWrite(t *testing.T, path, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestMediaCatalogUsesRealFilesAndTrustedThumbnails(t *testing.T) {
	f, root, slug := catalogFixture(t)
	ws := filepath.Join(root, "chats", slug)
	catalogWrite(t, filepath.Join(ws, "media", "clip.mp4"), "video")
	catalogWrite(t, filepath.Join(ws, "media", "photo.jpg"), "image data")
	catalogWrite(t, filepath.Join(ws, "files", "report.pdf"), "doc")
	catalogWrite(t, filepath.Join(ws, "thumbs", "thumb_42_ab.jpg"), "cover")
	catalogWrite(t, filepath.Join(ws, "official_exports", "x", "photo_thumb.jpg"), "small")
	catalogWrite(t, filepath.Join(ws, "data", "archive-data.js"), `window.ARCHIVE={"messages":[{"id":"42","media":[{"path":"media/clip.mp4","name":"clip.mp4","kind":"video","size":999},{"path":"media/missing.jpg","name":"missing.jpg","kind":"image","size":900}]},{"id":"43","media":[{"path":"media/photo.jpg","name":"photo.jpg","kind":"image","thumb":"official_exports/x/photo_thumb.jpg"}]}]}`)
	catalogWrite(t, filepath.Join(ws, "source", "result.json"), `{"messages":[{"id":42,"width":640,"height":480}]}`)
	duplicate := "media/clip.mp4"
	if runtime.GOOS == "windows" {
		duplicate = "MEDIA/CLIP.MP4"
	}
	catalogWrite(t, filepath.Join(ws, "official-media-index.json"), fmt.Sprintf(`{"exports":[{"media":{"42":[{"path":%q,"name":"wrong.mp4","kind":"video","size":999}]}}]}`, duplicate))
	page, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || page.Summary.Total != 3 || page.Summary.Bytes != 18 || page.Summary.VideoBytes != 5 || page.Summary.ImageBytes != 10 || page.Summary.FileBytes != 3 {
		t.Fatalf("wrong real-file summary: %+v", page.Summary)
	}
	found := map[string]MediaItemDTO{}
	for _, item := range page.Items {
		found[item.Rel] = item
	}
	clip := found["media/clip.mp4"]
	if clip.ID != "42" || clip.Size != 5 || clip.Width != 640 || clip.Height != 480 || clip.Thumb != "thumbs/thumb_42_ab.jpg" || clip.ThumbSize != 5 || clip.ThumbModTime == 0 {
		t.Fatalf("wrong clip: %+v", clip)
	}
	photo := found["media/photo.jpg"]
	if photo.Thumb != "official_exports/x/photo_thumb.jpg" || photo.ThumbSize != 5 {
		t.Fatalf("wrong explicit thumbnail: %+v", photo)
	}
	for _, item := range []MediaItemDTO{clip, photo} {
		if size, mod, ok := f.CachedMediaThumbnail(root, slug, item.Thumb, page.Version); !ok || size != item.ThumbSize || mod != item.ThumbModTime {
			t.Fatalf("thumbnail fingerprint %q: %d %d %v", item.Thumb, size, mod, ok)
		}
	}
	if size, _, ok := f.CachedMediaThumbnail(root, slug, photo.Rel, page.Version); !ok || size != photo.Size {
		t.Fatal("image original was not indexed")
	}
	if _, _, ok := f.CachedMediaThumbnail(root, slug, clip.Rel, page.Version); ok {
		t.Fatal("video original must not be a thumbnail")
	}
	if _, _, ok := f.CachedMediaThumbnail(root, slug, photo.Thumb, "wrong"); ok {
		t.Fatal("accepted another version")
	}
	if _, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug, LibraryKey: "wrong"}); err == nil {
		t.Fatal("accepted another library")
	}
}

func TestMediaCatalogPaginationRefreshAndLocalFirstPage(t *testing.T) {
	f, root, slug := catalogFixture(t)
	ws := filepath.Join(root, "chats", slug)
	for i := 1; i <= 123; i++ {
		ext := ".jpg"
		if i%3 == 0 {
			ext = ".mp4"
		}
		if i%7 == 0 {
			ext = ".pdf"
		}
		catalogWrite(t, filepath.Join(ws, "media", fmt.Sprintf("1_%03d_media%s", i, ext)), strings.Repeat("x", i))
	}
	first, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug})
	if err != nil {
		t.Fatal(err)
	}
	if first.Total != 123 || len(first.Items) != 50 || first.Page != 1 || first.PageSize != 50 || first.Version == "" {
		t.Fatalf("bad first page: %+v", first)
	}
	second, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug, Page: 2, Version: first.Version})
	if err != nil || len(second.Items) != 50 || second.Total != 123 || second.Version != first.Version || second.Items[0].Rel == first.Items[0].Rel {
		t.Fatalf("bad second page: %+v, %v", second, err)
	}
	sorted, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug, Sort: "size-asc", Version: first.Version})
	if err != nil || len(sorted.Items) != 50 || sorted.Items[0].Size != 1 {
		t.Fatalf("bad size order: %+v, %v", sorted, err)
	}
	matches, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug, Kind: "visual", Query: "_003_", Version: first.Version})
	if err != nil || matches.Total != 1 || matches.Items[0].Kind != "video" {
		t.Fatalf("bad filtered page: %+v, %v", matches, err)
	}
	// A different process can load the first page and exact summary from the
	// local header even while the NAS workspace is unavailable.
	if err := os.Rename(ws, ws+"-offline"); err != nil {
		t.Fatal(err)
	}
	cold := &Facade{a: &App{ConfigDir: f.a.ConfigDir, Settings: Settings{LibraryRoot: root}}}
	cached, ok := cold.cachedWorkspaceMediaSummary(root, slug)
	if !ok || cached.Total != first.Total {
		t.Fatalf("local summary: %+v %v", cached, ok)
	}
	local, err := cold.ChatMedia(context.Background(), MediaQuery{Slug: slug})
	if err != nil || local.Version != first.Version || len(local.Items) != 50 {
		t.Fatalf("local first page: %v, %v", local.Total, err)
	}
	if err := os.Rename(ws+"-offline", ws); err != nil {
		t.Fatal(err)
	}
	catalogWrite(t, filepath.Join(ws, "media", "1_124_added.jpg"), "new")
	refreshed, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug, Refresh: true})
	if err != nil || refreshed.Total != 124 || refreshed.Version == first.Version {
		t.Fatalf("refresh: %+v, %v", refreshed, err)
	}
	mismatch, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug, Page: 2, Version: first.Version})
	if err != nil || !mismatch.Stale || mismatch.Version != refreshed.Version || len(mismatch.Items) != 0 {
		t.Fatalf("old version accepted: %+v %v", mismatch, err)
	}
	f.invalidateWorkspaceMedia(root, slug)
	if _, ok := f.cachedWorkspaceMediaSummary(root, slug); ok {
		t.Fatal("invalidated summary was served")
	}
	if err := os.Rename(ws, ws+"-offline"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug}); err == nil {
		t.Fatal("invalidated workspace served old first page")
	}
}

func TestMediaCatalogErrorsNeverPublishPartialSnapshot(t *testing.T) {
	f, root, slug := catalogFixture(t)
	ws := filepath.Join(root, "chats", slug)
	catalogWrite(t, filepath.Join(ws, "media", "1_42_clip.mp4"), "video")
	catalogWrite(t, filepath.Join(ws, "source", "result.json"), "not json")
	page, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug})
	if err != nil || page.Total != 1 {
		t.Fatalf("optional dimensions blocked catalog: %+v, %v", page, err)
	}
	catalogWrite(t, filepath.Join(ws, "data", "archive-data.js"), `window.ARCHIVE={broken`)
	if _, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug, Refresh: true}); err == nil {
		t.Fatal("malformed archive was accepted")
	}
	after, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug})
	if err != nil || after.Version != page.Version || after.Total != 1 {
		t.Fatalf("failure destroyed complete cache: %+v, %v", after, err)
	}
}

func TestMediaCatalogWaitHonorsCancellation(t *testing.T) {
	f, _, slug := catalogFixture(t)
	f.mediaSlots = make(chan struct{}, mediaCatalogParallel)
	for i := 0; i < mediaCatalogParallel; i++ {
		f.mediaSlots <- struct{}{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := f.ChatMedia(ctx, MediaQuery{Slug: slug})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("request did not cancel: %v", err)
	}
	for i := 0; i < mediaCatalogParallel; i++ {
		<-f.mediaSlots
	}
	page, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug})
	if err != nil || page.Total != 0 {
		t.Fatalf("catalog did not recover after cancellation: %+v, %v", page, err)
	}
}

func TestMediaCatalogRejectsLinkedDirectories(t *testing.T) {
	f, root, slug := catalogFixture(t)
	outside := t.TempDir()
	catalogWrite(t, filepath.Join(outside, "outside.jpg"), "secret")
	link := filepath.Join(root, "chats", slug, "media")
	if err := os.Symlink(outside, link); err != nil {
		if runtime.GOOS != "windows" {
			t.Skipf("creating directory link: %v", err)
		}
		if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", link, outside).CombinedOutput(); err != nil {
			t.Fatalf("creating junction: %v (%s)", err, output)
		}
	}
	if _, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug}); err == nil {
		t.Fatal("catalog followed a linked media directory")
	}
	if _, ok := f.cachedWorkspaceMediaSummary(root, slug); ok {
		t.Fatal("unsafe scan published a summary")
	}
}

func TestMediaCatalogBoundsLoadedSnapshots(t *testing.T) {
	f, root, _ := catalogFixture(t)
	for i := 0; i < mediaCatalogMaxEntries+3; i++ {
		slug := fmt.Sprintf("chat-%02d", i)
		ws := filepath.Join(root, "chats", slug)
		catalogWrite(t, filepath.Join(ws, "workspace.json"), `{}`)
		catalogWrite(t, filepath.Join(ws, "media", "photo.jpg"), "one")
		if _, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug}); err != nil {
			t.Fatal(err)
		}
	}
	f.mediaMu.Lock()
	entries, loaded := len(f.mediaCache), 0
	for _, entry := range f.mediaCache {
		if entry.snapshot != nil {
			loaded++
		}
	}
	f.mediaMu.Unlock()
	if entries > mediaCatalogMaxEntries || loaded > mediaCatalogMaxLoaded {
		t.Fatalf("unbounded catalog cache: entries=%d snapshots=%d", entries, loaded)
	}
	page, err := f.ChatMedia(context.Background(), MediaQuery{Slug: "chat-00"})
	if err != nil || page.Total != 1 {
		t.Fatalf("evicted cache not recovered: %+v %v", page, err)
	}
}

func TestMediaCatalogSharedScanAndInvalidationGeneration(t *testing.T) {
	f, root, slug := catalogFixture(t)
	ws := filepath.Join(root, "chats", slug)
	catalogWrite(t, filepath.Join(ws, "media", "one.jpg"), "one")
	f.mediaSlots = make(chan struct{}, mediaCatalogParallel)
	for i := 0; i < mediaCatalogParallel; i++ {
		f.mediaSlots <- struct{}{}
	}
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	second := make(chan error, 1)
	go func() { _, err := f.ChatMedia(ctx, MediaQuery{Slug: slug}); first <- err }()
	go func() { _, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug}); second <- err }()
	deadline := time.Now().Add(5 * time.Second)
	var shared *mediaCatalogJob
	for time.Now().Before(deadline) {
		f.mediaMu.Lock()
		e := f.mediaCache[mediaCatalogKey(root, slug)]
		if e != nil && e.job != nil && e.job.waiters == 2 {
			shared = e.job
		}
		f.mediaMu.Unlock()
		if shared != nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if shared == nil {
		cancel()
		t.Fatal("callers did not share the pending scan")
	}
	cancel()
	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled waiter: %v", err)
	}
	for i := 0; i < mediaCatalogParallel; i++ {
		<-f.mediaSlots
	}
	if err := <-second; err != nil {
		t.Fatalf("other waiter lost the shared scan: %v", err)
	}

	// Invalidation must detach/cancel an older scan before its publication.
	for i := 0; i < mediaCatalogParallel; i++ {
		f.mediaSlots <- struct{}{}
	}
	old := make(chan error, 1)
	go func() { _, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug, Refresh: true}); old <- err }()
	deadline = time.Now().Add(5 * time.Second)
	var obsolete *mediaCatalogJob
	for time.Now().Before(deadline) {
		f.mediaMu.Lock()
		e := f.mediaCache[mediaCatalogKey(root, slug)]
		if e != nil && e.job != nil && e.job != shared {
			obsolete = e.job
		}
		f.mediaMu.Unlock()
		if obsolete != nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if obsolete == nil {
		t.Fatal("refresh did not start")
	}
	catalogWrite(t, filepath.Join(ws, "media", "two.jpg"), "two")
	f.invalidateWorkspaceMedia(root, slug)
	for i := 0; i < mediaCatalogParallel; i++ {
		<-f.mediaSlots
	}
	if err := <-old; !errors.Is(err, context.Canceled) {
		t.Fatalf("obsolete scan: %v", err)
	}
	current, err := f.ChatMedia(context.Background(), MediaQuery{Slug: slug})
	if err != nil || current.Total != 2 {
		t.Fatalf("new generation: %+v %v", current, err)
	}
	persisted := &Facade{a: &App{ConfigDir: f.a.ConfigDir, Settings: Settings{LibraryRoot: root}}}
	summary, ok := persisted.cachedWorkspaceMediaSummary(root, slug)
	if !ok || summary.Total != 2 {
		t.Fatalf("obsolete generation replaced disk cache: %+v %v", summary, ok)
	}
}
