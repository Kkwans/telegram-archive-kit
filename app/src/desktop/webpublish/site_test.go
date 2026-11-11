package webpublish

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"telegramarchivekit/internal/archive"
	"telegramarchivekit/internal/model"
)

func fixtureFile(t *testing.T, name string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, data, 0644); err != nil {
		t.Fatal(err)
	}
}

func fixtureJSON(t *testing.T, name string, value any) {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	fixtureFile(t, name, b)
}

func writeArchive(t *testing.T, workspace, name, message string, files []model.Media) {
	t.Helper()
	data, err := json.Marshal(model.Archive{Chat: model.Chat{Name: name}, Messages: []model.Message{{ID: "1", Type: "message", From: "测试", TS: 1767225600, Text: message, Media: files, Entities: []model.Entity{{Type: "text_link", Text: message, Href: "javascript:void(0)"}}}}})
	if err != nil {
		t.Fatal(err)
	}
	fixtureFile(t, filepath.Join(workspace, "data", "archive-data.js"), append(append([]byte("window.__TAK_CHAT_DATA__ = "), data...), ';'))
}

func get(t *testing.T, site http.Handler, path string, status int, byteRange string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, path, nil)
	if byteRange != "" {
		r.Header.Set("Range", byteRange)
	}
	w := httptest.NewRecorder()
	site.ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%s returned %d, want %d", path, w.Code, status)
	}
	return w
}

