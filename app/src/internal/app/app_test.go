package app

import (
	"encoding/json"
	"image"
	imagecolor "image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"testing"

	static "telegramarchivekit/assets"
	"telegramarchivekit/internal/archive"
)

func TestStableSlugByID(t *testing.T) {
	if got := stableSlug(Chat{Name: "中文频道", ID: "-100123456"}); got != "chat_中文频道__-100123456" {
		t.Fatalf("unexpected slug %q", got)
	}
}

func TestMergeExportRootsByMessageID(t *testing.T) {
	old := map[string]any{"name": "A", "messages": []any{map[string]any{"id": json.Number("1"), "text": "old"}, map[string]any{"id": json.Number("2"), "text": "keep"}}}
	newer := map[string]any{"name": "A2", "messages": []any{map[string]any{"id": json.Number("1"), "text": "new"}, map[string]any{"id": json.Number("3"), "text": "add"}}}
	m := mergeExportRoots(old, newer)
	arr := m["messages"].([]any)
	if len(arr) != 3 {
		t.Fatalf("want 3 messages got %d", len(arr))
	}
	seen := map[string]string{}
	for _, it := range arr {
		mm := it.(map[string]any)
		seen[archive.AnyString(mm["id"])] = archive.AnyString(mm["text"])
	}
	if seen["1"] != "new" || seen["2"] != "keep" || seen["3"] != "add" {
		t.Fatalf("bad merge: %#v", seen)
	}
}

func TestThumbnailGeneration(t *testing.T) {
	d := t.TempDir()
	a := &App{Settings: defaultSettings()}
	a.Settings.LibraryRoot = d
	slug := "chat_1"
	mediaDir := a.mediaDir(slug)
	if err := os.MkdirAll(mediaDir, 0755); err != nil {
		t.Fatal(err)
	}
	// Tiny valid JPEG generated through the same stdlib encoder used by the app.
	img := image.NewRGBA(image.Rect(0, 0, 8, 6))
	for y := 0; y < 6; y++ {
		for x := 0; x < 8; x++ {
			img.Set(x, y, imagecolor.RGBA{uint8(x * 20), uint8(y * 25), 120, 255})
		}
	}
	p := filepath.Join(mediaDir, "1_7_photo.jpg")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(f, img, nil); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	st, _ := os.Stat(p)
	arc := &Archive{Messages: []Message{{ID: "7", Media: []Media{{Path: "media/1_7_photo.jpg", Name: "1_7_photo.jpg", Kind: "image", Size: st.Size()}}}}}
	a.ensureImageThumbnails(slug, arc)
	if arc.Messages[0].Media[0].Thumb == "" {
		t.Fatal("thumbnail path missing")
	}
	if !fileExists(filepath.Join(a.workspaceDir(slug), filepath.FromSlash(arc.Messages[0].Media[0].Thumb))) {
		t.Fatal("thumbnail file missing")
	}
}

func TestLoadDownloadPlan(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "missing.json")
	root := map[string]any{"messages": []any{map[string]any{"id": 1, "media_type": "photo", "file_size": 1024}, map[string]any{"id": 2, "file": "x.mp4", "file_size": 2048}, map[string]any{"id": 3, "photo": "photos/a.jpg"}, map[string]any{"id": 4, "text": "plain text"}}}
	b, _ := json.Marshal(root)
	if err := os.WriteFile(p, b, 0644); err != nil {
		t.Fatal(err)
	}
	plan, err := loadDownloadPlan(p)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Total != 3 || plan.KnownCount != 2 || plan.KnownBytes != 3072 {
		t.Fatalf("bad plan: %#v", plan)
	}
}

func TestLibraryShellHasNoGlobalThemeClickTrap(t *testing.T) {
	b, err := static.UI.ReadFile("ui/app.js")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if strings.Contains(s, "[data-theme]") || strings.Contains(s, "document.documentElement.dataset.theme") {
		t.Fatalf("library shell must not bind a global data-theme click target")
	}
	if !strings.Contains(s, "data-side") || !strings.Contains(s, "sidebar-collapsed") {
		t.Fatalf("library shell should keep explicit collapsible navigation")
	}
}

