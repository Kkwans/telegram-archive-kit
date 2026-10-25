package render

import (
	"strings"
	"testing"

	static "telegramarchivekit/assets"
)

func TestBeautifierCompatibilityMarkup(t *testing.T) {
	chat := Chat{Name: "测试频道", ID: "1"}
	msgs := []Message{
		{ID: "1", TS: 1767225600, From: "Alice", Text: "hello"},
		{ID: "2", TS: 1767225660, From: "Alice", Text: "joined", Media: []Media{{Path: "media/1_2_a.jpg", Name: "a.jpg", Kind: "image", Size: 100}}},
	}
	h := RenderPage(chat, msgs, 1, 1)
	for _, want := range []string{`class="message default clearfix"`, `class="message default clearfix joined"`, `class="media_wrap clearfix"`, `class="photo_wrap clearfix pull_left"`, `data-date="2026-01-01"`, `class="text bold"`} {
		if !strings.Contains(h, want) {
			t.Fatalf("missing compatibility markup %s", want)
		}
	}
}

func TestEmptyServiceMessageIsNotInvented(t *testing.T) {
	if got := RenderServiceMessage(Message{ID: "9", Type: "service"}); got != "" {
		t.Fatalf("empty Telegram service message should be omitted, got %q", got)
	}
	if got := RenderServiceMessage(Message{ID: "9", Type: "service", Text: "Telegram service message"}); got != "" {
		t.Fatalf("synthetic placeholder should be omitted, got %q", got)
	}
	if got := RenderServiceMessage(Message{ID: "9", Type: "service", Text: "Alice joined"}); !strings.Contains(got, "Alice joined") {
		t.Fatalf("meaningful service text should be preserved, got %q", got)
	}
}

func TestEmbeddedViewerHidesRedundantChatHeaderBeforePaint(t *testing.T) {
	h := RenderPage(Chat{Name: "频道"}, []Message{{ID: "1", TS: 1767225600, Text: "x"}}, 1, 1)
	if !strings.Contains(h, "tak-embed-root") || !strings.Contains(h, "new URLSearchParams(location.search)") {
		t.Fatalf("embed marker should be installed in <head> before CSS paint")
	}
	b, err := static.UI.ReadFile("ui/tak-bridge.css")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "html.tak-embed-root .page_header") {
		t.Fatalf("embedded shell must hide the redundant inner page_header")
	}
}

func TestV95MergePreludeLoadedBeforeBeautifier(t *testing.T) {
	chat := Chat{Name: "Merge Test"}
	page := RenderPage(chat, []Message{{ID: "1", From: "A", Text: "one"}, {ID: "2", From: "A", Text: "two", TS: 2}}, 1, 1)
	pre := strings.Index(page, "tak-prelude.js")
	beaut := strings.Index(page, "beautifier/script.js")
	if pre < 0 || beaut < 0 || pre > beaut {
		t.Fatalf("merge prelude must load before Beautifier: pre=%d beaut=%d", pre, beaut)
	}
}
