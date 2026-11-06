package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestChatMediaExcludesVideoThumbnails(t *testing.T) {
	root := t.TempDir()
	slug := "chat-test"
	workspace := filepath.Join(root, "chats", slug)
	if err := os.MkdirAll(filepath.Join(workspace, "data"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(workspace, "media"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "workspace.json"), []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "media", "real.mp4"), []byte("video"), 0644); err != nil {
		t.Fatal(err)
	}
	data := `window.__ARCHIVE__ = {"messages":[{"id":"7","media":[` +
		`{"path":"media/real.mp4","name":"real.mp4","kind":"video"},` +
		`{"path":"official_exports/video_files/IMG_1.MP4_thumb.jpg","name":"IMG_1.MP4_thumb.jpg","kind":"image"}` +
		`]}]}`
	if err := os.WriteFile(filepath.Join(workspace, "data", "archive-data.js"), []byte(data), 0644); err != nil {
		t.Fatal(err)
	}
	f := &Facade{a: &App{ConfigDir: t.TempDir()}}
	f.a.Settings.LibraryRoot = root
	items, err := f.ChatMedia(slug)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Name != "real.mp4" {
		t.Fatalf("thumbnail leaked into media list: %#v", items)
	}
	summary := f.workspaceMediaSummary(slug)
	if summary.Total != 1 || summary.Videos != 1 || summary.Images != 0 {
		t.Fatalf("thumbnail leaked into media summary: %#v", summary)
	}
}
