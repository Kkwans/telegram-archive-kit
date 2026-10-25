package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestV996SearchIndexMediaPreviewAndDeepLink(t *testing.T) {
	root := t.TempDir()
	a := &App{Settings: Settings{LibraryRoot: root}}
	slug := "search-demo"
	if err := os.MkdirAll(a.dataDir(slug), 0755); err != nil {
		t.Fatal(err)
	}
	arc := &Archive{Chat: Chat{Name: "Tester"}, Messages: []Message{
		{ID: "100", Type: "message", From: "A", TS: 1, Text: "image", Media: []Media{{Name: "a.jpg", Path: "photos/a.jpg", Thumb: "thumbs/a.jpg", Kind: "image"}}},
		{ID: "101", Type: "message", From: "A", TS: 2, Text: "clip", Media: []Media{{Name: "b.mp4", Path: "video/b.mp4", Thumb: "thumbs/b.jpg", Kind: "video"}}},
		{ID: "102", Type: "message", From: "A", TS: 3, Text: "no media"},
	}}
	if err := a.writeSearchIndex(slug, arc); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(a.dataDir(slug), "search-index.js"))
	if err != nil {
		t.Fatal(err)
	}
	head := "window.__TAK_SEARCH__ = "
	if !strings.HasPrefix(string(raw), head) {
		t.Fatalf("unexpected index: %s", raw)
	}
	var rows []struct {
		ID          string
		Preview     string
		PreviewKind string
		MediaSource string
		Page        int
	}
	data := strings.TrimSuffix(strings.TrimSpace(strings.TrimPrefix(string(raw), head)), ";")
	if err := json.Unmarshal([]byte(data), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 || rows[0].Preview != "thumbs/a.jpg" || rows[0].PreviewKind != "image" || rows[0].MediaSource != "photos/a.jpg" || rows[1].PreviewKind != "video" || rows[1].Preview != "thumbs/b.jpg" || rows[2].Preview != "" || rows[0].Page < 1 {
		t.Fatalf("wrong search preview rows: %+v", rows)
	}
}

func TestV996NoLightboxBackdropRegression(t *testing.T) {
	b, e := os.ReadFile("ui/tak-lightbox.css")
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(b), "rgba(17,19,25,.94)") || !strings.Contains(string(b), "rgba(17,19,25,.64)") {
		t.Fatal("lightbox shade must be translucent")
	}
	s, e := os.ReadFile("ui/tak-bridge.js")
	if e != nil {
		t.Fatal(e)
	}
	for _, token := range []string{"card.scrollIntoView", "tak-locating", "PreviewKind", "tak-search-cover", "if(anchor.startsWith('message'))"} {
		if !strings.Contains(string(s), token) {
			t.Errorf("missing %s", token)
		}
	}
	if strings.Contains(string(s), "if(service && typeof window.scrollToDate") {
		t.Fatal("message search must not be routed via date")
	}
}
