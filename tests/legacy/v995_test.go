package main

import (
	"os"
	"strings"
	"testing"
)

func TestV995PaginationCountsGroupedAlbumMedia(t *testing.T) {
	msgs := []Message{
		{ID: "11", Type: "message", From: "A", Media: []Media{{Path: "p1.jpg", Kind: "image"}, {Path: "p2.jpg", Kind: "image"}}},
		{ID: "12", Type: "message", From: "A", Media: []Media{{Path: "v1.mp4", Kind: "video"}}},
		{ID: "13", Type: "message", From: "A", Text: "ordinary text"},
	}
	counts := pageMediaCounts(msgs)
	if counts[0] != 2 || counts[1] != 1 {
		t.Fatalf("want 2 images / 1 video, got %v", counts)
	}
	page := renderBeautifierPage(Chat{Name: "test"}, msgs, 2, 3)
	if strings.Count(page, "本页 2 图片 · 1 视频") != 2 {
		t.Error("media counts must be displayed on top and bottom pagers")
	}
	if strings.Contains(page, "本页 3 条") {
		t.Error("old message-count label should be replaced")
	}
}

func TestV995ParentViewerAndConsoleReleaseGuard(t *testing.T) {
	ui := map[string][]string{
		"ui/index.html":       {"assets/tak-lightbox.css", "assets/tak-lightbox.js"},
		"ui/app.js":           {"tak-global-lightbox-open", "tak-parent-viewer-ready", "window.TAKLightbox?.close()"},
		"ui/tak-bridge.js":    {"installParentViewer()", "parentViewerReady", "stopImmediatePropagation()"},
		"ui/tak-lightbox.js":  {"tak-lb-wait", "decodeImage", "const validURL", "state.generation", "280"},
		"ui/tak-lightbox.css": {".tak-global-lightbox", "position:fixed", "inset:0"},
	}
	for path, patterns := range ui {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, needle := range patterns {
			if !strings.Contains(string(b), needle) {
				t.Errorf("%s missing %q", path, needle)
			}
		}
	}
	app, _ := os.ReadFile("ui/app.css")
	if strings.Contains(string(app), ".shell.lightbox-active>.main>.frame") {
		t.Error("lightbox must never trigger iframe resize/reflow")
	}
}
