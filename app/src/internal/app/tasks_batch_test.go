package app

import (
	"context"
	"testing"
	"time"
)

func waitTaskState(t *testing.T, f *Facade, id, state string) TaskDTO {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		task, err := f.TaskDetail(id)
		if err == nil && task.State == state {
			return task.TaskDTO
		}
		time.Sleep(10 * time.Millisecond)
	}
	task, _ := f.TaskDetail(id)
	t.Fatalf("task %s did not reach %q, last state %q", id, state, task.State)
	return TaskDTO{}
}

func TestBatchPauseThenResumeReusesTask(t *testing.T) {
	f := &Facade{a: &App{}}
	started := make(chan struct{})
	pausedSeen := make(chan bool, 1)
	id, err := f.StartBatchTask(TaskDTO{
		Kind: "online-update-batch", Title: "test",
		Batch: []TaskBatchItemDTO{{Name: "chat", Peer: "user:1", Slug: "chat_1"}},
	}, func(ctx context.Context, update func(int, BatchItemUpdate), progress func(int, string), paused func() bool) error {
		close(started)
		<-ctx.Done()
		pausedSeen <- paused()
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	if ok, err := f.PauseBatchTask(id); err != nil || !ok {
		t.Fatalf("pause: ok=%v err=%v", ok, err)
	}
	if !<-pausedSeen {
		t.Fatal("runner did not observe the paused state")
	}
	waitTaskState(t, f, id, "paused")

	resumed := make(chan struct{})
	if _, err := f.ResumeBatchTask(id, func(ctx context.Context, update func(int, BatchItemUpdate), progress func(int, string), paused func() bool) error {
		close(resumed)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	<-resumed
	waitTaskState(t, f, id, "done")
}

func TestBatchStoppedTaskCanRetry(t *testing.T) {
	f := &Facade{a: &App{}}
	started := make(chan struct{})
	id, err := f.StartBatchTask(TaskDTO{
		Kind: "online-update-batch", Title: "test",
		Batch: []TaskBatchItemDTO{{Name: "chat", Peer: "user:1", Slug: "chat_1"}},
	}, func(ctx context.Context, update func(int, BatchItemUpdate), progress func(int, string), paused func() bool) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	if ok, err := f.StopTask(id); err != nil || !ok {
		t.Fatalf("stop: ok=%v err=%v", ok, err)
	}
	waitTaskState(t, f, id, "stopped")

	if _, err := f.ResumeBatchTask(id, func(ctx context.Context, update func(int, BatchItemUpdate), progress func(int, string), paused func() bool) error {
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	waitTaskState(t, f, id, "done")
}

func TestBatchItemUpdateKeepsProgressOnStatusOnly(t *testing.T) {
	task := &backgroundTask{dto: TaskDTO{Batch: []TaskBatchItemDTO{{Name: "聊天"}}}}
	task.updateBatchItem(0, BatchItemUpdate{
		Status: "下载中", State: "running", Progress: true, Percent: 42,
		Downloaded: 1024, TotalBytes: 4096, Speed: 512, DoneMedia: 3, TotalMedia: 10,
	})
	task.updateBatchItem(0, BatchItemUpdate{Status: "已暂停", State: "paused", Error: "下载已暂停"})
	item := task.snapshot().Batch[0]
	if item.Percent != 42 || item.Downloaded != 1024 || item.TotalBytes != 4096 || item.Speed != 512 {
		t.Fatalf("status-only update cleared progress: %+v", item)
	}
	if item.Status != "已暂停" || item.State != "paused" || item.Error != "下载已暂停" {
		t.Fatalf("status-only update lost state: %+v", item)
	}
}

func TestBatchItemUpdateClearsErrorOnRetry(t *testing.T) {
	task := &backgroundTask{dto: TaskDTO{Batch: []TaskBatchItemDTO{{Name: "聊天", Error: "旧错误"}}}}
	task.updateBatchItem(0, BatchItemUpdate{Status: "准备更新", ResetError: true, Progress: true})
	item := task.snapshot().Batch[0]
	if item.Error != "" {
		t.Fatalf("expected error cleared, got %q", item.Error)
	}
}

func TestTaskSnapshotCopiesBatch(t *testing.T) {
	task := &backgroundTask{dto: TaskDTO{Batch: []TaskBatchItemDTO{{Name: "聊天", Percent: 10}}}}
	snapshot := task.snapshot()
	snapshot.Batch[0].Percent = 90
	if task.snapshot().Batch[0].Percent != 10 {
		t.Fatal("snapshot must not expose the live batch slice")
	}
}
