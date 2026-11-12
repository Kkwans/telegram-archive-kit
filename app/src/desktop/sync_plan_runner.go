package main

import (
	"context"
	"errors"
	"net"
	"slices"
	"time"
)

type syncPlanJob struct {
	plan       SyncPlan
	target     SyncPlanTarget
	checkpoint SyncPlanCheckpoint
	runID      string
}

func (t *SyncPlanRunTarget) updateCheckpoint(c SyncPlanCheckpoint) {
	t.Cursor = c.Cursor
	t.AddedMessages = c.AddedMessages
	t.AddedMedia = c.AddedMedia
	t.Missing = c.Missing
	t.TaskID = c.TaskID
}

func finishSyncRun(run *syncRunRecord, state, message string, at time.Time) {
	run.State, run.Message, run.FinishedAt = state, message, at
	run.RetryAt = time.Time{}
	if state == "stopped" || state == "succeeded" {
		run.BlockedReason = ""
	}
	for i := range run.Targets {
		target := &run.Targets[i]
		if syncPending(target.State) {
			target.State, target.Message = state, message
			if state == "stopped" {
				target.BlockedReason = ""
			}
		}
	}
}

func advanceSyncRunTarget(run *syncRunRecord, now time.Time) {
	if slices.ContainsFunc(run.Targets, func(t SyncPlanRunTarget) bool { return syncPending(t.State) }) {
		run.State, run.BlockedReason, run.Message, run.RetryAt = "queued", "", "", time.Time{}
		run.RetryCount = 0
		return
	}
	if index := slices.IndexFunc(run.Targets, func(t SyncPlanRunTarget) bool { return t.State == "failed" }); index >= 0 {
		run.BlockedReason = run.Targets[index].BlockedReason
		message := "有聊天未同步完成"
		if len(run.Targets) == 1 {
			message = run.Targets[index].Message
		}
		finishSyncRun(run, "failed", message, now)
		return
	}
	finishSyncRun(run, "succeeded", "同步完成", now)
}

func (s *SyncPlanService) loop() {
	defer close(s.done)
	ticker := time.NewTicker(syncPlanPollInterval)
	defer ticker.Stop()
	for {
		job, ctx, closing := s.advance()
		if closing {
			return
		}
		if job != nil && s.execute(ctx, *job) {
			continue
		}
		select {
		case <-ticker.C:
		case <-s.signal:
		}
	}
}

func (s *SyncPlanService) advance() (*syncPlanJob, context.Context, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	flushErr := s.flushLocked()
	if s.closing {
		return nil, nil, true
	}
	if flushErr != nil || s.active != nil {
		return nil, nil, false
	}
	now := s.now()
	state := s.state.clone()
	changed := scheduleSyncPlans(&state, now)
	for account, expires := range state.Cooldowns {
		if !now.Before(expires) {
			delete(state.Cooldowns, account)
			changed = true
		}
	}
	for i := range state.Runs {
		run := &state.Runs[i]
		// A failed state write may leave the last durable state running even
		// though the worker returned. Recover that checkpoint on the next tick.
		if run.State == "stopping" {
			finishSyncRun(run, "stopped", "执行已停止", now)
			changed = true
			continue
		}
		if !syncPending(run.State) {
			continue
		}
		planIndex := state.planIndex(run.PlanID)
		if planIndex < 0 {
			finishSyncRun(run, "stopped", "同步计划已删除", now)
			changed = true
			continue
		}
		plan := &state.Plans[planIndex]
		if expiry := state.Cooldowns[plan.AccountID]; now.Before(expiry) {
			if expiry.After(run.RetryAt) || run.State != "retrying" {
				run.State, run.BlockedReason, run.Message = "retrying", SyncPlanReasonFloodWait, "正在等待 Telegram 限流解除"
				if expiry.After(run.RetryAt) {
					run.RetryAt = expiry
				}
				changed = true
			}
			continue
		}
		if now.Before(run.RetryAt) && (run.State != "blocked" || !s.wakeAt.After(run.LastBlockedAt)) {
			continue
		}
		targetIndex := slices.IndexFunc(run.Targets, func(t SyncPlanRunTarget) bool { return syncPending(t.State) })
		if targetIndex < 0 {
			advanceSyncRunTarget(run, now)
			changed = true
			continue
		}
		entry := &run.Targets[targetIndex]
		at := slices.IndexFunc(plan.Targets, func(t SyncPlanTarget) bool { return t.Peer == entry.Peer })
		if at < 0 {
			finishSyncRun(run, "failed", "计划中的目标已变更", now)
			changed = true
			continue
		}
		target := plan.Targets[at]
		checkpoint := plan.Work[target.Peer]
		if checkpoint.WorkID == "" {
			checkpoint.WorkID, checkpoint.Cursor = run.ID, target.Cursor
		}
		if changed {
			if err := s.commitLocked(state); err != nil {
				return nil, nil, false
			}
		}
		ctx, cancel := context.WithCancel(context.Background())
		s.active = &syncPlanActive{id: run.ID, cancel: cancel}
		jobPlan := cloneSyncPlan(plan.SyncPlan)
		jobPlan.ActiveRunID = run.ID
		job := &syncPlanJob{jobPlan, target, cloneSyncCheckpoint(checkpoint), run.ID}
		return job, ctx, false
	}
	if changed {
		_ = s.commitLocked(state)
	}
	return nil, nil, false
}

