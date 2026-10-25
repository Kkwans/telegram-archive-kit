package main

import (
	"os"
	"strings"
	"testing"
)

func TestV998RegressionGuards(t *testing.T) {
	js, err := os.ReadFile("ui/tak-bridge.js")
	if err != nil {
		t.Fatal(err)
	}
	css, err := os.ReadFile("ui/tak-bridge.css")
	if err != nil {
		t.Fatal(err)
	}
	appJS, err := os.ReadFile("ui/app.js")
	if err != nil {
		t.Fatal(err)
	}
	appCSS, err := os.ReadFile("ui/app.css")
	if err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{"resultScroller.scrollTop", "e.stopPropagation()", "tak-search-highlight", "clearTimeout(previous.stop)", "options.style.maxHeight"} {
		if !strings.Contains(string(js), token) {
			t.Errorf("v998 bridge JS missing %q", token)
		}
	}
	for _, token := range []string{".tak-page-options.tak-page-portal{", "position:fixed!important", ".tak-search-highlight.is-active", "overscroll-behavior:contain", "--tak-fab-bg:rgba(235,242,255,.27)"} {
		if !strings.Contains(string(css), token) {
			t.Errorf("v998 bridge CSS missing %q", token)
		}
	}
	for _, token := range []string{"icons.panelOpen", "icons.panelClose", "setAttribute('aria-label'"} {
		if !strings.Contains(string(appJS), token) {
			t.Errorf("v998 app JS missing %q", token)
		}
	}
	for _, token := range []string{".merge-options.tak-merge-portal", ".sidebar-collapsed .side-foot .collapse-btn .collapse-label{display:none!important}"} {
		if !strings.Contains(string(appCSS), token) {
			t.Errorf("v998 app CSS missing %q", token)
		}
	}
}
