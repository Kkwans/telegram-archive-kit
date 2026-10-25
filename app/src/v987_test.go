package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestV987OriginalDocumentBatchConservative(t *testing.T) {
	now := time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC).Unix()
	video := func(id string, ts int64) Message {
		return Message{ID: id, TS: ts, Type: "message", From: "channel", MediaType: "video file", Media: []Media{{Name: "document_" + id + ".mp4", Kind: "video", Path: "media/" + id + ".mp4"}}}
	}
	rows := []Message{video("11", now), video("12", now+1), video("13", now+2), {ID: "14", TS: now + 3, Type: "message", From: "channel", Text: "caption breaks batch"}, video("15", now+4), video("17", now+6), video("18", now+105)}
	grouped := groupMediaAlbums(rows)
	if len(grouped) != 5 {
		t.Fatalf("expected a 3-document bubble and 4 others, got %d: %+v", len(grouped), grouped)
	}
	if len(grouped[0].SourceIDs) != 3 || len(grouped[0].Media) != 3 {
		t.Fatalf("document bundle not grouped: %+v", grouped[0])
	}
	if len(grouped[1].SourceIDs) != 1 || len(grouped[2].SourceIDs) != 1 {
		t.Fatal("captioned or unrelated message was merged")
	}
	h := renderBeautifierPage(Chat{Name: "channel"}, grouped, 1, 1)
	for _, id := range []string{"11", "12", "13"} {
		if !strings.Contains(h, `id="message`+id+`"`) {
			t.Errorf("lost original anchor %s", id)
		}
	}
	if strings.Count(h, `class="message default clearfix`) != 5 {
		t.Fatal("wrong number of original bubbles")
	}
}
func TestV987PreflightFFmpegAndRealDateAnimation(t *testing.T) {
	source, e := os.ReadFile("main.go")
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(source), "ensureFFmpegInstalled(ctx,") {
		t.Fatal("preflight no automatic FFmpeg")
	}
	builder, e := os.ReadFile("workspace.go")
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(builder), "ensureFFmpegInstalled(ctx,") {
		t.Fatal("manual build does not install FFmpeg")
	}
	bridge, e := os.ReadFile("ui/tak-bridge.js")
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(bridge), "window.scrollToDate(service)") {
		t.Fatal("does not invoke original Beautifier date animation")
	}
	if strings.Contains(string(bridge), "classList.add('tak-date-locating')") {
		t.Fatal("extra animation instead of reuse")
	}
}
func TestV987AllResultPagesUseUnifiedTUI(t *testing.T) {
	main, e := os.ReadFile("main.go")
	if e != nil {
		t.Fatal(e)
	}
	c, e := os.ReadFile("console_common.go")
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(main), "legacyFrameBuffer.WriteString(topFrame") || !strings.Contains(string(c), "renderFrame(legacyFrameBuffer.String())") {
		t.Fatal("legacy result screen bypasses compositor")
	}
	if !strings.Contains(string(c), `"\n\x1b[2K"`) {
		t.Fatal("does not clear stale terminal columns")
	}
}
