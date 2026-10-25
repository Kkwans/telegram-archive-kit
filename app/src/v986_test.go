package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestV986UnifiedTerminalFrame(t *testing.T) {
	f := composeFrame(topFrame("同步进度", "示例聊天") + uiLead() + "状态概览\n" + uiLead() + "  媒体文件：4698\n" + uiLead() + "  " + progressBar(15, 20, uiInnerWidth()-2) + "\n" + uiLead() + "Esc 中止\n")
	plain := ansiRE.ReplaceAllString(f, "")
	plain = strings.ReplaceAll(strings.ReplaceAll(plain, "\x1b[H", ""), "\x1b[J", "")
	rows := strings.Split(strings.TrimRight(plain, "\n"), "\n")
	if len(rows) < 9 {
		t.Fatalf("frame missing border sections: %q", plain)
	}
	width := visibleWidth(rows[0])
	if width != uiInnerWidth()+6+visibleWidth(uiLead()) {
		t.Fatalf("outer width %d want %d", width, uiInnerWidth()+6+visibleWidth(uiLead()))
	}
	for n, row := range rows {
		if n == 0 {
			continue
		}
		if visibleWidth(row) != width {
			t.Errorf("row %d width %d expected %d: %q", n, visibleWidth(row), width, row)
		}
	}
	if !strings.Contains(plain, "╭") || !strings.Contains(plain, "╰") || strings.Count(plain, "├") < 2 {
		t.Fatal("unclosed or missing common frame")
	}
}
func TestV986EmojiColumns(t *testing.T) {
	for _, glyph := range []string{"🚀", "📥", "🗂️", "💾", "⚙️", "➕", "🔐"} {
		if got := visibleWidth(glyph); got != 2 {
			t.Errorf("%q got %d display cols, want 2", glyph, got)
		}
	}
}
func TestV986OriginalModeDoesNotInferMinuteAlbum(t *testing.T) {
	js, e := os.ReadFile("ui/tak-prelude.js")
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Contains(js, []byte("if(mode==='original'||mode==='reconstructed')joined=false")) {
		t.Fatal("original mode still guesses time-based grouping")
	}
}
func TestV986PaginationAndGlobalDateAnimation(t *testing.T) {
	css, e := os.ReadFile("ui/tak-bridge.css")
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Contains(css, []byte(".tak-pagination a.pagination:before")) {
		t.Fatal("hover underline pseudo not disabled")
	}
	app, e := os.ReadFile("ui/app.js")
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Contains(app, []byte("state.dateTarget=r.date")) {
		t.Fatal("global navigation does not preserve target date")
	}
	bridge, e := os.ReadFile("ui/tak-bridge.js")
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Contains(bridge, []byte("params.get('date')")) {
		t.Fatal("date locator not using target date")
	}
}
func TestV986VisualFixture(t *testing.T) {
	root := os.Getenv("TAK_VISUAL_DIR")
	if root == "" {
		return
	}
	if e := os.MkdirAll(root, 0755); e != nil {
		t.Fatal(e)
	}
	a := &App{Settings: Settings{LibraryRoot: root, GenerateThumbnails: false}}
	if e := a.ensureLibraryDirs(); e != nil {
		t.Fatal(e)
	}
	msgs := make([]any, 0, 1105)
	base := time.Date(2026, 1, 20, 12, 0, 0, 0, time.UTC)
	for n := 1; n <= 1105; n++ {
		ts := base.Add(time.Duration(n) * time.Minute)
		m := map[string]any{"id": n, "type": "message", "date": ts.Format(time.RFC3339), "date_unixtime": ts.Unix(), "from": "测试频道", "text": "Hello from Telegram #" + strings.Repeat("文字", n%9)}
		msgs = append(msgs, m)
	}
	data, _ := json.Marshal(map[string]any{"name": "测试频道 · 分页与日期", "type": "private_channel", "id": 23456, "messages": msgs})
	source := filepath.Join(root, "visual-result.json")
	_ = os.WriteFile(source, data, 0644)
	meta, _, e := a.importResultJSON(source)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = a.buildWorkspace(meta.Slug); e != nil {
		t.Fatal(e)
	}
}
