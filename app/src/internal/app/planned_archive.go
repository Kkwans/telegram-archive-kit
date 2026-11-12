package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"telegramarchivekit/internal/platform"
)

type PlannedArchiveInput struct {
	Source         string
	ChatID         string
	ChatType       string
	Added          int
	MediaKinds     []string
	IncludeHistory bool
	NewMedia       []string
	Rebuild        bool
}

type PlannedArchiveResult struct {
	Slug    string
	Pending []string
}

func (a *App) planWorkspace(chat Chat) (string, bool) {
	for _, meta := range a.listWorkspaces() {
		if meta.Chat.ID == chat.ID && (planPeerFamily(meta.Chat.Type) == planPeerFamily(chat.Type) || meta.Chat.Type == "") {
			return meta.Slug, true
		}
	}
	return "", false
}

func planPeerFamily(kind string) string {
	switch {
	case strings.Contains(kind, "group"):
		return "group"
	case strings.Contains(kind, "channel"):
		return "channel"
	case kind == "personal_chat" || kind == "private_chat":
		return "user"
	}
	return kind
}

// RunPlannedArchive uses the same operation slot and task events as one-click
// sync. Prepare runs inside the reservation, so a library switch or a manual
// download cannot race a staged export into another workspace.
func (f *Facade) RunPlannedArchive(ctx context.Context, libraryID, planID, runID, title, name string,
	started func(string) error,
	prepare func(context.Context, func(string)) (PlannedArchiveInput, error),
	committed func(PlannedArchiveResult) error,
) (result PlannedArchiveResult, err error) {
	f.mu.Lock()
	if f.op != nil {
		f.mu.Unlock()
		return result, ErrOperationRunning
	}
	if f.libLock == nil || f.libLock.identity != libraryID || f.remoteSuspended || libraryID == "" {
		f.mu.Unlock()
		return result, ErrLibraryIdentity
	}
	if f.hasRunningTasks() {
		f.mu.Unlock()
		return result, ErrOperationRunning
	}
	root := f.a.Settings.LibraryRoot
	a := appAtLibrary(f.a, root)
	a.Settings.ExpectedLibraryID = libraryID
	f.seq++
	ctx, cancel := context.WithCancel(ctx)
	op := &desktopOp{id: fmt.Sprintf("plan-%d", f.seq), chat: name, cancel: cancel}
	f.op, f.running = op, true
	f.hasDl, f.hasOp, f.hasDone = false, false, false
	f.mu.Unlock()

	defer func() {
		defer cancel()
		f.mu.Lock()
		paused, stopped := op.paused, op.stopped
		f.mu.Unlock()
		if op.task != nil {
			var partial *PartialMediaError
			done := DoneDTO{OpID: op.id, OK: err == nil, Paused: paused, Stopped: stopped || (!paused && errors.Is(err, context.Canceled)), Partial: errors.As(err, &partial), Stage: "完成"}
			if err != nil {
				done.Stage, done.Error = "同步计划未完成", err.Error()
			}
			f.send("tak:done", done)
		}
		f.mu.Lock()
		if f.op == op {
			f.op, f.running = nil, false
		}
		f.mu.Unlock()
		if result.Slug != "" {
			f.invalidateWorkspaceMedia(root, result.Slug)
		}
	}()

	if err = a.guardWritable(); err != nil {
		return result, err
	}
	task := f.createTaskRecord(TaskDTO{Kind: "sync-plan", PlanID: planID, PlanRunID: runID, Title: title, Chat: name})
	f.mu.Lock()
	op.task = task
	f.mu.Unlock()
	if err = started(task.snapshot().ID); err != nil {
		return result, err
	}
	rep := &eventReporter{opID: op.id, emit: f.send}
	input, err := prepare(ctx, func(stage string) { rep.Phase(ctx, "preflight", stage, name) })
	if err != nil {
		return result, err
	}
	if err = ctx.Err(); err != nil {
		return result, err
	}
	if err = a.guardWritable(); err != nil {
		return result, err
	}
	task.setInfo(input.ChatID, "sync-plan", "", "", input.Added, 0)
	if input.Source != "" {
		meta, _, importErr := a.importResultJSONWithIdentity(input.Source, false, true)
		if importErr != nil {
			return result, importErr
		}
		result.Slug = meta.Slug
	} else {
		result.Slug, _ = a.planWorkspace(Chat{ID: input.ChatID, Type: input.ChatType})
	}
	if result.Slug == "" {
		return result, committed(result)
	}
	task.setSlug(result.Slug)

	if len(input.MediaKinds) > 0 {
		result.Pending, err = a.plannedMissingIDs(result.Slug, input)
		if err != nil {
			return result, err
		}
	}
	if err = committed(result); err != nil {
		return result, err
	}
	build := func() error {
		rep.Phase(ctx, "build", "正在更新网页", name)
		_, e := a.buildWorkspaceModeWithProgressCtx(ctx, result.Slug, true, func(p OperationProgress) {
			f.send("tak:operation", OperationDTO{OpID: op.id, Phase: "build", Stage: p.Stage, Detail: p.Detail, Current: p.Current, Total: p.Total, Unit: p.Unit})
		})
		return e
	}
	if input.Source != "" || input.Rebuild {
		if err = build(); err != nil {
			return result, err
		}
	}
	if len(result.Pending) == 0 {
		return result, nil
	}
	only := make(map[string]bool, len(result.Pending))
	for _, id := range result.Pending {
		only[id] = true
	}
	_, path, err := a.generateMissingWithin(result.Slug, only)
	if err != nil || path == "" {
		return result, err
	}
	mediaPlan, err := loadDownloadPlan(path)
	if err != nil {
		return result, err
	}
	task.setDownloadPlan(mediaPlan.Total, mediaPlan.KnownBytes, mediaPlan.Images, mediaPlan.Videos, mediaPlan.Audio, mediaPlan.Files+mediaPlan.Other)
	task.setDownloadBaseline(0, 0, 0, 0, 0, 0)
	if free := platform.FreeSpaceBytes(a.workspaceDir(result.Slug)); free > 0 && mediaPlan.KnownBytes > 0 && uint64(mediaPlan.KnownBytes)+uint64(downloadSpaceReserve) > free {
		return result, ErrPlanSpace
	}
	dctx, ui, stop := rep.BeginDownload(ctx, downloadMeta{Slug: result.Slug, Chat: name, Pass: 1, PassMax: 1})
	err = a.downloadMissingWithin(dctx, result.Slug, path, 1, nil, ui, only)
	stop()
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	// The persisted candidate set remains available if either the download or
	// the follow-up filesystem reconciliation is interrupted.
	pending, pendingErr := a.plannedMissingIDs(result.Slug, PlannedArchiveInput{MediaKinds: input.MediaKinds, NewMedia: result.Pending})
	if pendingErr != nil {
		return result, errors.Join(err, pendingErr)
	}
	result.Pending = pending
	if checkpointErr := committed(result); checkpointErr != nil {
		return result, errors.Join(err, checkpointErr)
	}
	buildErr := build()
	if err == nil && len(result.Pending) != 0 {
		err = &PartialMediaError{Count: len(result.Pending)}
	}
	return result, errors.Join(err, buildErr)
}

