package main

import (
	"strings"
	"testing"
)

func TestRC5MobilePagerMarkupKeepsOnePickerAndBothDirections(t *testing.T) {
	html := renderPager(2, 5, 0, "top", 538, 500)
	for _, want := range []string{
		`tak-page-picker-mobile`, `第 2 / 5 页`, `tak-page-count-mobile`, `538 图 · 500 视频`,
		`本页 538 图片 · 500 视频`, `href="messages.html"`, `href="messages3.html"`,
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("missing %q", want)
		}
	}
	if strings.Count(html, `class="tak-page-picker"`) != 1 {
		t.Fatal("must use one real picker per pager")
	}
	if strings.Count(html, `class="pagination block_link"`) != 2 {
		t.Fatal("both navigation actions must be present")
	}
}
