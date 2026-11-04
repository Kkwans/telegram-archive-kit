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