var ErrPlanSpace = errors.New("档案库磁盘空间不足，请释放空间后重试")

func (f *Facade) hasRunningTasks() bool {
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	for _, task := range f.tasks {
		if task.snapshot().State == "running" {
			return true
		}
	}
	return false
}

func (a *App) plannedMissingIDs(slug string, input PlannedArchiveInput) ([]string, error) {
	plan, _, err := a.estimateMissingPlan(slug)
	if err != nil {
		return nil, err
	}
	var pending []string
	for _, id := range input.NewMedia {
		if kind := plan.Kinds[id]; kind != "" && slices.Contains(input.MediaKinds, kind) {
			pending = append(pending, id)
		}
	}
	if input.IncludeHistory {
		pending = pending[:0]
		for id, kind := range plan.Kinds {
			if slices.Contains(input.MediaKinds, kind) {
				pending = append(pending, id)
			}
		}
	}
	slices.Sort(pending)
	return slices.Compact(pending), nil
}

// PlanArchiveBaseline reads the existing source by stable peer identity.
func (f *Facade) PlanArchiveBaseline(chatID, chatType string) (string, int, error) {
	slug, messages, err := f.planSourceMessages(chatID, chatType)
	if err != nil {
		return "", 0, err
	}
	high := 0
	for _, msg := range messages {
		id, _ := strconv.Atoi(fmt.Sprint(msg["id"]))
		high = max(high, id)
	}
	return slug, high, nil
}

func (f *Facade) PlanArchiveMessageIDs(chatID, chatType string) (map[string]bool, error) {
	_, messages, err := f.planSourceMessages(chatID, chatType)
	if err != nil {
		return nil, err
	}
	ids := make(map[string]bool, len(messages))
	for _, msg := range messages {
		ids[fmt.Sprint(msg["id"])] = true
	}
	return ids, nil
}

func (f *Facade) planSourceMessages(chatID, chatType string) (string, []map[string]any, error) {
	root := f.libraryRoot()
	a := &App{Settings: Settings{LibraryRoot: root}}
	slug, found := a.planWorkspace(Chat{ID: chatID, Type: chatType})
	if !found {
		return "", nil, nil
	}
	if _, err := checkedWorkspaceDir(root, slug); err != nil {
		return "", nil, err
	}
	raw, _, err := readRawExport(filepath.Join(a.workspaceDir(slug), "source", "result.json"))
	if errors.Is(err, os.ErrNotExist) {
		return slug, nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	return slug, raw.Messages, nil
}