func TestShellNavigationAvoidsV6AIPatterns(t *testing.T) {
	jsb, err := static.UI.ReadFile("ui/app.js")
	if err != nil {
		t.Fatal(err)
	}
	js := string(jsb)
	// The exit affordance is intentionally mobile-only: unlike desktop,
	// phones have no Escape key to leave immersive reading mode.
	bridge, err := static.UI.ReadFile("ui/tak-bridge.js")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(js, `tak-toggle-focus`) || !strings.Contains(string(bridge), `installMobileFocusControl()`) || !strings.Contains(string(bridge), `tak-focus-trigger`) {
		t.Fatalf("mobile immersion control must live beside search inside chat iframe")
	}
	brand := strings.Index(js, `class="brand"`)
	side := strings.Index(js, "data-side")
	if brand < 0 || side < brand {
		t.Fatalf("sidebar toggle should live in the sidebar brand area")
	}
	cssb, err := static.UI.ReadFile("ui/app.css")
	if err != nil {
		t.Fatal(err)
	}
	css := string(cssb)
	if !strings.Contains(css, ".topbar>.desktop-focus{display:none!important") || !strings.Contains(css, ".shell.focus{grid-template-rows:0 minmax(0,1fr)!important") {
		t.Fatalf("mobile must hide desktop header focus and focus must remove top grid track")
	}
	if strings.Contains(css, ".chat.active:before") || strings.Contains(css, ".chat.active::before") {
		t.Fatalf("active chat must not use the v6 thick left selection stripe")
	}
}

func TestTdlFailureClassification(t *testing.T) {
	netErr := classifyTdlFailure("Error: group:\nconnection dead: retry limit reached", nil, "x.log")
	if netErr.Kind != tdlFailureNetwork {
		t.Fatalf("expected network failure, got %#v", netErr)
	}
	authErr := classifyTdlFailure("AUTH_KEY_UNREGISTERED", nil, "x.log")
	if authErr.Kind != tdlFailureAuth {
		t.Fatalf("expected auth failure, got %#v", authErr)
	}
	if got := summarizeTdlError("prefix text\nconnection reset by peer"); !strings.Contains(strings.ToLower(got), "connection reset") {
		t.Fatalf("unexpected summary %q", got)
	}
}

func TestProgressCaptureAggregatesConcurrentRates(t *testing.T) {
	c := newProgressCapture(nil)
	_, _ = c.Write([]byte("Chat(1):55 -> x ... 30.0% [127 MB in 50s; 3.50 MB/s]\nChat(1):56 -> y ... 48.0% [121 MB in 46s; 4.25 MB/s]\n"))
	_, speeds, rows := c.snapshot()
	if len(rows) != 2 {
		t.Fatalf("want 2 task rows, got %d", len(rows))
	}
	got := sumRates(speeds)
	want := (3.50 + 4.25) * 1024 * 1024
	if got < want-1 || got > want+1 {
		t.Fatalf("aggregate rate got %.2f want %.2f", got, want)
	}
}

func TestBareTdlGroupErrorIsTransient(t *testing.T) {
	f := classifyTdlFailure("Error: group:", nil, "x.log")
	if f.Kind != tdlFailureNetwork {
		t.Fatalf("generic tdl errgroup wrapper should enter bounded transient retry, got %#v", f)
	}
}

func TestProgressStartsFromActualExistingFiles(t *testing.T) {
	lib := t.TempDir()
	a := &App{Settings: defaultSettings()}
	a.Settings.LibraryRoot = lib
	slug := "chat_Test__1"
	if err := os.MkdirAll(a.mediaDir(slug), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a.mediaDir(slug), "99_1_a.jpg"), []byte("abc"), 0644); err != nil {
		t.Fatal(err)
	}
	plan := downloadPlan{IDs: map[string]int64{"1": 3, "2": 4}, Total: 2, KnownBytes: 7, KnownCount: 2}
	done, bytes := a.downloadProgressState(slug, plan, nil)
	if done != 1 || bytes != 3 {
		t.Fatalf("resume baseline should be 1/2 and 3 bytes, got %d/%d", done, bytes)
	}
}

func TestGenerateMissingJSONSkipsActuallyDownloadedMedia(t *testing.T) {
	lib := t.TempDir()
	a := &App{Settings: defaultSettings()}
	a.Settings.LibraryRoot = lib
	slug := "chat_续传测试__368"
	if err := os.MkdirAll(filepath.Dir(a.sourcePath(slug)), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(a.mediaDir(slug), 0755); err != nil {
		t.Fatal(err)
	}
	root := map[string]any{"name": "续传测试", "type": "private_channel", "id": 368, "messages": []any{
		map[string]any{"id": 1, "type": "message", "date": "2026-01-01T00:00:00", "media_type": "photo", "photo": "x", "file_size": 3},
		map[string]any{"id": 2, "type": "message", "date": "2026-01-01T00:01:00", "media_type": "photo", "photo": "y", "file_size": 5},
	}}
	b, _ := json.Marshal(root)
	if err := os.WriteFile(a.sourcePath(slug), b, 0644); err != nil {
		t.Fatal(err)
	}
	// tdl default filename contains dialogID_messageID_filename.
	if err := os.WriteFile(filepath.Join(a.mediaDir(slug), "368_1_done.jpg"), []byte("abc"), 0644); err != nil {
		t.Fatal(err)
	}
	count, path, err := a.generateMissingJSON(slug)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected only one missing media after restart, got %d", count)
	}
	plan, err := loadDownloadPlan(path)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Total != 1 {
		t.Fatalf("missing.json should contain one media item, got %#v", plan)
	}
	if _, ok := plan.IDs["2"]; !ok {
		t.Fatalf("message 2 should remain missing: %#v", plan.IDs)
	}
	if _, ok := plan.IDs["1"]; ok {
		t.Fatalf("already downloaded message 1 must not be scheduled again")
	}
}

