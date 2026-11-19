package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	takapp "telegramarchivekit/internal/app"
)

// onlineBatchRequestItem is one ready chat produced by the batch preview. The
// prepared token lets the batch reuse the exact statistics the user confirmed
// instead of reading the Telegram history a second time.
type onlineBatchRequestItem struct {
	Slug       string `json:"slug"`
	Name       string `json:"name"`
	Peer       string `json:"peer"`
	OnlineName string `json:"onlineName,omitempty"`
	Token      string `json:"token,omitempty"`
	Messages   int    `json:"messages"`
	Media      int    `json:"media"`
	Images     int    `json:"images"`
	Videos     int    `json:"videos"`
	Audio      int    `json:"audio"`
	Files      int    `json:"files"`
	Bytes      int64  `json:"bytes"`
	UpToDate   bool   `json:"upToDate,omitempty"`
}

// StartOnlineUpdateBatch starts one background task that updates the selected
// chats one by one. Each chat still produces its normal download task, which
// the batch detail can open directly.
func (b *Bridge) StartOnlineUpdateBatch(items []onlineBatchRequestItem) (map[string]string, error) {
	info := b.facade.AccountInfo()
	if !info.HasSessionFile {
		return nil, errors.New("尚未登录 Telegram，请先在账号管理完成登录")
	}
	if b.facade.Running() {
		return nil, errors.New("当前有下载任务正在进行，请完成后再批量更新")
	}
	work := make([]onlineBatchRequestItem, 0, len(items))
	batch := make([]takapp.TaskBatchItemDTO, 0, len(items))
	var messages, media, images, videos, audio, files int
	var totalBytes int64
	for _, item := range items {
		if strings.TrimSpace(item.Peer) == "" {
			continue
		}
		name := strings.TrimSpace(item.Name)
		if name == "" {
			name = item.OnlineName
		}
		if name == "" {
			name = item.Peer
		}
		work = append(work, item)
		batch = append(batch, takapp.TaskBatchItemDTO{
			Name: name, OnlineName: item.OnlineName, Slug: item.Slug,
			Messages: item.Messages, Media: item.Media,
			Images: item.Images, Videos: item.Videos, Audio: item.Audio, Files: item.Files,
			Bytes: item.Bytes, Status: "等待更新",
		})
		messages += item.Messages
		media += item.Media
		images += item.Images
		videos += item.Videos
		audio += item.Audio
		files += item.Files
		totalBytes += item.Bytes
	}
	if len(work) == 0 {
		return nil, errors.New("没有需要更新的聊天")
	}
	dto := takapp.TaskDTO{
		Kind: "online-update-batch", Title: fmt.Sprintf("批量在线更新（%d 个聊天）", len(work)),
		Messages: messages, Media: media, Images: images, Videos: videos, Audio: audio, Files: files,
		TotalBytes: totalBytes, Total: media, Detail: "等待开始",
		Batch: batch,
	}
	id, err := b.facade.StartBatchTask(dto, func(ctx context.Context, update func(int, takapp.BatchItemUpdate), progress func(int, string)) error {
		return b.runOnlineUpdateBatch(ctx, work, update, progress)
	})
	if err != nil {
		return nil, err
	}
	return map[string]string{"taskId": id}, nil
}