func TestPublishedPagesAndFilesAreScoped(t *testing.T) {
	library, external := t.TempDir(), t.TempDir()
	chat := "聊天甲"
	ws := filepath.Join(library, "chats", chat)
	ref := archive.PathToFileURL(filepath.Join(external, "视频.mp4"))
	files := []model.Media{
		{Path: ref, Name: "视频.mp4", Kind: "video"},
		{Path: "files/说明.html", Name: "说明.html", Kind: "file"},
		{Path: "source/result.json", Name: "不得发布", Kind: "file"},
		{Path: archive.PathToFileURL(filepath.Join(external, "未登记.mp4")), Name: "未登记", Kind: "video"},
	}
	writeArchive(t, ws, "公开标题", "发布测试文字", files)
	fixtureFile(t, filepath.Join(external, "视频.mp4"), []byte("0123456789"))
	fixtureFile(t, filepath.Join(external, "未登记.mp4"), []byte("hidden"))
	fixtureFile(t, filepath.Join(ws, "files", "说明.html"), []byte("<html>attachment</html>"))
	fixtureFile(t, filepath.Join(ws, "source", "result.json"), []byte(`{"private":true}`))
	fixtureJSON(t, filepath.Join(ws, "official-media-index.json"), map[string]any{"exports": []any{map[string]any{
		"meta":  model.OfficialExportMeta{Root: external, Mode: "referenced"},
		"media": map[string][]model.Media{"1": {files[0]}},
	}}})
	writeArchive(t, filepath.Join(library, "chats", "hidden"), "私有标题", "未发布内容", nil)
	manifest := model.LibraryManifest{Chats: []model.LibraryChat{
		{Slug: chat, ID: "1", Name: "公开标题", DataScript: "chats/" + chat + "/data/archive-data.js", SourceRel: "源路径标记", ReportRel: "报告路径标记"},
		{Slug: "hidden", ID: "2", Name: "私有标题", DataScript: "chats/hidden/data/archive-data.js"},
		{Slug: "raw", ID: "3", Name: "尚未生成网页"},
	}}
	fixtureJSON(t, filepath.Join(library, "library.json"), manifest)
	catalog, err := ReadCatalog(context.Background(), library)
	if err != nil {
		t.Fatal(err)
	}
	site := NewSite(library)
	defer site.Close()
	scope := Scope{Chats: []Selection{{chat, "1"}}}
	if count := site.Publish(catalog, scope); count != 1 {
		t.Fatalf("published %d chats", count)
	}
	get(t, site, "/", 200, "")
	index := get(t, site, "/library-data.js", 200, "").Body.String()
	if !strings.Contains(index, "公开标题") || strings.Contains(index, "私有标题") || strings.Contains(index, "路径标记") {
		t.Fatal("public index contains the wrong rows or fields")
	}
	base := "/chats/" + chat + "/"
	page := get(t, site, base+"messages.html", 200, "").Body.String()
	strict := get(t, site, base+"strict-messages.html", 200, "").Body.String()
	for _, body := range []string{page, strict} {
		if !strings.Contains(body, "发布测试文字") || strings.Contains(body, "javascript:") || strings.Contains(body, "file://") || strings.Contains(body, "不得发布") || strings.Contains(body, "未登记") {
			t.Fatal("rendered archive contains an unsafe or missing reference")
		}
	}
	links := regexp.MustCompile(`href="(_media/[0-9a-f]+)"`).FindAllStringSubmatch(page, -1)
	if len(links) != 2 {
		t.Fatalf("expected 2 media references, got %d", len(links))
	}
	video := get(t, site, base+links[0][1], 206, "bytes=2-5")
	if video.Body.String() != "2345" || video.Header().Get("Content-Range") != "bytes 2-5/10" {
		t.Fatal("video range does not return the requested bytes")
	}
	attachment := get(t, site, base+links[1][1], 200, "")
	if !strings.HasPrefix(attachment.Header().Get("Content-Disposition"), "attachment") {
		t.Fatal("HTML media must be downloaded as an attachment")
	}
	get(t, site, base+"data/search-index.js", 200, "")
	get(t, site, base+"data/date-index.js", 200, "")
	for _, path := range []string{base + "source/result.json", base + "data/archive-data.js", "/library.json", "/api/rpc", "/chats/hidden/messages.html", "/chats/raw/messages.html", "/assets/"} {
		get(t, site, path, 404, "")
	}
	// An update can be prepared while the previous page is still in use.
	writeArchive(t, ws, "公开标题", "更新测试文字", files)
	manifest.Chats[0].UpdatedAt = "new-generation"
	fixtureJSON(t, filepath.Join(library, "library.json"), manifest)
	updated, err := ReadCatalog(context.Background(), library)
	if err != nil {
		t.Fatal(err)
	}
	site.Publish(updated, scope)
	deadline := time.Now().Add(3 * time.Second)
	for !strings.Contains(get(t, site, base+"messages.html", 200, "").Body.String(), "更新测试文字") {
		if time.Now().After(deadline) {
			t.Fatal("published chat did not update")
		}
		time.Sleep(15 * time.Millisecond)
	}
	if count := site.Publish(updated, Scope{All: true}); count != 2 {
		t.Fatalf("whole-library publish returned %d chats", count)
	}
	get(t, site, "/chats/hidden/messages.html", 200, "")
	site.Publish(updated, Scope{Chats: []Selection{{chat, "different-chat"}}})
	get(t, site, base+links[0][1], 404, "")
	get(t, site, "/chats/hidden/messages.html", 404, "")
}

func TestListenerRejectsUnexpectedSourceAndHost(t *testing.T) {
	guard := restrict(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }), "192.168.7.2:8780", netip.MustParsePrefix("192.168.7.0/24"))
	for _, test := range []struct {
		host, peer string
		status     int
	}{
		{"192.168.7.2:8780", "192.168.7.3:33901", 204},
		{"192.168.7.2:8780", "192.168.8.3:33901", 403},
		{"example.com", "192.168.7.3:33901", 403},
	} {
		r := httptest.NewRequest(http.MethodGet, "http://"+test.host+"/", nil)
		r.RemoteAddr = test.peer
		w := httptest.NewRecorder()
		guard.ServeHTTP(w, r)
		if w.Code != test.status {
			t.Fatalf("guard returned %d, want %d", w.Code, test.status)
		}
	}
}
