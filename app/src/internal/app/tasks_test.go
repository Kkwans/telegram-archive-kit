package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBackgroundTaskLifecycle(t *testing.T) {
	f := &Facade{}
	id := f.startTask("test", "测试任务", func(task *backgroundTask) error {
		task.update(45, "处理中")
		return nil
	})
	if id == "" {
		t.Fatal("expected task id")
	}
	var last TaskDTO
	for i := 0; i < 100; i++ {
		last = f.Tasks()[0]
		if last.State != "running" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if last.State != "done" || last.Percent != 100 {
		t.Fatalf("unexpected final task: %#v", last)
	}
	f.ClearFinishedTasks()
	if got := len(f.Tasks()); got != 0 {
		t.Fatalf("finished tasks must be cleared, got %d", got)
	}
}

func TestDownloadTaskHistoryPersists(t *testing.T) {
	f := &Facade{a: &App{ConfigDir: t.TempDir()}}
	task := f.createTask("sync", "同步聊天：测试", "测试")
	task.setSlug("chat-test")
	task.updateDownload(DownloadSnapshot{
		State: "正在下载", Percent: 25, Done: 1, Total: 4,
		SpeedNow: 1024, SpeedAvg: 900, SpeedPeak: 1200, Bytes: 4096, ElapsedMs: 2000, ETAMs: 3000,
		Active:    []TaskProgress{{ID: "2", Name: "clip.mp4", Kind: "video", Percent: 42, Transferred: 512, Expected: 1024, Speed: 512, ETAMs: 1500}},
		Completed: []TaskProgress{{ID: "1", Name: "photo.jpg", Kind: "image", Done: true, Percent: 100, Expected: 2048, Transferred: 2048, ElapsedMs: 800}},
	})
	task.mu.Lock()
	task.lastSampleAt = time.Now().Add(-2 * time.Second)
	task.mu.Unlock()
	task.updateDownload(DownloadSnapshot{
		State: "正在下载", Percent: 50, Done: 2, Total: 4,
		SpeedNow: 2048, SpeedAvg: 1500, SpeedPeak: 2048, Bytes: 8192, ElapsedMs: 4000, ETAMs: 3000,
		Active:    []TaskProgress{{ID: "3", Name: "song.mp3", Kind: "audio", Percent: 10, Transferred: 64, Expected: 640, Speed: 128, ETAMs: 1200}},
		Completed: []TaskProgress{{ID: "1", Name: "photo.jpg", Kind: "image", Done: true, Percent: 100, Expected: 2048, Transferred: 2048, ElapsedMs: 800}},
	})
	running, err := f.TaskDetail(task.snapshot().ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(running.Active) != 1 || running.Active[0].Name != "song.mp3" || running.ETAMs != 3000 {
		t.Fatalf("unexpected active media: %#v", running)
	}
	task.finish(nil)
	f.saveTasks()

	detail, err := f.TaskDetail(task.snapshot().ID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.State != "done" || detail.AvgSpeed != 1500 || detail.PeakSpeed != 2048 {
		t.Fatalf("unexpected detail: %#v", detail)
	}
	if len(detail.Series) < 2 {
		t.Fatalf("expected persisted speed samples, got %d", len(detail.Series))
	}
	if len(detail.Active) != 0 || len(detail.Completed) != 1 || detail.Completed[0].Name != "photo.jpg" {
		t.Fatalf("unexpected media lists: active=%#v completed=%#v", detail.Active, detail.Completed)
	}
	f2 := &Facade{a: &App{ConfigDir: f.a.ConfigDir}}
	f2.loadTasks()
	d2, err := f2.TaskDetail(detail.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(d2.Series) < 2 || d2.Slug != "chat-test" {
		t.Fatalf("history not restored: %#v", d2)
	}
	if len(d2.Completed) != 1 || d2.Completed[0].Name != "photo.jpg" {
		t.Fatalf("media history not restored: %#v", d2.Completed)
	}
}

func TestCompletedTaskBackfillsRecentWorkspaceMedia(t *testing.T) {
	root := t.TempDir()
	f := &Facade{a: &App{ConfigDir: t.TempDir()}}
	f.a.Settings.LibraryRoot = root
	task := f.createTask("sync", "同步聊天：旧任务", "旧任务")
	task.setSlug("chat-old")
	task.finish(nil)

	mediaDir := filepath.Join(root, "chats", "chat-old", "media")
	if err := os.MkdirAll(mediaDir, 0755); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(mediaDir, "old.jpg")
	newer := filepath.Join(mediaDir, "newer.mp4")
	if err := os.WriteFile(old, []byte("old"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newer, []byte("newer!"), 0644); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	_ = os.Chtimes(old, now.Add(-time.Hour), now.Add(-time.Hour))
	_ = os.Chtimes(newer, now, now)

	detail, err := f.TaskDetail(task.snapshot().ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Completed) != 2 {
		t.Fatalf("expected backfilled media, got %#v", detail.Completed)
	}
	if detail.Completed[0].Name != "newer.mp4" || detail.Completed[0].Expected != 6 {
		t.Fatalf("unexpected backfill order: %#v", detail.Completed)
	}
	if detail.Completed[1].Name != "old.jpg" || detail.Completed[1].Kind != "image" {
		t.Fatalf("unexpected backfill entry: %#v", detail.Completed[1])
	}
}

func TestTaskKeepsCompletedRecordsAcrossPasses(t *testing.T) {
	task := &backgroundTask{dto: TaskDTO{State: "running"}}
	task.updateDownload(DownloadSnapshot{Pass: 1, Completed: []TaskProgress{
		{ID: "2", Name: "two.jpg", Done: true},
		{ID: "1", Name: "one.jpg", Done: true},
	}})
	task.updateDownload(DownloadSnapshot{Pass: 2, Completed: []TaskProgress{
		{ID: "3", Name: "three.jpg", Done: true},
		{ID: "2", Name: "two.jpg", Done: true},
	}})
	detail := task.detail()
	if len(detail.Completed) != 3 {
		t.Fatalf("completed records = %#v", detail.Completed)
	}
	if detail.Completed[0].ID != "3" || detail.Completed[1].ID != "2" || detail.Completed[2].ID != "1" {
		t.Fatalf("completed order = %#v", detail.Completed)
	}
}