func (b *Bridge) runOnlineUpdateBatch(
	ctx context.Context,
	items []onlineBatchRequestItem,
	update func(index int, patch takapp.BatchItemUpdate),
	progress func(percent int, detail string),
) error {
	defer func() {
		// Unused prepared exports would otherwise keep whole histories in memory.
		for _, item := range items {
			b.online.DropPrepared(item.Token)
		}
	}()
	total := len(items)
	completed := 0
	okCount, failed := 0, 0
	setProgress := func(currentPercent int, detail string) {
		if total == 0 {
			progress(0, detail)
			return
		}
		percent := (completed*100 + clampPercent(currentPercent)) / total
		if completed >= total {
			percent = 100
		}
		progress(percent, detail)
	}
	markRemaining := func(from int, status, message string) {
		for i := from; i < total; i++ {
			update(i, takapp.BatchItemUpdate{Status: status, State: "stopped", Error: message})
		}
	}

	for index, item := range items {
		if err := ctx.Err(); err != nil {
			markRemaining(index, "未执行", "批量更新已停止")
			return err
		}
		name := item.Name
		if name == "" {
			name = item.OnlineName
		}
		update(index, takapp.BatchItemUpdate{Status: "准备更新", ResetError: true, Percent: 0})
		setProgress(0, fmt.Sprintf("正在更新 %d/%d · %s", index+1, total, name))

		if item.UpToDate {
			update(index, takapp.BatchItemUpdate{Status: "已是最新", State: "done", Progress: true, Percent: 100, ResetError: true, Detail: "没有需要更新的内容"})
			completed++
			okCount++
			setProgress(0, fmt.Sprintf("已完成 %d/%d · %s", completed, total, name))
			continue
		}

		update(index, takapp.BatchItemUpdate{Status: "读取新增消息", Detail: "正在连接 Telegram"})
		res, err := b.batchOnlineExport(item)
		if err != nil {
			if ctx.Err() != nil {
				update(index, takapp.BatchItemUpdate{Status: "已终止", State: "stopped", Error: "批量更新已停止"})
				markRemaining(index+1, "未执行", "批量更新已停止")
				return ctx.Err()
			}
			update(index, takapp.BatchItemUpdate{Status: "失败", State: "failed", Error: err.Error()})
			failed++
			completed++
			setProgress(0, fmt.Sprintf("已完成 %d/%d · %s", completed, total, name))
			if strings.Contains(err.Error(), "Telegram 限流") {
				markRemaining(index+1, "未执行", "Telegram 限流，批量更新已停止")
				return fmt.Errorf("%s：%w", name, err)
			}
			continue
		}
		if ctx.Err() != nil {
			if res.TaskID != "" {
				_, _ = b.facade.StopTask(res.TaskID)
			}
			update(index, takapp.BatchItemUpdate{Status: "已终止", State: "stopped", Error: "批量更新已停止，可打开该聊天任务继续"})
			markRemaining(index+1, "未执行", "批量更新已停止")
			return ctx.Err()
		}
		if res.UpToDate || res.TaskID == "" {
			update(index, takapp.BatchItemUpdate{Status: "已是最新", State: "done", Progress: true, Percent: 100, ResetError: true, Detail: "没有需要更新的内容"})
			okCount++
			completed++
			setProgress(0, fmt.Sprintf("已完成 %d/%d · %s", completed, total, name))
			continue
		}

		update(index, takapp.BatchItemUpdate{
			Status: "下载媒体", TaskID: res.TaskID, State: "running", ResetError: true,
			Detail: "正在下载本次新增与缺失媒体",
		})
		setProgress(0, fmt.Sprintf("正在更新 %d/%d · %s", index+1, total, name))

		state, detail, itemErr := b.waitOnlineBatchChild(ctx, res.TaskID, func(state string, percent int, downloaded, totalBytes int64, speed float64, doneMedia, totalMedia int, text string) {
			update(index, takapp.BatchItemUpdate{
				Status: batchChildStatus(state), State: state, Progress: true, Percent: percent,
				Downloaded: downloaded, TotalBytes: totalBytes, Speed: speed,
				DoneMedia: doneMedia, TotalMedia: totalMedia, Detail: text,
			})
			setProgress(percent, fmt.Sprintf("正在更新 %d/%d · %s", index+1, total, name))
		})
		if ctx.Err() != nil {
			update(index, takapp.BatchItemUpdate{Status: "已终止", State: "stopped", Error: "批量更新已停止，可打开该聊天任务继续"})
			markRemaining(index+1, "未执行", "批量更新已停止")
			return ctx.Err()
		}
		switch state {
		case "done":
			total := maxInt64(item.Bytes, detail.TotalBytes)
			update(index, takapp.BatchItemUpdate{
				Status: "已完成", State: "done", Progress: true, Percent: 100, ResetError: true,
				Downloaded: total, TotalBytes: total, Detail: "下载完成",
			})
			okCount++
		case "paused":
			update(index, takapp.BatchItemUpdate{Status: "已暂停", State: "paused", Error: "下载已暂停，可打开该聊天任务继续"})
			failed++
		case "stopped":
			update(index, takapp.BatchItemUpdate{Status: "已终止", State: "stopped", Error: "下载已终止，可打开该聊天任务继续"})
			failed++
		default:
			message := itemErr
			if message == "" {
				message = "更新未完成"
			}
			update(index, takapp.BatchItemUpdate{Status: "失败", State: "failed", Error: message})
			failed++
		}
		completed++
		setProgress(0, fmt.Sprintf("已完成 %d/%d · %s", completed, total, name))
	}

	if failed > 0 {
		progress(100, fmt.Sprintf("更新结束：完成 %d 个，失败 %d 个", okCount, failed))
		return fmt.Errorf("%d 个聊天未能完成更新", failed)
	}
	progress(100, fmt.Sprintf("已更新 %d 个聊天", okCount))
	return nil
}

