package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestV98AlbumPreservedAndAnchors(t *testing.T) {
	base := time.Date(2026, 1, 20, 10, 0, 0, 0, time.Local).Unix()
	in := []Message{
		{ID: "100", TS: base, From: "A", GroupedID: "album", Media: []Media{{Kind: "image", Path: "media/a.jpg"}}},
		{ID: "101", TS: base + 1, From: "A", GroupedID: "album", Media: []Media{{Kind: "video", Path: "media/b.mp4"}}},
		{ID: "102", TS: base + 90, From: "A", Text: "outside"},
	}
	v := groupMediaAlbums(in)
	if len(v) != 2 || len(v[0].Media) != 2 || len(v[0].SourceIDs) != 2 {
		t.Fatalf("not a real album: %#v", v)
	}
	h := renderBeautifierPage(Chat{Name: "test"}, v, 1, 1)
	if !strings.Contains(h, `id="message101"`) || !strings.Contains(h, `tak-play-overlay`) {
		t.Fatal("album member anchor or permanent video overlay missing")
	}
	if strings.Count(h, `class="message default clearfix`) != 2 {
		t.Fatal("album split into multiple messages")
	}
}
func TestV98ServiceOnlyHasNoPhantomDate(t *testing.T) {
	h := renderBeautifierPage(Chat{Name: "test"}, []Message{{ID: "1", TS: time.Now().Unix(), Type: "service", Text: "Telegram service message"}}, 1, 1)
	if strings.Contains(h, `class="message service"`) {
		t.Fatal("empty service inserted a phantom date")
	}
}
func TestV98GlobalDateIndex(t *testing.T) {
	dir := t.TempDir()
	a := &App{Settings: Settings{LibraryRoot: dir}}
	slug := "chat_demo__1"
	_ = os.MkdirAll(a.dataDir(slug), 0755)
	base := time.Date(2026, 1, 20, 10, 0, 0, 0, time.Local).Unix()
	msgs := make([]Message, 1002)
	for i := range msgs {
		msgs[i] = Message{ID: strconvI(i + 1), TS: base + int64(i)*86400, Type: "message"}
	}
	msgs[1] = Message{ID: "2", TS: base + 86400, Type: "service", Text: "Telegram service message"}
	index := visualPageIDs(msgs)
	if index["1002"] != 2 {
		t.Fatalf("wrong page %d", index["1002"])
	}
	if err := a.writeDateIndex(slug, &Archive{Messages: msgs}); err != nil {
		t.Fatal(err)
	}
	raw, e := os.ReadFile(filepath.Join(a.dataDir(slug), "date-index.js"))
	if e != nil {
		t.Fatal(e)
	}
	body := strings.TrimSuffix(strings.TrimPrefix(string(raw), "window.__TAK_DATES__ = "), ";\n")
	var records []struct {
		Date  string `json:"date"`
		Count int    `json:"count"`
		Page  int    `json:"page"`
	}
	if err := json.Unmarshal([]byte(body), &records); err != nil {
		t.Fatal(err)
	}
	if len(records) != 1001 {
		t.Fatalf("phantom date included: %d", len(records))
	}
	if records[len(records)-1].Page != 2 {
		t.Fatal("cross-page dates not indexed")
	}
}
func strconvI(n int) string { return fmt.Sprintf("%d", n) }
func TestV98FilterDownloadJSON(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "in.json")
	dst := filepath.Join(dir, "out.json")
	_ = os.WriteFile(src, []byte(`{"name":"test","messages":[{"id":1,"file":"a"},{"id":2,"file":"b"},{"id":3,"file":"c"}]}`), 0644)
	n, e := filterDownloadJSON(src, map[string]bool{"2": true}, nil, dst)
	if e != nil || n != 2 {
		t.Fatalf("filter %d: %v", n, e)
	}
	b, _ := os.ReadFile(dst)
	if strings.Contains(string(b), `"id":2`) {
		t.Fatal("stalled message was not parked")
	}
	n, e = filterDownloadJSON(src, nil, map[string]bool{"2": true}, dst)
	if e != nil || n != 1 {
		t.Fatal("individual retry selection failed")
	}
}

func TestV98PageSelectAndMergedModeAssets(t *testing.T) {
	msgs := make([]Message, 1001)
	for i := range msgs {
		msgs[i] = Message{ID: strconvI(i + 1), Type: "message", Text: "x", From: "sender"}
	}
	pages := visualPages(msgs)
	if len(pages) != 2 {
		t.Fatalf("expected 2 pages, got %d", len(pages))
	}
	h := renderBeautifierPage(Chat{Name: "test"}, pages[1], 2, 2)
	for _, s := range []string{`第 2 / 2 页`, `tak-page-jump`, `messages.html`, `tak-prelude.js`, `date-index.js`} {
		if !strings.Contains(h, s) {
			t.Errorf("page missing %q", s)
		}
	}
	data, _ := os.ReadFile(filepath.Join("ui", "tak-prelude.js"))
	for _, s := range []string{"classic", "original", "minute", "sender", "media"} {
		if !strings.Contains(string(data), s) {
			t.Errorf("missing merge mode %s", s)
		}
	}
}

func TestV98VideoThumbnailWithFFmpeg(t *testing.T) {
	ff := findFFmpeg()
	if ff == "" {
		t.Skip("FFmpeg is optional on the test host")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "in.mp4")
	dst := filepath.Join(dir, "thumb.jpg")
	cmd := exec.Command(ff, "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=128x72:d=2", "-c:v", "mpeg4", "-y", src)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("test ffmpeg unable to encode: %v %s", err, string(out))
	}
	if err := createVideoThumbnail(src, dst); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(dst)
	if err != nil || len(b) < 100 || b[0] != 0xff || b[1] != 0xd8 {
		t.Fatal("bad generated JPEG video preview")
	}
}

func TestV98FaviconAndShellDateNav(t *testing.T) {
	for _, f := range []string{"ui/favicon.svg", "ui/favicon.ico"} {
		if _, e := os.Stat(f); e != nil {
			t.Fatal(e)
		}
	}
	b, _ := os.ReadFile(filepath.Join("ui", "app.js"))
	s := string(b)
	for _, q := range []string{"data-date-open", "date-index.js", "data-merge-mode", "state.anchor"} {
		if !strings.Contains(s, q) {
			t.Errorf("shell lacks %s", q)
		}
	}
}
