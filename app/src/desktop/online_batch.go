package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	takapp "telegramarchivekit/internal/app"
)

// onlineBatchRequestItem is one ready chat produced by the batch preview. The
// prepared token lets the batch reuse the exact statistics the user confirmed
// instead of reading the Telegram history a second time. State and TaskID are
// present when the same list is reused to continue a paused or stopped run.
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
	State      string `json:"state,omitempty"`
	TaskID     string `json:"taskId,omitempty"`
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
			Name: name, OnlineName: item.OnlineName, Slug: item.Slug, Peer: item.Peer,
			TaskID: item.TaskID, State: item.State,
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
	id, err := b.facade.StartBatchTask(dto, func(ctx context.Context, update func(int, takapp.BatchItemUpdate), progress func(int, string), paused func() bool) error {
		return b.runOnlineUpdateBatch(ctx, work, update, progress, paused)
	})
	if err != nil {
		return nil, err
	}
	return map[string]string{"taskId": id}, nil
}

// ResumeOnlineUpdateBatch restarts a paused, stopped or failed batch from the
// item list stored in its task record. Chats that already finished are skipped;
// the rest keep their existing match and statistics.
func (b *Bridge) ResumeOnlineUpdateBatch(id string) (string, error) {
	if strings.TrimSpace(id) == "" {
		return "", errors.New("缺少任务标识")
	}
	if err := b.facade.WaitBatchWorker(id, 3*time.Second); err != nil {
		return "", err
	}
	detail, err := b.facade.TaskDetail(id)
	if err != nil {
		return "", err
	}
	if detail.Kind != "online-update-batch" {
		return "", errors.New("该任务不是批量在线更新")
	}
	peers, err := b.resolveBatchItemPeers(detail)
	if err != nil {
		return "", err
	}
	items := make([]onlineBatchRequestItem, len(detail.Batch))
	for i, item := range detail.Batch {
		peer := item.Peer
		if peer == "" {
			peer = peers[i]
		}
		items[i] = onlineBatchRequestItem{
			Slug: item.Slug, Name: item.Name, Peer: peer, OnlineName: item.OnlineName,
			Messages: item.Messages, Media: item.Media,
			Images: item.Images, Videos: item.Videos, Audio: item.Audio, Files: item.Files,
			Bytes: item.Bytes, State: item.State, TaskID: item.TaskID,
		}
	}
	return b.facade.ResumeBatchTask(id, func(ctx context.Context, update func(int, takapp.BatchItemUpdate), progress func(int, string), paused func() bool) error {
		return b.runOnlineUpdateBatch(ctx, items, update, progress, paused)
	})
}

