package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestV99VisualFixture(t *testing.T) {
	root := os.Getenv("TAK_VISUAL_FIXTURE")
	if root == "" {
		t.Skip("set TAK_VISUAL_FIXTURE to export synthetic UI")
	}
	a := &App{}
	a.Settings.LibraryRoot = root
	if err := a.ensureLibraryDirs(); err != nil {
		t.Fatal(err)
	}
	if err := a.ensureBeautifierAssets(nil); err != nil {
		t.Fatal(err)
	}
	msgs := make([]any, 0, 1105)
	epoch := time.Date(2026, 2, 1, 8, 0, 0, 0, time.UTC).Unix()
	for i := 1; i <= 1105; i++ {
		m := map[string]any{"id": i, "type": "message", "date": time.Unix(epoch+int64(i*61), 0).UTC().Format(time.RFC3339), "date_unixtime": fmt.Sprint(epoch + int64(i*61)), "from": "Archive Demo", "text": fmt.Sprintf("合成样例消息 #%d · 测试顶部与底部分页、跨页、原版消息分组。", i)}
		msgs = append(msgs, m)
	}
	src := filepath.Join(root, "sample.json")
	b, _ := json.Marshal(map[string]any{"name": "演示频道（合成数据）", "type": "public_channel", "id": 12345, "messages": msgs})
	_ = os.WriteFile(src, b, 0644)
	meta, _, err := a.importResultJSON(src)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.buildWorkspace(meta.Slug); err != nil {
		t.Fatal(err)
	}
	t.Logf("Fixture: %s", root)
}