func scheduleSyncPlans(state *syncPlanDiskState, now time.Time) bool {
	changed := false
	for i := range state.Plans {
		plan := &state.Plans[i]
		if !plan.Enabled {
			continue
		}
		due, _ := syncPlanSlots(plan.Schedule, plan.EligibleAt, plan.LastSlot, now)
		if due.at.IsZero() {
			continue
		}
		plan.LastSlot = due.day
		if state.pendingIndex(plan.ID) < 0 {
			state.enqueue(i, "scheduled", due.at, nil)
		}
		changed = true
	}
	return changed
}

func (s *SyncPlanService) execute(ctx context.Context, job syncPlanJob) bool {
	var result SyncPlanTargetResult
	var err error
	switch {
	case s.hooks.Check == nil || s.hooks.Execute == nil:
		err = SyncPlanFailed("", "同步执行服务未初始化")
	default:
		err = s.hooks.Check(ctx, job.plan)
		if err == nil {
			err = s.markStarted(ctx, job)
		}
		if err == nil {
			result, err = s.hooks.Execute(ctx, job.plan, job.target, job.checkpoint, func(checkpoint SyncPlanCheckpoint) error {
				return s.checkpoint(job, checkpoint)
			})
		}
	}
	return s.finish(job, result, err)
}

func (s *SyncPlanService) markStarted(ctx context.Context, job syncPlanJob) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	state := s.state.clone()
	run := &state.Runs[state.runIndex(job.runID)]
	plan := &state.Plans[state.planIndex(job.plan.ID)]
	if plan.Work == nil {
		plan.Work = make(map[string]SyncPlanCheckpoint)
	}
	plan.Work[job.target.Peer] = cloneSyncCheckpoint(job.checkpoint)
	run.State, run.BlockedReason, run.Message, run.RetryAt = "running", "", "", time.Time{}
	if run.StartedAt.IsZero() {
		run.StartedAt = s.now()
	}
	index := slices.IndexFunc(run.Targets, func(t SyncPlanRunTarget) bool { return t.Peer == job.target.Peer })
	entry := &run.Targets[index]
	entry.State, entry.BlockedReason, entry.Message = "running", "", ""
	return s.commitLocked(state)
}

func (s *SyncPlanService) checkpoint(job syncPlanJob, checkpoint SyncPlanCheckpoint) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == nil || s.active.id != job.runID {
		return errors.New("同步执行已经结束")
	}
	state := s.state.clone()
	run := &state.Runs[state.runIndex(job.runID)]
	plan := &state.Plans[state.planIndex(job.plan.ID)]
	previous := plan.Work[job.target.Peer]
	if checkpoint.WorkID == "" {
		checkpoint.WorkID = previous.WorkID
	}
	if checkpoint.WorkID != previous.WorkID || checkpoint.Cursor < job.target.Cursor {
		return errors.New("无效的同步检查点")
	}
	plan.Work[job.target.Peer] = cloneSyncCheckpoint(checkpoint)
	index := slices.IndexFunc(run.Targets, func(t SyncPlanRunTarget) bool { return t.Peer == job.target.Peer })
	run.Targets[index].updateCheckpoint(checkpoint)
	return s.commitLocked(state)
}

