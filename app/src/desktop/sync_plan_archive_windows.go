package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gotd/td/tgerr"
	takapp "telegramarchivekit/internal/app"
	"telegramarchivekit/internal/platform"
)

var errPlanAccount = errors.New("当前 Telegram 账号与计划绑定的账号不同")

func (b *Bridge) bindSyncPlan(ctx context.Context, inputs []SyncPlanTargetInput) (SyncPlanBinding, error) {
	if !b.archiveMu.TryLock() {
		return SyncPlanBinding{}, takapp.ErrOperationRunning
	}
	defer b.archiveMu.Unlock()
	root := b.facade.PublicationRoot()
	account := b.facade.AccountInfo()
	settings := b.facade.GetSettings()
	profile, err := b.profile.Fetch(ctx, account.Namespace, settings.Proxy, 12*time.Second)
	if err != nil {
		return SyncPlanBinding{}, classifySyncPlanArchiveError(err)
	}
	binding := SyncPlanBinding{
		AccountID:    strconv.FormatInt(profile.UserID, 10),
		Namespace:    account.Namespace,
		LibraryLabel: root,
	}
	for _, input := range inputs {
		chat, err := b.resolveOnlineChatContext(ctx, input.Peer, 20*time.Second)
		if err != nil {
			return SyncPlanBinding{}, classifySyncPlanArchiveError(err)
		}
		slug, maxID, err := b.facade.PlanArchiveBaseline(strconv.FormatInt(chat.ID, 10), desktopChatType(chat))
		if err != nil {
			return SyncPlanBinding{}, err
		}
		binding.Targets = append(binding.Targets, SyncPlanTarget{Peer: input.Peer, Slug: slug, Name: chat.Name, Cursor: maxID})
	}
	if root != b.facade.PublicationRoot() {
		return SyncPlanBinding{}, takapp.ErrLibraryIdentity
	}
	binding.LibraryID, err = b.facade.RegisterCurrentLibrary()
	return binding, err
}

func (b *Bridge) checkSyncPlan(ctx context.Context, plan SyncPlan) error {
	if err := b.checkSyncPlanLocal(plan); err != nil {
		return err
	}
	account := b.facade.AccountInfo()
	profile, err := b.profile.Fetch(ctx, account.Namespace, b.facade.GetSettings().Proxy, 12*time.Second)
	if err != nil {
		return classifySyncPlanArchiveError(err)
	}
	if strconv.FormatInt(profile.UserID, 10) != plan.AccountID {
		return SyncPlanBlocked(SyncPlanBlockAccount, errPlanAccount.Error())
	}
	return nil
}

func (b *Bridge) checkSyncPlanLocal(plan SyncPlan) error {
	if b.facade.ActivePlanLibraryID() != plan.LibraryID {
		_, expected := b.facade.CurrentLibrarySelection()
		if expected == plan.LibraryID {
			return SyncPlanBlocked(SyncPlanBlockRemote, "等待恢复远程档案库")
		}
		return SyncPlanBlocked(SyncPlanBlockLibrary, "等待打开计划的档案库")
	}
	account := b.facade.AccountInfo()
	if account.Namespace != plan.Namespace {
		return SyncPlanBlocked(SyncPlanBlockAccount, errPlanAccount.Error())
	}
	if b.facade.LoginActive() {
		return SyncPlanBlocked(SyncPlanBlockBusy, "等待当前 Telegram 登录结束")
	}
	return nil
}