func TestV9QuickJSONImportDefersViewerBuild(t *testing.T) {
	lib := t.TempDir()
	a := &App{Settings: defaultSettings(), ConfigDir: t.TempDir()}
	a.Settings.LibraryRoot = lib
	jsonPath := filepath.Join(t.TempDir(), "result.json")
	root := map[string]any{"name": "Quick", "type": "private_channel", "id": 9, "messages": []any{map[string]any{"id": 1, "type": "message", "date": "2026-01-01T00:00:00", "text": "hello"}}}
	b, _ := json.Marshal(root)
	if err := os.WriteFile(jsonPath, b, 0644); err != nil {
		t.Fatal(err)
	}
	meta, _, err := a.importResultJSONMode(jsonPath, false)
	if err != nil {
		t.Fatal(err)
	}
	if meta.MessageCount != 1 {
		t.Fatalf("unexpected meta %#v", meta)
	}
	if fileExists(filepath.Join(a.workspaceDir(meta.Slug), "messages.html")) {
		t.Fatalf("quick import must not eagerly rebuild Viewer")
	}
}

func TestV9TaskLineIsHumanReadable(t *testing.T) {
	plan := downloadPlan{IDs: map[string]int64{"751": 800 * 1024 * 1024}, Names: map[string]string{"751": "movie.mp4"}, Total: 1}
	line := "Chat(1):751 -> C:\\~ ... 11.0% [88.00 MB in 17.347s; ~ETA: 2m36s; 5.07 MB/s]"
	got := ansiRE.ReplaceAllString(formatTdlTaskLine(line, plan), "")
	for _, want := range []string{"Message #751", "movie.mp4", "11.0%", "88.0 MB", "800 MB", "5.07 MB/s", "剩余约 2分36秒"} {
		if !strings.Contains(got, want) {
			t.Fatalf("%q missing from %q", want, got)
		}
	}
}

func TestV95DefaultsEnableThumbnailsAndStallRecovery(t *testing.T) {
	s := defaultSettings()
	if !s.GenerateThumbnails {
		t.Fatal("v9.5 must enable thumbnail generation by default")
	}
	if s.StallTimeoutSeconds != 60 {
		t.Fatalf("unexpected stall timeout: %d", s.StallTimeoutSeconds)
	}
	if s.AdaptiveConcurrency {
		t.Fatal("adaptive concurrency should be disabled by default")
	}
}

func TestAdaptiveTransferProfile(t *testing.T) {
	cases := []struct{ level, c, th int }{
		{0, 4, 4},
		{1, 2, 4},
		{2, 1, 2},
		{3, 1, 1},
	}
	for _, tc := range cases {
		c, th := adaptiveTransferProfile(4, 4, tc.level, true)
		if c != tc.c || th != tc.th {
			t.Fatalf("level %d got %dx%d want %dx%d", tc.level, c, th, tc.c, tc.th)
		}
	}
}

func TestV95MigratesLegacyThumbnailDefault(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config.json")
	if err := os.WriteFile(cfg, []byte(`{"concurrent":4,"threads":4,"generate_thumbnails":false}`), 0644); err != nil {
		t.Fatal(err)
	}
	a := &App{ConfigDir: dir, ConfigPath: cfg, Settings: defaultSettings()}
	if err := a.loadSettings(); err != nil {
		t.Fatal(err)
	}
	if !a.Settings.GenerateThumbnails || a.Settings.SchemaVersion != 985 {
		t.Fatalf("legacy migration failed: %#v", a.Settings)
	}
	if a.Settings.Concurrent != 4 || a.Settings.Threads != 4 {
		t.Fatal("migration must preserve user transfer settings")
	}
}

func TestV95ViewerHasMergeSwitch(t *testing.T) {
	app, err := static.UI.ReadFile("ui/app.js")
	if err != nil {
		t.Fatal(err)
	}
	s := string(app)
	for _, want := range []string{"data-merge", "tak-merge-messages", "mode=${encodeURIComponent(state.merge)}"} {
		if !strings.Contains(s, want) {
			t.Fatalf("viewer merge switch missing %q", want)
		}
	}
	pre, err := static.UI.ReadFile("ui/tak-prelude.js")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(pre), "classList.toggle('joined'") {
		t.Fatal("prelude must disable joined class in unmerged mode")
	}
}
