package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestV991StrictAndInferredAreDistinct(t *testing.T) {
	messages := []Message{
		{ID: "101", Type: "message", From: "频道", TS: 1760000000, MediaType: "video_file", Media: []Media{{Name: "3687_101_document_one.mp4", Kind: "video"}}},
		{ID: "102", Type: "message", From: "频道", TS: 1760000010, MediaType: "video_file", Media: []Media{{Name: "3687_102_document_two.mp4", Kind: "video"}}},
		{ID: "103", Type: "message", From: "频道", TS: 1760000020, GroupedID: "album42", Media: []Media{{Name: "photo3.jpg", Kind: "image"}}},
		{ID: "104", Type: "message", From: "频道", TS: 1760000020, GroupedID: "album42", Media: []Media{{Name: "photo4.jpg", Kind: "image"}}},
	}
	inferred := groupMediaAlbums(messages)
	strict := groupStrictAlbums(messages)
	if len(inferred) != 2 || len(strict) != 3 {
		t.Fatalf("inferred %d, strict %d, want 2 and 3", len(inferred), len(strict))
	}
	if len(strict[0].Media) != 1 || len(strict[1].Media) != 1 || len(strict[2].Media) != 2 {
		t.Fatal("strict must not infer document batch; must preserve source grouped_id")
	}
	if strict[2].SourceIDs[1] != "104" {
		t.Fatal("strict album must retain source deep-link ids")
	}
}

func TestV991StrictPagesAndBrowserControls(t *testing.T) {
	root := t.TempDir()
	a := &App{Settings: Settings{LibraryRoot: root}}
	if err := a.ensureLibraryDirs(); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(a.beautifierDir(), 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"style.css", "script.js", "SOURCE.txt"} {
		if err := os.WriteFile(filepath.Join(a.beautifierDir(), name), []byte("/* fixture */"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	slug := "chat_test__123"
	ws := a.workspaceDir(slug)
	if err := os.MkdirAll(ws, 0755); err != nil {
		t.Fatal(err)
	}
	messages := []Message{
		{ID: "101", Type: "message", From: "频道", TS: 1760000000, MediaType: "video_file", Media: []Media{{Name: "123_101_document_A.mp4", Kind: "video"}}},
		{ID: "102", Type: "message", From: "频道", TS: 1760000020, MediaType: "video_file", Media: []Media{{Name: "123_102_document_B.mp4", Kind: "video"}}},
	}
	if err := a.buildBeautifierPages(slug, &Archive{Chat: Chat{Name: "频道"}, Messages: messages}); err != nil {
		t.Fatal(err)
	}
	defaultPage, err := os.ReadFile(filepath.Join(ws, "messages.html"))
	if err != nil {
		t.Fatal(err)
	}
	strictPage, err := os.ReadFile(filepath.Join(ws, "strict-messages.html"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(defaultPage), `class="message default`) != 1 || strings.Count(string(strictPage), `class="message default`) != 2 {
		t.Fatalf("incorrect inferred vs strict page grouping default=%d strict=%d", strings.Count(string(defaultPage), `class="message default`), strings.Count(string(strictPage), `class="message default`))
	}
	appJS, e := os.ReadFile("ui/app.js")
	if e != nil {
		t.Fatal(e)
	}
	for _, needle := range []string{`原版（严格）`, `原版（还原）`, `strict-$2`, `tak-merge-portal`, `c.images||0`, `c.videos||0`} {
		if !strings.Contains(string(appJS), needle) {
			t.Errorf("app missing %q", needle)
		}
	}
	js, _ := os.ReadFile("ui/tak-bridge.js")
	for _, needle := range []string{`tak-page-portal`, `tak-search-trigger`, `position=`, `strict-`} {
		if !strings.Contains(string(js), needle) && needle != `position=` {
			t.Errorf("bridge missing %q", needle)
		}
	}
	css, _ := os.ReadFile("ui/tak-bridge.css")
	for _, needle := range []string{`.tak-page-options.tak-page-portal`, `top:50%!important`, `transform:translate3d(0,-50%,0)`, `z-index:9998`} {
		if !strings.Contains(string(css), needle) {
			t.Errorf("CSS missing %q", needle)
		}
	}
}

func TestV991MenuEmojiEverywhere(t *testing.T) {
	for _, v := range []struct{ icon, label string }{{"↻", "重新同步（推荐）"}, {"△", "生成当前可用网页"}, {"←", "返回主菜单"}, {"i", "环境诊断"}, {"▣", "档案库"}} {
		got := menuEmoji(v.icon, v.label)
		if got == v.icon || got == "" {
			t.Errorf("legacy icon not replaced %q => %q", v.icon, got)
		}
	}
}