func classifySyncPlanArchiveError(err error) error {
	if err == nil || errors.Is(err, context.Canceled) {
		return err
	}
	if wait, ok := tgerr.AsFloodWait(err); ok {
		return SyncPlanTransient(SyncPlanReasonFloodWait, "Telegram 暂时限制请求频率", wait)
	}
	var download *takapp.TdlFailure
	if errors.As(err, &download) {
		switch download.Kind {
		case "auth":
			return SyncPlanBlocked(SyncPlanBlockSession, "Telegram 会话已失效，请重新登录")
		case "network":
			return SyncPlanTransient(SyncPlanReasonNetwork, "媒体下载连接暂时不可用", 0)
		case "content":
			return SyncPlanFailed(SyncPlanBlockTarget, "Telegram 暂时无法提供所选媒体")
		}
	}
	var partial *takapp.PartialMediaError
	if errors.As(err, &partial) {
		return SyncPlanFailed("media", fmt.Sprintf("仍有 %d 个媒体待补齐", partial.Count))
	}
	switch {
	case errors.Is(err, takapp.ErrOperationRunning):
		return SyncPlanBlocked(SyncPlanBlockBusy, "等待当前任务结束")
	case errors.Is(err, takapp.ErrLibraryIdentity):
		return SyncPlanBlocked(SyncPlanBlockRemote, "档案库尚未连接或身份不符")
	case errors.Is(err, takapp.ErrLibraryReadOnly), errors.Is(err, os.ErrPermission):
		return SyncPlanBlocked(SyncPlanBlockReadOnly, "档案库不可写，请检查权限")
	case errors.Is(err, takapp.ErrPlanSpace):
		return SyncPlanBlocked(SyncPlanBlockSpace, err.Error())
	case errors.Is(err, errPlanAccount):
		return SyncPlanBlocked(SyncPlanBlockAccount, err.Error())
	}
	state, message := classifyProfileError(err)
	switch state {
	case "unauthorized":
		return SyncPlanBlocked(SyncPlanBlockSession, message)
	case "busy":
		return SyncPlanBlocked(SyncPlanBlockBusy, message)
	case "timeout", "network":
		return SyncPlanTransient(SyncPlanReasonNetwork, message, 0)
	}
	if tgerr.Is(err, "CHANNEL_PRIVATE", "CHAT_ADMIN_REQUIRED", "PEER_ID_INVALID") {
		return SyncPlanFailed(SyncPlanBlockTarget, "当前账号无法读取该聊天")
	}
	return err
}

func (b *Bridge) executeSyncPlan(ctx context.Context, plan SyncPlan, target SyncPlanTarget, cp SyncPlanCheckpoint, save func(SyncPlanCheckpoint) error) (SyncPlanTargetResult, error) {
	var out SyncPlanTargetResult
	if !b.archiveMu.TryLock() {
		return out, classifySyncPlanArchiveError(takapp.ErrOperationRunning)
	}
	defer b.archiveMu.Unlock()
	if err := b.checkSyncPlanLocal(plan); err != nil {
		return out, err
	}
	if cp.Stage == "fetched" || cp.Stage == "staged" || cp.Stage == "committed" {
		if err := b.checkSyncPlan(ctx, plan); err != nil {
			return out, err
		}
	}
	dir := b.planStageDir(plan, target, cp)
	taskResult, err := b.facade.RunPlannedArchive(ctx, plan.LibraryID, plan.ID, plan.ActiveRunID, plan.Name+" · "+target.Name, target.Name,
		func(taskID string) error {
			cp.TaskID = taskID
			return save(cp)
		},
		func(ctx context.Context, stage func(string)) (takapp.PlannedArchiveInput, error) {
			return b.stagePlanArchive(ctx, plan, target, dir, &cp, save, stage)
		},
		func(result takapp.PlannedArchiveResult) error {
			cp.Cursor = max(cp.Cursor, cp.Through)
			cp.Stage = "committed"
			cp.PendingMedia, cp.Missing = result.Pending, len(result.Pending)
			return save(cp)
		},
	)
	out = SyncPlanTargetResult{
		Slug: taskResult.Slug, Cursor: cp.Cursor, AddedMessages: cp.AddedMessages, AddedMedia: cp.AddedMedia,
		Missing: cp.Missing, TaskID: cp.TaskID, PendingMedia: cp.PendingMedia,
	}
	if err != nil && ctx.Err() == nil && b.facade.ActivePlanLibraryID() != plan.LibraryID {
		return out, SyncPlanBlocked(SyncPlanBlockRemote, "远程档案库断开，等待重连")
	}
	if err == nil {
		removePlanStage(dir)
	}
	return out, classifySyncPlanArchiveError(err)
}

