package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestV985GlobalRestartOnlyOnce(t *testing.T) {
	n := 0
	if !consumeGlobalRestart(&n) || n != 1 {
		t.Fatalf("first restart not consumed: %d", n)
	}
	if consumeGlobalRestart(&n) || n != 1 {
		t.Fatalf("more than one engine restart: %d", n)
	}
}
func TestV985RetryProfiles(t *testing.T) {
	for _, tc := range []struct {
		mode              string
		attempt, expected int
	}{{"increase", 1, 6}, {"increase", 2, 8}, {"increase", 100, 16}, {"increase-both", 1, 6}, {"decrease", 2, 2}, {"decrease", 20, 1}, {"keep", 3, 4}} {
		if got := retryThreads(4, tc.attempt, tc.mode); got != tc.expected {
			t.Fatalf("mode=%s attempt=%d got=%d, want=%d", tc.mode, tc.attempt, got, tc.expected)
		}
	}
}
func TestV985PerTaskElapsedAndRecentComplete(t *testing.T) {
	c := newProgressCapture(nil)
	plan := downloadPlan{IDs: map[string]int64{"2": 22000}, Names: map[string]string{"2": "sample.mp4"}, Total: 1}
	_, _ = c.Write([]byte("Chat(1):2 -> a.mp4 ... 50.0% [11.00 KB in 1s; ~ETA: 1s; 11.00 KB/s]\n"))
	active, finished := c.dashboardTasks(plan)
	if len(active) != 1 || len(finished) != 0 || active[0].ID != "2" || active[0].Elapsed == "" {
		t.Fatalf("active=%+v finished=%+v", active, finished)
	}
	_, _ = c.Write([]byte("Chat(1):2 -> a.mp4 ... done! [22.00 KB in 1.5s; 11.00 KB/s]\n"))
	active, finished = c.dashboardTasks(plan)
	if len(active) != 0 || len(finished) != 1 || finished[0].Elapsed == "" || finished[0].Name != "sample.mp4" {
		t.Fatalf("active=%+v finished=%+v", active, finished)
	}
	_, _ = c.Write([]byte("Chat(1):2 -> a.mp4 ... done! [22.00 KB in 1.5s; 11.00 KB/s]\n"))
	_, finished = c.dashboardTasks(plan)
	if len(finished) != 1 {
		t.Fatal("duplicate completion event")
	}
}
func TestV985MergeModeAndPagingPersist(t *testing.T) {
	data, _ := os.ReadFile(filepath.Join("ui", "app.js"))
	bridge, _ := os.ReadFile(filepath.Join("ui", "tak-bridge.js"))
	pre, _ := os.ReadFile(filepath.Join("ui", "tak-prelude.js"))
	for _, label := range []string{"智能合并", "原版", "同分钟合并", "同发送者合并", "媒体批次合并"} {
		if !bytes.Contains(data, []byte(label)) {
			t.Fatalf("missing label %s", label)
		}
	}
	if !bytes.Contains(bridge, []byte("query.set('mode'")) || !bytes.Contains(bridge, []byte("searchParams.set('mode'")) {
		t.Fatal("paging/search loses selected mode")
	}
	if bytes.Contains(pre, []byte("delta<=300")) {
		t.Fatal("five-minute merge should not be a separate mode")
	}
}
func TestV985BuildPhasesAndNoEmptyDate(t *testing.T) {
	dir := t.TempDir()
	a := &App{Settings: Settings{LibraryRoot: dir, GenerateThumbnails: false}}
	slug := "chat_test__7"
	_ = os.MkdirAll(filepath.Join(a.workspaceDir(slug), "source"), 0755)
	json := `{"name":"Test","type":"private_channel","id":7,"messages":[{"id":1,"type":"service","date":"2026-01-20T00:00:00","text":""},{"id":2,"type":"message","date":"2026-01-20T10:12:00","from":"Demo","text":"hello"}]}`
	if e := os.WriteFile(a.sourcePath(slug), []byte(json), 0644); e != nil {
		t.Fatal(e)
	}
	got := []string{}
	arc, e := a.buildWorkspaceModeWithProgress(slug, false, func(p OperationProgress) {
		if strings.HasPrefix(p.Stage, "步骤") {
			got = append(got, p.Stage)
		}
	})
	if e != nil {
		t.Fatal(e)
	}
	if len(got) < 8 || arc.Stats.Messages != 2 {
		t.Fatalf("stages %d stats %#v", len(got), arc.Stats)
	}
	h, e := os.ReadFile(a.firstMessagePage(slug))
	if e != nil {
		t.Fatal(e)
	}
	if bytes.Count(h, []byte(`class="message service"`)) != 1 {
		t.Fatalf("phantom date: %s", string(h))
	}
	_ = time.Second
}
