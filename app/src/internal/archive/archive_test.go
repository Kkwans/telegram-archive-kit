package archive

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestMediaMatchingTdlDefault(t *testing.T) {
	d := t.TempDir()
	media := filepath.Join(d, "media")
	if err := os.MkdirAll(media, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(media, "3687571561_55_video.mp4"), []byte("abc"), 0644); err != nil {
		t.Fatal(err)
	}
	by, _, err := ScanMedia(media)
	if err != nil {
		t.Fatal(err)
	}
	if len(by["55"]) != 1 {
		t.Fatalf("expected message 55 media match, got %#v", by)
	}
}

func TestOfficialExportIndexAndInheritance(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "photos"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "photos", "photo_1.jpg"), []byte("abc"), 0644); err != nil {
		t.Fatal(err)
	}
	html := `<!doctype html><div class="page_header"><div class="text bold">小美</div></div><div class="history"><div class="message default clearfix" id="message1"><div class="body"><a class="photo_wrap clearfix pull_left" href="photos/photo_1.jpg">photo</a></div></div><div class="message default clearfix" id="message2"><div class="body"><div class="text">later</div></div></div></div>`
	if err := os.WriteFile(filepath.Join(root, "messages.html"), []byte(html), 0644); err != nil {
		t.Fatal(err)
	}
	ws := t.TempDir()
	meta, media, err := AnalyzeOfficialExport(root, ws, "referenced")
	if err != nil {
		t.Fatal(err)
	}
	if meta.Name != "小美" || meta.MessageCount != 2 || meta.MediaFiles != 1 || len(media["1"]) != 1 {
		t.Fatalf("bad official scan meta=%#v media=%#v", meta, media)
	}
	jsonPath := filepath.Join(ws, "result.json")
	payload := map[string]any{"name": "小美", "type": "personal_chat", "id": 99, "messages": []any{
		map[string]any{"id": 1, "type": "message", "date": "2026-01-01T00:00:00", "media_type": "photo", "photo": "(File not included)", "file_size": 3},
		map[string]any{"id": 2, "type": "message", "date": "2026-01-02T00:00:00", "media_type": "photo", "photo": "(File not included)", "file_size": 5},
	}}
	b, _ := json.Marshal(payload)
	if err := os.WriteFile(jsonPath, b, 0644); err != nil {
		t.Fatal(err)
	}
	arc, err := BuildArchiveWithExtra(jsonPath, filepath.Join(ws, "media"), media)
	if err != nil {
		t.Fatal(err)
	}
	if arc.Stats.MissingMedia != 1 || len(arc.Missing) != 1 || arc.Missing[0] != "2" {
		t.Fatalf("official media should satisfy msg1, missing=%v", arc.Missing)
	}
}
