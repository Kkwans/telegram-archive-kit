package app

import (
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
		SpeedNow: 1024, SpeedAvg: 900, SpeedPeak: 1200, Bytes: 4096, ElapsedMs: 2000,
	})
	task.mu.Lock()
	task.lastSampleAt = time.Now().Add(-2 * time.Second)
	task.mu.Unlock()
	task.updateDownload(DownloadSnapshot{
		State: "正在下载", Percent: 50, Done: 2, Total: 4,
		SpeedNow: 2048, SpeedAvg: 1500, SpeedPeak: 2048, Bytes: 8192, ElapsedMs: 4000,
	})
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
	f2 := &Facade{a: &App{ConfigDir: f.a.ConfigDir}}
	f2.loadTasks()
	d2, err := f2.TaskDetail(detail.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(d2.Series) < 2 || d2.Slug != "chat-test" {
		t.Fatalf("history not restored: %#v", d2)
	}
}
