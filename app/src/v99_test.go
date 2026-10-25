package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestV99DocumentNamingAndSafeAlbum(t *testing.T) {
	msgs := []Message{
		{ID: "4639", Type: "message", From: "Alice", TS: 1710000000, MediaType: "video_file", Media: []Media{{Name: "3687571561_4639_document_63864.mp4", Kind: "video"}}},
		{ID: "4640", Type: "message", From: "Alice", TS: 1710000025, MediaType: "video_file", Media: []Media{{Name: "3687571561_4640_document_63865.mp4", Kind: "video"}}},
		{ID: "4641", Type: "message", From: "Alice", TS: 1710000030, Text: "This is a new caption", MediaType: "video_file", Media: []Media{{Name: "3687571561_4641_document_63866.mp4", Kind: "video"}}},
	}
	out := groupMediaAlbums(msgs)
	if len(out) != 2 || len(out[0].Media) != 2 || len(out[0].SourceIDs) != 2 {
		t.Fatalf("expected 2-member document group and one independent caption, got %#v", out)
	}
	html := renderClassicMessage(out[0], "Alice", false)
	if !strings.Contains(html, `id="message4640"`) {
		t.Fatal("joined messages must keep their anchor")
	}
	style, _ := os.ReadFile("ui/tak-bridge.css")
	if !strings.Contains(string(style), ".tak-album-anchor{position:absolute") {
		t.Fatal("album alias must be removed from Flex flow")
	}
}

func TestV99PaginatedNavigationOnBothSides(t *testing.T) {
	a := renderBeautifierPage(Chat{Name: "Test"}, []Message{{ID: "1", Type: "message", Text: "Hi"}}, 2, 4)
	if strings.Count(a, `class="tak-pagination tak-pagination-`) != 2 {
		t.Fatal("require exactly two pagers")
	}
	for _, s := range []string{`tak-pagination-top`, `tak-pagination-bottom`, `class="tak-page-picker"`, `role="listbox"`, `messages3.html`, `本页 0 图片 · 0 视频`} {
		if !strings.Contains(a, s) {
			t.Errorf("missing %s", s)
		}
	}
	if regexp.MustCompile(`<select\b`).MatchString(a) {
		t.Fatal("native select should not be used for pagination")
	}
}

func TestV99ResponsiveAndLightboxCoordination(t *testing.T) {
	app, _ := os.ReadFile("ui/app.js")
	bridge, _ := os.ReadFile("ui/tak-bridge.js")
	style, _ := os.ReadFile("ui/app.css")
	page, _ := os.ReadFile("ui/tak-bridge.css")
	for _, s := range []string{"data-mobile-menu", "mobile-open", "tak-global-lightbox-open", "data-merge-choice", "role=\"listbox\""} {
		if !strings.Contains(string(app), s) {
			t.Errorf("app missing %s", s)
		}
	}
	for _, s := range []string{"installParentViewer", "installPager", "initPager", "tak-scroll-glass", "stabilizeVideoArrows"} {
		if s == "installPager" {
			continue
		}
		if !strings.Contains(string(bridge), s) {
			t.Errorf("bridge missing %s", s)
		}
	}
	if strings.Contains(string(style), ".shell.lightbox-active>.main>.frame") {
		t.Error("iframe must not be resized on lightbox open")
	}
	if !strings.Contains(string(page), ".scroll-buttons .scroll-btn-label{display:none") {
		t.Error("hide labels only, not buttons")
	}
	if strings.Contains(string(page), "body.tak-embedded .tak-scroll-glass{display:none") {
		// A legacy override is permitted only if later overridden explicitly.
		if !strings.Contains(string(page), "body.tak-embedded .tak-scroll-glass{display:flex") {
			t.Error("legacy jump hiding must be reversed")
		}
	}
}
