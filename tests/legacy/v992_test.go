package main

import (
	"os"
	"strings"
	"testing"
)

func TestV992FullViewportLightboxWithoutBlankSidebar(t *testing.T) {
	css, err := os.ReadFile("ui/app.css")
	if err != nil {
		t.Fatal(err)
	}
	js, err := os.ReadFile("ui/app.js")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(css), ".shell.lightbox-active>.main>.frame") {
		t.Error("v9.9.5 must not resize the iframe on lightbox open")
	}
	viewer, err := os.ReadFile("ui/tak-lightbox.css")
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{".tak-global-lightbox", "position:fixed", "inset:0"} {
		if !strings.Contains(string(viewer), key) {
			t.Errorf("viewer css missing %q", key)
		}
	}
	for _, invalid := range []string{".shell.lightbox-active>.sidebar{visibility:hidden", ".shell.lightbox-active>.topbar{visibility:hidden"} {
		if strings.Contains(string(css), invalid) {
			t.Errorf("must not blank parent chrome: %q", invalid)
		}
	}
	if !strings.Contains(string(js), "e.source===frame.contentWindow") {
		t.Error("only the current iframe may control lightbox state")
	}
	if !strings.Contains(string(js), `src="favicon.ico"`) {
		t.Error("sidebar must use exe favicon.ico")
	}
}

func TestV992MergeModesAndMenus(t *testing.T) {
	js, err := os.ReadFile("ui/app.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{`data-merge-choice="classic"`, `data-merge-choice="original"`, `data-merge-choice="reconstructed"`, `data-merge-choice="minute"`, `data-merge-choice="sender"`, `data-merge-choice="media"`, `原版（还原）`, `mergeMenuAbort.abort()`, `document.addEventListener('pointerdown',outside`, `document.addEventListener('focusin',outside`} {
		if !strings.Contains(string(js), mode) {
			t.Errorf("merge menu missing %q", mode)
		}
	}
	css, err := os.ReadFile("ui/app.css")
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"width:136px!important", ".merge-menu-separator", ".merge-options button[aria-selected=true]"} {
		if !strings.Contains(string(css), key) {
			t.Errorf("merge css missing %q", key)
		}
	}
}

func TestV992PagingAndJumpControls(t *testing.T) {
	page := renderPager(2, 5, 123, "top")
	for _, key := range []string{`aria-selected="true"`, `class="tak-chevron"`, `aria-label="聊天分页列表"`, `第 2 页`} {
		if !strings.Contains(page, key) {
			t.Errorf("pager markup missing %q", key)
		}
	}
	if strings.Contains(page, `aria-hidden="true">⌄`) {
		t.Error("legacy off-center dropdown glyph")
	}
	css, err := os.ReadFile("ui/tak-bridge.css")
	if err != nil {
		t.Fatal(err)
	}
	js, err := os.ReadFile("ui/tak-bridge.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{`a[aria-selected="true"]`, `text-align:center!important`, `a::before`, `data-tak-unavailable="true"`, `grid-template-rows:var(--tak-fab) var(--tak-fab)`, `--tak-fab-gap:14px`, `bottom:18px!important`} {
		if !strings.Contains(string(css), k) {
			t.Errorf("bridge css missing %q", k)
		}
	}
	for _, k := range []string{"syncJumpAvailability", "requestAnimationFrame", "window.addEventListener('scroll'", "document.addEventListener('pointerdown',outside"} {
		if !strings.Contains(string(js), k) {
			t.Errorf("bridge JS missing %q", k)
		}
	}
}