func (b *Bridge) planStageDir(plan SyncPlan, target SyncPlanTarget, cp SyncPlanCheckpoint) string {
	key := sha256.Sum256([]byte(plan.ID + "\x00" + target.Peer + "\x00" + cp.WorkID))
	return filepath.Join(b.facade.ConfigDir(), "sync-plan-work", hex.EncodeToString(key[:]))
}

func (b *Bridge) discardPlanStage(plan SyncPlan, target SyncPlanTarget, cp SyncPlanCheckpoint) {
	if cp.WorkID != "" {
		removePlanStage(b.planStageDir(plan, target, cp))
	}
}

func (b *Bridge) stagePlanArchive(ctx context.Context, plan SyncPlan, target SyncPlanTarget, dir string, cp *SyncPlanCheckpoint, save func(SyncPlanCheckpoint) error, stage func(string)) (takapp.PlannedArchiveInput, error) {
	chat, err := b.resolveOnlineChatContext(ctx, target.Peer, 20*time.Second)
	if err != nil {
		return takapp.PlannedArchiveInput{}, err
	}
	input := takapp.PlannedArchiveInput{
		ChatID: strconv.FormatInt(chat.ID, 10), ChatType: desktopChatType(chat),
		MediaKinds: plan.MediaKinds, IncludeHistory: plan.IncludeHistory,
		NewMedia: cp.PendingMedia, Added: cp.AddedMessages, Rebuild: cp.Stage == "committed",
	}
	if cp.Stage == "committed" {
		return input, nil
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return input, err
	}
	if cp.Stage != "staged" {
		var since int64
		if cp.Cursor == 0 && target.Slug == "" {
			addedAt := target.AddedAt
			if addedAt == 0 {
				addedAt = plan.CreatedAt
			}
			switch plan.FirstScope {
			case "now":
				since = time.UnixMilli(addedAt).Unix()
			case "30d":
				since = time.UnixMilli(addedAt).AddDate(0, 0, -30).Unix()
			}
		}
		accountID, _ := strconv.ParseInt(plan.AccountID, 10, 64)
		scan := &plannedMessageScan{Account: accountID, Offset: cp.Offset, Since: since}
		scan.Page = func(messages []map[string]any, next, high int, finished bool) error {
			if len(messages) > 0 {
				page, err := json.Marshal(messages)
				if err != nil {
					return err
				}
				if err := platform.AtomicWriteFile(filepath.Join(dir, fmt.Sprintf("page-%d.json", cp.Offset)), page, 0600); err != nil {
					return err
				}
			}
			cp.Offset, cp.Through = next, max(cp.Through, high)
			cp.Stage = "fetch"
			if finished {
				cp.Stage = "fetched"
			}
			return save(*cp)
		}
		if cp.Stage != "fetched" {
			stage("正在获取 Telegram 消息")
			_, _, _, err = b.online.scanMessages(ctx, plan.Namespace, b.facade.GetSettings().Proxy, chat, 300*time.Second, cp.Cursor, 0, nil, scan)
			if err != nil {
				return input, err
			}
		}
		existing, readErr := b.facade.PlanArchiveMessageIDs(input.ChatID, input.ChatType)
		if readErr != nil {
			return input, readErr
		}
		input.Source, cp.AddedMessages, cp.AddedMedia, cp.PendingMedia, err = assemblePlanSource(dir, chat, plan.MediaKinds, cp.PendingMedia, existing)
		if err != nil {
			return input, err
		}
		cp.Stage = "staged"
		if err = save(*cp); err != nil {
			return input, err
		}
	} else if cp.AddedMessages > 0 {
		input.Source = filepath.Join(dir, "export.json")
	}
	input.NewMedia, input.Added = cp.PendingMedia, cp.AddedMessages
	return input, nil
}