// RetryOnlineUpdateBatch creates a fresh batch task for the chats that did not
// finish. Finished chats stay in the old task and are not copied, while the
// remaining item matches are reused so nothing has to be previewed or matched
// again.
func (b *Bridge) RetryOnlineUpdateBatch(id string) (string, error) {
	if strings.TrimSpace(id) == "" {
		return "", errors.New("缺少任务标识")
	}
	if err := b.facade.WaitBatchWorker(id, 3*time.Second); err != nil {
		return "", err
	}
	detail, err := b.facade.TaskDetail(id)
	if err != nil {
		return "", err
	}
	if detail.Kind != "online-update-batch" {
		return "", errors.New("该任务不是批量在线更新")
	}
	peers, err := b.resolveBatchItemPeers(detail)
	if err != nil {
		return "", err
	}
	work := make([]onlineBatchRequestItem, 0, len(detail.Batch))
	batch := make([]takapp.TaskBatchItemDTO, 0, len(detail.Batch))
	var messages, media, images, videos, audio, files int
	var totalBytes int64
	for i, item := range detail.Batch {
		if item.State == "done" {
			continue
		}
		peer := item.Peer
		if peer == "" {
			peer = peers[i]
		}
		if peer == "" && item.TaskID == "" {
			return "", fmt.Errorf("「%s」无法恢复在线匹配，请重新开始批量更新并手动选择该聊天", item.Name)
		}
		work = append(work, onlineBatchRequestItem{
			Slug: item.Slug, Name: item.Name, Peer: peer, OnlineName: item.OnlineName,
			Messages: item.Messages, Media: item.Media,
			Images: item.Images, Videos: item.Videos, Audio: item.Audio, Files: item.Files,
			Bytes: item.Bytes, State: item.State, TaskID: item.TaskID,
		})
		batch = append(batch, takapp.TaskBatchItemDTO{
			Name: item.Name, OnlineName: item.OnlineName, Slug: item.Slug, Peer: peer,
			TaskID: item.TaskID, State: item.State,
			Messages: item.Messages, Media: item.Media,
			Images: item.Images, Videos: item.Videos, Audio: item.Audio, Files: item.Files,
			Bytes: item.Bytes, Status: "等待重试",
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
		return "", errors.New("没有未完成的聊天需要重试")
	}
	dto := takapp.TaskDTO{
		Kind: "online-update-batch", Title: fmt.Sprintf("重试批量在线更新（%d 个聊天）", len(work)),
		Messages: messages, Media: media, Images: images, Videos: videos, Audio: audio, Files: files,
		TotalBytes: totalBytes, Total: media, Detail: "等待开始",
		Batch: batch,
	}
	return b.facade.StartBatchTask(dto, func(ctx context.Context, update func(int, takapp.BatchItemUpdate), progress func(int, string), paused func() bool) error {
		return b.runOnlineUpdateBatch(ctx, work, update, progress, paused)
	})
}

// resolveBatchItemPeers restores the online match for old task records that were
// written before peer keys were persisted. It fetches the live dialog list once
// and only fills unfinished rows that have no stored peer.
func (b *Bridge) resolveBatchItemPeers(detail takapp.TaskDetailDTO) (map[int]string, error) {
	peers := make(map[int]string, len(detail.Batch))
	var chats []OnlineChat
	var locals []takapp.ChatDTO
	loaded := false
	var loadErr error
	for i, item := range detail.Batch {
		if item.Peer != "" {
			peers[i] = item.Peer
			continue
		}
		if item.State == "done" {
			continue
		}
		if !loaded {
			loaded = true
			locals = b.facade.ListChats()
			dto, err := b.OnlineChats(60)
			if err != nil {
				loadErr = err
			} else {
				chats = dto.Chats
			}
		}
		if loadErr != nil {
			if item.TaskID != "" {
				continue
			}
			return nil, fmt.Errorf("「%s」重新读取在线聊天失败：%w", item.Name, loadErr)
		}
		if chat, ok := matchRetryChat(item, chats, locals); ok {
			peers[i] = chat.Peer
			continue
		}
		if item.TaskID != "" {
			continue
		}
		return nil, fmt.Errorf("「%s」无法自动恢复在线匹配，请重新开始批量更新并手动选择该聊天", item.Name)
	}
	return peers, nil
}

func matchRetryChat(item takapp.TaskBatchItemDTO, chats []OnlineChat, locals []takapp.ChatDTO) (OnlineChat, bool) {
	if name := strings.TrimSpace(item.OnlineName); name != "" {
		if chat, n := matchOnlineChatByName(chats, name); n == 1 {
			return chat, true
		}
	}
	var local takapp.ChatDTO
	for _, candidate := range locals {
		if candidate.Slug == item.Slug {
			local = candidate
			break
		}
	}
	if local.ID != "" {
		if id, err := strconv.ParseInt(local.ID, 10, 64); err == nil {
			if chat, ok := findOnlineChatByID(chats, id); ok {
				return chat, true
			}
		}
	}
	if local.Name != "" {
		if chat, n := matchOnlineChatByName(chats, local.Name); n == 1 {
			return chat, true
		}
	}
	return OnlineChat{}, false
}

func (b *Bridge) PauseOnlineUpdateBatch(id string) (bool, error) {
	return b.facade.PauseBatchTask(id)
}

func (b *Bridge) runOnlineUpdateBatch(
	ctx context.Context,
	items []onlineBatchRequestItem,
	update func(index int, patch takapp.BatchItemUpdate),
	progress func(percent int, detail string),
	isPaused func() bool,
) error {
	defer func() {
		// Unused prepared exports would otherwise keep whole histories in memory.
		for _, item := range items {
			b.online.DropPrepared(item.Token)
		}
	}()
	total := len(items)
	if total == 0 {
		return errors.New("没有需要更新的聊天")
	}
	pausedNow := func() bool {
		return isPaused != nil && isPaused()
	}
	completed := 0
	okCount := 0
	for _, item := range items {
		if item.State == "done" {
			completed++
			okCount++
		}
	}
	failed := 0
	setProgress := func(currentPercent int, detail string) {
		percent := (completed*100 + clampPercent(currentPercent)) / total
		if completed >= total {
			percent = 100
		}
		progress(percent, detail)
	}
	markRemaining := func(from int, message string) {
		for i := from; i < total; i++ {
			update(i, takapp.BatchItemUpdate{Status: "未执行", State: "stopped", ResetError: true, Detail: message})
		}
	}
	cancelRun := func(index int, taskID string) error {
		if pausedNow() {
			if taskID != "" {
				_ = b.facade.Pause()
			}
			update(index, takapp.BatchItemUpdate{Status: "已暂停", State: "paused", ResetError: true, Detail: "已暂停，可继续更新"})
			return ctx.Err()
		}
		if taskID != "" {
			_, _ = b.facade.StopTask(taskID)
		}
		update(index, takapp.BatchItemUpdate{Status: "已终止", State: "stopped", ResetError: true, Detail: "批量更新已停止，可重试"})
		markRemaining(index+1, "批量更新已停止，可重试")
		return ctx.Err()
	}
	if completed > 0 {
		setProgress(0, fmt.Sprintf("继续更新 · 已完成 %d/%d", completed, total))
	}

	for index, item := range items {
		if err := ctx.Err(); err != nil {
			if !pausedNow() {
				markRemaining(index, "批量更新已停止，可重试")
			}
			return err
		}
		if item.State == "done" {
			continue
		}
		name := item.Name
		if name == "" {
			name = item.OnlineName
		}

		var res OnlineExportResult
		resumed := false
		if item.TaskID != "" && (item.State == "paused" || item.State == "failed" || item.State == "stopped" || item.State == "running" || item.State == "partial") {
			if child, err := b.facade.TaskDetail(item.TaskID); err == nil {
				if child.State == "done" {
					childBytes := maxInt64(item.Bytes, child.TotalBytes)
					update(index, takapp.BatchItemUpdate{
						Status: "已完成", State: "done", Progress: true, Percent: 100, ResetError: true,
						Downloaded: childBytes, TotalBytes: childBytes, Detail: "此前已完成",
					})
					okCount++
					completed++
					setProgress(0, fmt.Sprintf("已完成 %d/%d · %s", completed, total, name))
					continue
				}
				if item.Slug != "" {
					if childID, err := b.facade.StartOneClick(item.Slug); err == nil {
						res = OnlineExportResult{Slug: item.Slug, Chat: name, TaskID: childID, Existed: true}
						resumed = true
					}
				}
			}
		}

		if resumed {
			update(index, takapp.BatchItemUpdate{
				Status: "继续下载", TaskID: res.TaskID, State: "running", ResetError: true,
				Detail: "继续下载未完成媒体",
			})
			setProgress(0, fmt.Sprintf("正在更新 %d/%d · %s", index+1, total, name))
		} else {
			update(index, takapp.BatchItemUpdate{Status: "读取新增消息", Detail: "正在连接 Telegram", ResetError: true})
			var err error
			res, err = b.batchOnlineExport(item)
			if err != nil {
				if ctx.Err() != nil {
					return cancelRun(index, "")
				}
				update(index, takapp.BatchItemUpdate{Status: "失败", State: "failed", Error: err.Error()})
				failed++
				completed++
				setProgress(0, fmt.Sprintf("已完成 %d/%d · %s", completed, total, name))
				if strings.Contains(err.Error(), "Telegram 限流") {
					markRemaining(index+1, "Telegram 限流，批量更新已停止，可重试")
					return fmt.Errorf("%s：%w", name, err)
				}
				continue
			}
			if ctx.Err() != nil {
				return cancelRun(index, res.TaskID)
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
		}

		state, detail, itemErr := b.waitOnlineBatchChild(ctx, res.TaskID, pausedNow, func(state string, percent int, downloaded, totalBytes int64, speed float64, doneMedia, totalMedia int, text string) {
			update(index, takapp.BatchItemUpdate{
				Status: batchChildStatus(state), State: state, Progress: true, Percent: percent,
				Downloaded: downloaded, TotalBytes: totalBytes, Speed: speed,
				DoneMedia: doneMedia, TotalMedia: totalMedia, Detail: text,
			})
			setProgress(percent, fmt.Sprintf("正在更新 %d/%d · %s", index+1, total, name))
		})
		if ctx.Err() != nil {
			return cancelRun(index, res.TaskID)
		}
		switch state {
		case "done":
			totalBytes := maxInt64(item.Bytes, detail.TotalBytes)
			update(index, takapp.BatchItemUpdate{
				Status: "已完成", State: "done", Progress: true, Percent: 100, ResetError: true,
				Downloaded: totalBytes, TotalBytes: totalBytes, Detail: "下载完成",
			})
			okCount++
		case "paused":
			update(index, takapp.BatchItemUpdate{Status: "已暂停", State: "paused", ResetError: true, Detail: "已暂停，可重试或继续"})
			failed++
		case "stopped":
			update(index, takapp.BatchItemUpdate{Status: "已终止", State: "stopped", ResetError: true, Detail: "下载已终止，可重试或继续"})
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
	isPaused func() bool,
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
			if isPaused != nil && isPaused() {
				// Let the child finish its safe-pause path before reporting.
				for i := 0; i < 20; i++ {
					if d, err := b.facade.TaskDetail(taskID); err == nil && d.State != "running" {
						break
					}
					select {
					case <-time.After(250 * time.Millisecond):
					}
				}
				return "paused", last, ""
			}
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