func (s *SyncPlanService) finish(job syncPlanJob, result SyncPlanTargetResult, runErr error) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active.cancel()
	s.active = nil
	now := s.now()
	state := s.state.clone()
	scheduleSyncPlans(&state, now)
	run := &state.Runs[state.runIndex(job.runID)]
	plan := &state.Plans[state.planIndex(job.plan.ID)]
	index := slices.IndexFunc(run.Targets, func(t SyncPlanRunTarget) bool { return t.Peer == job.target.Peer })
	entry := &run.Targets[index]
	stopped := run.State == "stopping"
	if runErr == nil {
		at := slices.IndexFunc(plan.Targets, func(t SyncPlanTarget) bool { return t.Peer == job.target.Peer })
		target := &plan.Targets[at]
		target.Cursor = max(target.Cursor, result.Cursor)
		target.LastSuccessAt = now
		target.AddedMessages, target.AddedMedia, target.Missing = result.AddedMessages, result.AddedMedia, result.Missing
		target.TaskID = result.TaskID
		if result.Slug != "" {
			target.Slug = result.Slug
		}
		delete(plan.Work, job.target.Peer)
		if len(result.PendingMedia) > 0 {
			plan.Work[job.target.Peer] = SyncPlanCheckpoint{Cursor: target.Cursor, PendingMedia: slices.Clone(result.PendingMedia)}
		}
		*entry = SyncPlanRunTarget{
			Peer: target.Peer, Name: target.Name, Slug: target.Slug, State: "succeeded", Cursor: target.Cursor,
			LastSuccessAt: now,
			AddedMessages: target.AddedMessages, AddedMedia: target.AddedMedia, Missing: target.Missing, TaskID: target.TaskID,
		}
		run.RetryCount = 0
	}
	switch {
	case stopped || (!s.closing && errors.Is(runErr, context.Canceled)):
		finishSyncRun(run, "stopped", "执行已停止", now)
	case runErr == nil:
		advanceSyncRunTarget(run, now)
	case s.closing:
		run.State, run.Message = "queued", "客户端退出，等待从断点恢复"
		entry.State = "queued"
	case s.persistErr != nil:
		// The executor stopped at a durable checkpoint. Keep the last valid
		// state and retry the state write after the poll interval.
		return false
	default:
		applySyncRunError(&state, run, entry, plan.AccountID, now, runErr)
	}
	if err := s.commitLocked(state); err != nil {
		s.deferred = &state
		return false
	}
	return true
}

func applySyncRunError(state *syncPlanDiskState, run *syncRunRecord, target *SyncPlanRunTarget, account string, now time.Time, err error) {
	var typed *syncPlanError
	if !errors.As(err, &typed) {
		var network net.Error
		if errors.As(err, &network) && network.Timeout() {
			typed = &syncPlanError{reason: SyncPlanReasonNetwork, message: "连接超时，等待重试", transient: true}
		} else {
			typed = &syncPlanError{message: "同步执行失败，请查看关联任务或重新执行"}
		}
	}
	run.BlockedReason, target.BlockedReason = typed.reason, typed.reason
	run.Message, target.Message = typed.message, typed.message
	var retryAfter time.Time
	if typed.retryAfter > 0 {
		retryAfter = now.Add(typed.retryAfter)
	}
	if typed.reason == SyncPlanReasonFloodWait && !retryAfter.IsZero() {
		if state.Cooldowns == nil {
			state.Cooldowns = make(map[string]time.Time)
		}
		if retryAfter.After(state.Cooldowns[account]) {
			state.Cooldowns[account] = retryAfter
		}
	}
	switch {
	case typed.blocked:
		run.State, target.State = "blocked", "blocked"
		delay := syncPlanBlockDelay
		switch typed.reason {
		case SyncPlanBlockBusy:
			delay = syncPlanPollInterval
		case SyncPlanBlockAccount, SyncPlanBlockSession, SyncPlanBlockTarget, SyncPlanBlockReadOnly, SyncPlanBlockSpace:
			delay = 5 * time.Minute
		}
		run.LastBlockedAt, run.RetryAt = now, now.Add(delay)
	case typed.transient && run.RetryCount < 2:
		delay := time.Minute
		if run.RetryCount == 1 {
			delay = 5 * time.Minute
		}
		run.RetryCount++
		run.RetryAt = now.Add(delay)
		if retryAfter.After(run.RetryAt) {
			run.RetryAt = retryAfter
		}
		run.State, target.State = "retrying", "retrying"
	case !typed.transient && (typed.reason == SyncPlanBlockTarget || typed.reason == SyncPlanReasonMedia):
		target.State = "failed"
		advanceSyncRunTarget(run, now)
	default:
		finishSyncRun(run, "failed", typed.message, now)
	}
}