func (b *Bridge) batchOnlineExport(item onlineBatchRequestItem) (OnlineExportResult, error) {
	// The normal RPC path holds archiveMu for the entire merge. The background
	// runner must do the same so a concurrent import/delete cannot rewrite the
	// library while this chat is being merged.
	b.archiveMu.Lock()
	defer b.archiveMu.Unlock()
	return b.OnlineExport(item.Peer, 300, 0, item.Token, item.Slug)
}

type batchChildSnapshot struct {
	State      string
	Percent    int
	Downloaded int64
	TotalBytes int64
	Speed      float64
	DoneMedia  int
	TotalMedia int
	Detail     string
	Error      string
}

func (b *Bridge) waitOnlineBatchChild(
	ctx context.Context,
	taskID string,
	report func(state string, percent int, downloaded, totalBytes int64, speed float64, doneMedia, totalMedia int, detail string),
) (string, batchChildSnapshot, string) {
	var last batchChildSnapshot
	readErrors := 0
	for {
		detail, err := b.facade.TaskDetail(taskID)
		if err != nil {
			readErrors++
			if readErrors >= 5 {
				return "failed", last, "读取下载任务状态失败：" + err.Error()
			}
		} else {
			readErrors = 0
			snap := batchChildSnapshot{
				State: detail.State, Percent: detail.Percent,
				Downloaded: detail.Bytes, TotalBytes: detail.TotalBytes,
				DoneMedia: detail.Done, TotalMedia: detail.Total,
				Detail: detail.Detail, Error: detail.Error,
			}
			if len(detail.Series) > 0 {
				snap.Speed = detail.Series[len(detail.Series)-1].Now
			} else {
				snap.Speed = detail.AvgSpeed
			}
			if snap.State == "done" {
				snap.Percent = 100
				if snap.TotalBytes > 0 {
					snap.Downloaded = snap.TotalBytes
				}
			}
			if snap.Percent < 0 {
				snap.Percent = 0
			}
			if snap.Percent > 100 {
				snap.Percent = 100
			}
			last = snap
			report(snap.State, snap.Percent, snap.Downloaded, snap.TotalBytes, snap.Speed, snap.DoneMedia, snap.TotalMedia, snap.Detail)
			if snap.State != "running" {
				return snap.State, snap, snap.Error
			}
		}
		select {
		case <-ctx.Done():
			_, _ = b.facade.StopTask(taskID)
			return "stopped", last, "批量更新已停止"
		case <-time.After(900 * time.Millisecond):
		}
	}
}

func batchChildStatus(state string) string {
	switch state {
	case "running":
		return "下载中"
	case "done":
		return "已完成"
	case "paused":
		return "已暂停"
	case "stopped":
		return "已终止"
	case "failed":
		return "失败"
	default:
		return "更新中"
	}
}

func clampPercent(value int) int {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
