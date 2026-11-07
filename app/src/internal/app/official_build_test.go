package app

import (
	"context"
	"image"
	imagecolor "image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOfficialOnlyWorkspaceBuildsPagesWithoutResultJSON(t *testing.T) {
	root := t.TempDir()
	a := &App{Settings: defaultSettings()}
	a.Settings.LibraryRoot = root
	a.Settings.GenerateThumbnails = false
	if err := a.ensureLibraryDirs(); err != nil {
		t.Fatal(err)
	}
	slug := "chat_Test_2026-01-01_abc"
	ws := a.workspaceDir(slug)
	exportDir := filepath.Join(ws, "official_exports", "Test")
	if err := os.MkdirAll(filepath.Join(exportDir, "photos"), 0755); err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(image.Rect(0, 0, 8, 6))
	for y := 0; y < 6; y++ {
		for x := 0; x < 8; x++ {
			img.Set(x, y, imagecolor.RGBA{uint8(x * 20), uint8(y * 25), 120, 255})
		}
	}
	for _, name := range []string{"photo.jpg", "photo.jpg_thumb.jpg"} {
		f, err := os.Create(filepath.Join(exportDir, "photos", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := jpeg.Encode(f, img, nil); err != nil {
			t.Fatal(err)
		}
		_ = f.Close()
	}
	html := `<!DOCTYPE html><html><body>
<div class="message default clearfix" id="message7">
  <div class="body">
    <div class="pull_right date details" title="01.01.2026 12:00:00 UTC+08:00">12:00</div>
    <div class="from_name">Alice</div>
    <div class="media_wrap clearfix"><a class="photo_wrap clearfix pull_left" href="photos/photo.jpg"><img class="photo" src="photos/photo.jpg_thumb.jpg"></a></div>
    <div class="text">hello</div>
  </div>
</div>
</body></html>`
	if err := os.WriteFile(filepath.Join(exportDir, "messages.html"), []byte(html), 0644); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := writeJSON(a.workspaceMetaPath(slug), WorkspaceMeta{
		Slug: slug, Chat: Chat{Name: "Test"}, ImportedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.registerOfficialExport(slug, exportDir, "managed"); err != nil {
		t.Fatal(err)
	}
	arc, err := a.buildWorkspaceModeWithProgressCtx(context.Background(), slug, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if arc.Stats.Messages != 1 || arc.Stats.MediaFiles != 1 || arc.Messages[0].Text != "hello" {
		t.Fatalf("archive = %+v", arc.Stats)
	}
	if fileExists(a.sourcePath(slug)) {
		t.Fatal("source/result.json should stay absent")
	}
	for _, rel := range []string{"data/archive-data.js", "data/search-index.js", "data/date-index.js", "messages.html", "archive-report.json"} {
		if !fileExists(filepath.Join(ws, filepath.FromSlash(rel))) {
			t.Fatalf("missing generated file %s", rel)
		}
	}
	lib, err := os.ReadFile(filepath.Join(root, "library-data.js"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(lib), `"data_script":"chats/`+slug+`/data/archive-data.js"`) {
		t.Fatalf("library data did not keep official-only archive data: %s", string(lib))
	}
	if !strings.Contains(string(lib), `"messages_rel":"chats/`+slug+`/messages.html"`) {
		t.Fatalf("library does not point at the generated archive page: %s", string(lib))
	}
	if got := arc.Messages[0].Media[0].Thumb; !strings.Contains(got, "photo.jpg_thumb.jpg") {
		t.Fatalf("official thumbnail not reused: %q", got)
	}
}

func TestBindChatIdentityMergesOfficialWorkspaceByID(t *testing.T) {
	root := t.TempDir()
	a := &App{Settings: defaultSettings()}
	a.Settings.LibraryRoot = root
	if err := a.ensureLibraryDirs(); err != nil {
		t.Fatal(err)
	}
	slug := "chat_OfficialDemo_2025-06-01_abc"
	if err := os.MkdirAll(a.workspaceDir(slug), 0755); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(a.workspaceMetaPath(slug), WorkspaceMeta{Slug: slug, Chat: Chat{Name: "OfficialDemo"}}); err != nil {
		t.Fatal(err)
	}
	f := &Facade{a: a}
	if err := f.BindChatIdentity(slug, "999999", "OfficialDemo", "private_group"); err != nil {
		t.Fatal(err)
	}
	found, ok := a.findWorkspaceByChat(Chat{ID: "999999", Name: "different online title", Type: "private_group"})
	if !ok || found != slug {
		t.Fatalf("findWorkspaceByChat = %q, %v", found, ok)
	}
	meta, err := a.readWorkspaceMeta(slug)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Chat.ID != "999999" || meta.Chat.Type != "private_group" {
		t.Fatalf("meta = %+v", meta.Chat)
	}
}
