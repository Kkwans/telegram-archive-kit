package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

type syncPlanSchedulePreview struct {
	NextRunAt time.Time `json:"nextRunAt"`
}

func (s *SyncPlanService) RPC(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	if method == "syncPlanList" {
		return s.snapshot(), nil
	}
	var p struct {
		ID       string           `json:"id"`
		Plan     syncPlanDraft    `json:"plan"`
		RunNow   bool             `json:"runNow"`
		Enabled  *bool            `json:"enabled"`
		Schedule SyncPlanSchedule `json:"schedule"`
	}
	if len(raw) != 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, errors.New("同步计划请求格式错误")
		}
	}
	var err error
	switch method {
	case "syncPlanPreviewSchedule":
		if _, err := p.Schedule.clock(); err != nil {
			return nil, err
		}
		now := s.now()
		due, next := syncPlanSlots(p.Schedule, now, "", now)
		if !due.at.IsZero() {
			next = due
		}
		return syncPlanSchedulePreview{NextRunAt: next.at}, nil
	case "syncPlanSave":
		err = s.save(ctx, p.Plan, p.RunNow)
	case "syncPlanRunNow", "syncPlanPause", "syncPlanResume", "syncPlanStop", "syncPlanRetry", "syncPlanDelete":
		err = s.control(method, p.ID)
	case "syncPlanSetLaunchOnLogin":
		if s.hooks.SetLaunchOnLogin == nil {
			return nil, errors.New("当前客户端不支持开机启动")
		}
		if p.Enabled == nil {
			return nil, errors.New("缺少开机启动设置")
		}
		err = s.hooks.SetLaunchOnLogin(*p.Enabled)
	default:
		return nil, fmt.Errorf("未知同步计划操作 %q", method)
	}
	if err != nil {
		return nil, err
	}
	return s.snapshot(), nil
}

