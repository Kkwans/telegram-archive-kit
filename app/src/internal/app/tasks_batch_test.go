package app

import "testing"

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