func planStagePages(dir string) ([]int, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var pages []int
	for _, entry := range entries {
		var offset int
		if n, _ := fmt.Sscanf(entry.Name(), "page-%d.json", &offset); n == 1 && entry.Name() == fmt.Sprintf("page-%d.json", offset) {
			pages = append(pages, offset)
		}
	}
	sort.Slice(pages, func(i, j int) bool {
		if pages[i] == 0 || pages[j] == 0 {
			return pages[i] != 0 && pages[j] == 0
		}
		return pages[i] < pages[j]
	})
	return pages, nil
}

func assemblePlanSource(dir string, chat OnlineChat, kinds, previous []string, existing map[string]bool) (string, int, int, []string, error) {
	pages, err := planStagePages(dir)
	if err != nil || len(pages) == 0 {
		return "", 0, 0, previous, err
	}
	file, err := os.CreateTemp(dir, "export-*.tmp")
	if err != nil {
		return "", 0, 0, previous, err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	header, err := json.Marshal(map[string]any{"id": chat.ID, "name": chat.Name, "type": desktopChatType(chat)})
	if err != nil {
		return "", 0, 0, previous, err
	}
	writer := bufio.NewWriter(file)
	if _, err := writer.WriteString(string(header[:len(header)-1]) + `,"messages":[`); err != nil {
		return "", 0, 0, previous, err
	}
	count, media := 0, 0
	pending := slices.Clone(previous)
	for _, offset := range pages {
		raw, err := os.ReadFile(filepath.Join(dir, fmt.Sprintf("page-%d.json", offset)))
		if err != nil {
			return "", 0, 0, previous, err
		}
		var page []json.RawMessage
		if err = json.Unmarshal(raw, &page); err != nil {
			return "", 0, 0, previous, err
		}
		slices.Reverse(page)
		for _, message := range page {
			id, kind := plannedMedia(message)
			selected := id != "" && slices.Contains(kinds, kind)
			if selected {
				pending = append(pending, id)
			}
			if existing[id] {
				continue
			}
			if count != 0 {
				if err := writer.WriteByte(','); err != nil {
					return "", 0, 0, previous, err
				}
			}
			if _, err := writer.Write(message); err != nil {
				return "", 0, 0, previous, err
			}
			count++
			if selected {
				media++
			}
		}
	}
	slices.Sort(pending)
	pending = slices.Compact(pending)
	if count == 0 {
		return "", 0, 0, pending, nil
	}
	if _, err := writer.WriteString("]}"); err != nil {
		return "", 0, 0, previous, err
	}
	if err := writer.Flush(); err != nil {
		return "", 0, 0, previous, err
	}
	if err := errors.Join(file.Sync(), file.Close()); err != nil {
		return "", 0, 0, previous, err
	}
	path := filepath.Join(dir, "export.json")
	if err := os.Rename(file.Name(), path); err != nil {
		return "", 0, 0, previous, err
	}
	return path, count, media, pending, nil
}

func plannedMedia(raw json.RawMessage) (string, string) {
	var fields struct {
		ID        json.Number `json:"id"`
		MediaType string      `json:"media_type"`
		File      string      `json:"file"`
		Photo     string      `json:"photo"`
	}
	if json.Unmarshal(raw, &fields) != nil {
		return "", ""
	}
	if fields.MediaType == "" && fields.File == "" && fields.Photo == "" {
		return fields.ID.String(), ""
	}
	kind := "file"
	switch fields.MediaType {
	case "photo":
		kind = "image"
	case "video_file", "video_message", "animation":
		kind = "video"
	case "voice_message", "audio_file":
		kind = "audio"
	}
	if fields.Photo != "" && fields.MediaType == "" {
		kind = "image"
	}
	return fields.ID.String(), kind
}

func removePlanStage(dir string) {
	pages, _ := planStagePages(dir)
	for _, offset := range pages {
		_ = os.Remove(filepath.Join(dir, fmt.Sprintf("page-%d.json", offset)))
	}
	_ = os.Remove(filepath.Join(dir, "export.json"))
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && (strings.HasPrefix(name, ".tak-write-") || (strings.HasPrefix(name, "export-") && strings.HasSuffix(name, ".tmp"))) {
			_ = os.Remove(filepath.Join(dir, name))
		}
	}
	_ = os.Remove(dir)
}