func (s *SyncPlanService) snapshot() SyncPlanSnapshot {
	var out SyncPlanSnapshot
	if s.hooks.CurrentLibraryID != nil {
		out.CurrentLibraryID = s.hooks.CurrentLibraryID()
	}
	if s.hooks.GetLaunchOnLogin != nil {
		value, err := s.hooks.GetLaunchOnLogin()
		if err == nil {
			out.LaunchOnLogin = value
		} else {
			out.LaunchOnLoginError = err.Error()
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.persistErr != nil {
		out.Error = s.persistErr.Error()
	}
	out.Plans = make([]SyncPlan, 0, len(s.state.Plans))
	out.Runs = make([]SyncPlanRun, 0, len(s.state.Runs))
	now := s.now()
	for _, record := range s.state.Plans {
		plan := cloneSyncPlan(record.SyncPlan)
		if plan.Enabled {
			due, next := syncPlanSlots(plan.Schedule, record.EligibleAt, record.LastSlot, now)
			plan.NextRunAt = next.at
			if !due.at.IsZero() && s.state.pendingIndex(plan.ID) < 0 {
				plan.NextRunAt = due.at
			}
		}
		plan.State = "idle"
		if !plan.Enabled {
			plan.State = "paused"
		}
		i := s.state.newestRunIndex(plan.ID)
		switch {
		case i >= 0 && syncPending(s.state.Runs[i].State):
			run := s.state.Runs[i]
			plan.State, plan.BlockedReason, plan.Message = run.State, run.BlockedReason, run.Message
			plan.ActiveRunID = run.ID
		case plan.Enabled && s.hooks.CurrentLibraryID != nil && out.CurrentLibraryID != plan.LibraryID:
			plan.State, plan.BlockedReason, plan.Message = "blocked", SyncPlanBlockLibrary, "等待打开计划绑定的档案库"
		case i >= 0 && plan.Enabled:
			run := s.state.Runs[i]
			plan.State, plan.BlockedReason, plan.Message = run.State, run.BlockedReason, run.Message
		}
		out.Plans = append(out.Plans, plan)
	}
	for i := len(s.state.Runs) - 1; i >= 0; i-- {
		run := s.state.Runs[i].SyncPlanRun
		run.Targets = slices.Clone(run.Targets)
		out.Runs = append(out.Runs, run)
	}
	return out
}

func normalizeSyncPlanDraft(d *syncPlanDraft) error {
	d.Name = strings.TrimSpace(d.Name)
	if d.Name == "" || len([]rune(d.Name)) > 80 {
		return errors.New("同步计划名称应为 1–80 个字符")
	}
	if _, err := d.Schedule.clock(); err != nil {
		return err
	}
	if d.Schedule.Frequency == "daily" {
		d.Schedule.Weekday = 0
	}
	switch d.FirstScope {
	case "":
		d.FirstScope = "30d"
	case "30d", "now", "all":
	default:
		return errors.New("首次同步范围无效")
	}
	kinds := make([]string, 0, len(d.MediaKinds))
	for _, kind := range []string{"image", "video", "audio", "file"} {
		if slices.Contains(d.MediaKinds, kind) {
			kinds = append(kinds, kind)
		}
	}
	if len(kinds) != len(d.MediaKinds) {
		return errors.New("媒体类型有重复或无效的选项")
	}
	d.MediaKinds = kinds
	if len(kinds) == 0 {
		d.IncludeHistory = false
	}
	if len(d.Targets) == 0 {
		return errors.New("至少选择一个 Telegram 聊天")
	}
	seen := make(map[string]bool, len(d.Targets))
	for i := range d.Targets {
		t := &d.Targets[i]
		t.Peer = strings.TrimSpace(t.Peer)
		t.Slug = strings.TrimSpace(t.Slug)
		kind, value, _ := strings.Cut(t.Peer, ":")
		id, err := strconv.ParseInt(value, 10, 64)
		if err != nil || id <= 0 || value != strconv.FormatInt(id, 10) ||
			(kind != "user" && kind != "chat" && kind != "channel") {
			return fmt.Errorf("无效的 Telegram 聊天标识 %q", t.Peer)
		}
		if seen[t.Peer] {
			return errors.New("同一计划中不能重复选择聊天")
		}
		seen[t.Peer] = true
	}
	return nil
}

func syncUnboundTargets(d syncPlanDraft, old SyncPlan) []SyncPlanTargetInput {
	var added []SyncPlanTargetInput
	for _, target := range d.Targets {
		if !slices.ContainsFunc(old.Targets, func(t SyncPlanTarget) bool {
			return t.Peer == target.Peer && (target.Slug == "" || strings.EqualFold(t.Slug, target.Slug))
		}) {
			added = append(added, target)
		}
	}
	return added
}

func (s *SyncPlanService) save(ctx context.Context, d syncPlanDraft, runNow bool) error {
	if err := normalizeSyncPlanDraft(&d); err != nil {
		return err
	}
	s.mu.Lock()
	var original syncPlanRecord
	if d.ID != "" {
		i := s.state.planIndex(d.ID)
		if i < 0 {
			s.mu.Unlock()
			return errors.New("同步计划不存在")
		}
		original = s.state.Plans[i]
	}
	s.mu.Unlock()

	unbound := syncUnboundTargets(d, original.SyncPlan)
	var binding SyncPlanBinding
	if len(unbound) > 0 {
		if s.hooks.Bind == nil {
			return errors.New("同步计划尚未连接到档案服务")
		}
		var err error
		binding, err = s.hooks.Bind(ctx, unbound)
		if err != nil {
			return err
		}
		if binding.LibraryID == "" || binding.AccountID == "" || binding.Namespace == "" || len(binding.Targets) != len(unbound) {
			return errors.New("无法确认计划绑定的档案库、账号或聊天")
		}
		if d.ID != "" && (binding.LibraryID != original.LibraryID || binding.AccountID != original.AccountID || binding.Namespace != original.Namespace) {
			return errors.New("请切换到计划绑定的档案库及 Telegram 账号再修改聊天")
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	var before, after syncPlanRecord
	defer func() {
		s.mu.Unlock()
		s.discardReplacedWork(before, after)
	}()
	if s.closing {
		return errors.New("客户端正在退出")
	}
	if err := s.flushLocked(); err != nil {
		return err
	}
	now := s.now()
	state := s.state.clone()
	i := state.planIndex(d.ID)
	record := syncPlanRecord{Work: make(map[string]SyncPlanCheckpoint), Revision: 1, EligibleAt: now}
	if d.ID != "" {
		if i < 0 || state.Plans[i].Edit != original.Edit {
			return errors.New("计划已更新，请刷新后重试")
		}
		record = state.Plans[i]
		original = s.state.Plans[i]
	} else {
		record.ID = state.nextID("plan-")
		record.CreatedAt = now.UnixMilli()
		record.LibraryID, record.LibraryLabel = binding.LibraryID, binding.LibraryLabel
		record.AccountID, record.Namespace = binding.AccountID, binding.Namespace
	}
	targets := make([]SyncPlanTarget, 0, len(d.Targets))
	changed := d.FirstScope != record.FirstScope || d.IncludeHistory != record.IncludeHistory ||
		!slices.Equal(d.MediaKinds, record.MediaKinds) || len(d.Targets) != len(record.Targets)
	for _, input := range d.Targets {
		if at := slices.IndexFunc(record.Targets, func(t SyncPlanTarget) bool {
			return t.Peer == input.Peer && (input.Slug == "" || strings.EqualFold(t.Slug, input.Slug))
		}); at >= 0 {
			targets = append(targets, record.Targets[at])
			changed = changed || at != len(targets)-1
			continue
		}
		at := slices.IndexFunc(binding.Targets, func(t SyncPlanTarget) bool { return t.Peer == input.Peer })
		if at < 0 || binding.Targets[at].Cursor < 0 {
			return fmt.Errorf("无法验证所选聊天 %s", input.Peer)
		}
		target := binding.Targets[at]
		target.AddedAt = now.UnixMilli()
		targets = append(targets, target)
		delete(record.Work, input.Peer)
		changed = true
	}
	pending := state.pendingIndex(record.ID)
	if changed && pending >= 0 {
		return errors.New("请先停止当前执行，再修改聊天或同步范围")
	}
	if changed {
		record.Revision++
		for peer, work := range record.Work {
			at := slices.IndexFunc(targets, func(t SyncPlanTarget) bool { return t.Peer == peer })
			switch {
			case at < 0:
				delete(record.Work, peer)
			case d.FirstScope != record.FirstScope && targets[at].Cursor == 0 && targets[at].Slug == "" && work.Stage != "committed":
				delete(record.Work, peer)
			case !slices.Equal(d.MediaKinds, record.MediaKinds) && work.Stage == "staged":
				// Recompute media selection using the same fetched pages.
				work.Stage = "fetched"
				record.Work[peer] = work
			}
		}
	}
	if d.Schedule != record.Schedule {
		record.EligibleAt, record.LastSlot = now, ""
	} else if d.Enabled && !record.Enabled {
		record.EligibleAt = now
	}
	record.Name, record.Schedule, record.Enabled = d.Name, d.Schedule, d.Enabled
	record.FirstScope, record.MediaKinds, record.IncludeHistory = d.FirstScope, d.MediaKinds, d.IncludeHistory
	record.Targets = targets
	record.Edit++
	if err := syncPlanConflicts(record.SyncPlan, state.Plans); err != nil {
		return err
	}
	if i < 0 {
		state.Plans = append(state.Plans, record)
		i = len(state.Plans) - 1
	} else {
		state.Plans[i] = record
	}
	if runNow && pending < 0 {
		state.enqueue(i, "manual", time.Time{}, nil)
	}
	if err := s.commitLocked(state); err != nil {
		return err
	}
	before, after = original, record
	s.notify()
	return nil
}

func (s *SyncPlanService) discardReplacedWork(before, after syncPlanRecord) {
	if s.hooks.DiscardWork == nil {
		return
	}
	for _, target := range before.Targets {
		work := before.Work[target.Peer]
		if work.WorkID != "" && work.WorkID != after.Work[target.Peer].WorkID {
			s.hooks.DiscardWork(before.SyncPlan, target, work)
		}
	}
}

func syncPlanConflicts(plan SyncPlan, plans []syncPlanRecord) error {
	for i, target := range plan.Targets {
		for _, earlier := range plan.Targets[:i] {
			if target.Slug != "" && strings.EqualFold(earlier.Slug, target.Slug) {
				return errors.New("同一档案目录只能绑定一个聊天")
			}
		}
		if !plan.Enabled {
			continue
		}
		for _, other := range plans {
			if other.ID == plan.ID || !other.Enabled || other.LibraryID != plan.LibraryID || other.AccountID != plan.AccountID {
				continue
			}
			if slices.ContainsFunc(other.Targets, func(t SyncPlanTarget) bool {
				return t.Peer == target.Peer || (t.Slug != "" && strings.EqualFold(t.Slug, target.Slug))
			}) {
				return fmt.Errorf("聊天「%s」已由启用的计划「%s」同步", target.Name, other.Name)
			}
		}
	}
	return nil
}

func (s *syncPlanDiskState) enqueue(index int, trigger string, scheduled time.Time, from *syncRunRecord) {
	p := &s.Plans[index]
	run := syncRunRecord{
		SyncPlanRun: SyncPlanRun{
			ID: s.nextID("run-"), PlanID: p.ID, PlanName: p.Name, State: "queued", Trigger: trigger, ScheduledAt: scheduled,
			Targets: make([]SyncPlanRunTarget, 0, len(p.Targets)),
		},
		Revision: p.Revision,
	}
	for _, target := range p.Targets {
		if from != nil {
			i := slices.IndexFunc(from.Targets, func(t SyncPlanRunTarget) bool { return t.Peer == target.Peer && t.State == "succeeded" })
			if i >= 0 {
				run.Targets = append(run.Targets, from.Targets[i])
				continue
			}
		}
		entry := SyncPlanRunTarget{Peer: target.Peer, Name: target.Name, Slug: target.Slug, State: "queued", Cursor: target.Cursor}
		if checkpoint, ok := p.Work[target.Peer]; ok && checkpoint.Stage != "" {
			entry.updateCheckpoint(checkpoint)
		}
		run.Targets = append(run.Targets, entry)
	}
	s.Runs = append(s.Runs, run)
}

func (s *SyncPlanService) control(method, id string) error {
	s.mu.Lock()
	var discard syncPlanRecord
	defer func() {
		s.mu.Unlock()
		s.discardReplacedWork(discard, syncPlanRecord{})
	}()
	if s.closing {
		return errors.New("客户端正在退出")
	}
	if err := s.flushLocked(); err != nil {
		return err
	}
	state := s.state.clone()
	index := state.planIndex(id)
	if index < 0 {
		return errors.New("同步计划不存在")
	}
	record := &state.Plans[index]
	pending := state.pendingIndex(id)
	now := s.now()
	var cancel context.CancelFunc
	switch method {
	case "syncPlanRunNow", "syncPlanRetry":
		if pending >= 0 {
			if state.Runs[pending].State == "blocked" {
				s.wakeAt = now
				s.notify()
			}
			return nil
		}
		if method == "syncPlanRunNow" {
			state.enqueue(index, "manual", time.Time{}, nil)
			break
		}
		last := state.newestRunIndex(id)
		if last < 0 || (state.Runs[last].State != "failed" && state.Runs[last].State != "stopped") {
			return errors.New("没有可重试的执行")
		}
		if state.Runs[last].Revision != record.Revision {
			return errors.New("计划的同步范围已更改，请立即运行一次新计划")
		}
		from := state.Runs[last]
		state.enqueue(index, "retry", time.Time{}, &from)
	case "syncPlanPause":
		if !record.Enabled {
			return nil
		}
		record.Enabled = false
		record.Edit++
	case "syncPlanResume":
		if record.Enabled {
			return nil
		}
		record.Enabled = true
		record.Edit++
		if err := syncPlanConflicts(record.SyncPlan, state.Plans); err != nil {
			return err
		}
		record.EligibleAt = now
	case "syncPlanStop":
		if pending < 0 {
			return nil
		}
		scheduleSyncPlans(&state, now)
		run := &state.Runs[pending]
		if s.active != nil && s.active.id == run.ID {
			run.State, run.Message = "stopping", "正在停止执行"
			cancel = s.active.cancel
		} else {
			finishSyncRun(run, "stopped", "执行已停止", now)
		}
	case "syncPlanDelete":
		if pending >= 0 {
			return errors.New("请先停止当前执行再删除计划")
		}
		deleted := *record
		state.Plans = slices.Delete(state.Plans, index, index+1)
		if err := s.commitLocked(state); err != nil {
			return err
		}
		discard = deleted
		s.notify()
		return nil
	}
	if err := s.commitLocked(state); err != nil {
		return err
	}
	if cancel != nil {
		cancel()
	}
	s.notify()
	return nil
}
