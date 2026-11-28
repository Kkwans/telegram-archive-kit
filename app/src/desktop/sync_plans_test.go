package main

import (
	"context"
	"errors"
	"os"
	"reflect"
	"testing"
	"time"
	_ "time/tzdata"

	"telegramarchivekit/internal/platform"
)

func TestSyncPlanLocalClockDST(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	daily := SyncPlanSchedule{Frequency: "daily", Time: "02:30"}
	spring := time.Date(2026, 3, 8, 6, 59, 0, 0, time.UTC).In(loc)
	_, next := syncPlanSlots(daily, spring.AddDate(0, 0, -1), "2026-03-07", spring)
	want := time.Date(2026, 3, 8, 7, 0, 0, 0, time.UTC)
	if !next.at.Equal(want) || next.day != "2026-03-08" {
		t.Fatalf("spring slot = %+v, want %s", next, want)
	}
	daily.Time = "01:30"
	fall := time.Date(2026, 11, 1, 7, 0, 0, 0, time.UTC).In(loc)
	due, next := syncPlanSlots(daily, fall.AddDate(0, 0, -1), "", fall)
	want = time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC)
	if !due.at.Equal(want) || next.day != "2026-11-02" {
		t.Fatalf("folded slot = %+v, next = %+v, want %s and next day", due, next, want)
	}
	due, _ = syncPlanSlots(daily, fall.AddDate(0, 0, -1), due.day, fall)
	if !due.at.IsZero() {
		t.Fatalf("duplicated fall slot %+v", due)
	}
}

func TestSyncPlanPreviewSchedule(t *testing.T) {
	now := time.Date(2026, 11, 10, 16, 0, 0, 0, time.UTC)
	s := syncTestService(t, t.TempDir(), &now, SyncPlanHooks{})
	got, err := s.RPC(t.Context(), "syncPlanPreviewSchedule", []byte(`{"schedule":{"frequency":"weekly","time":"15:30","weekday":2}}`))
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 11, 17, 15, 30, 0, 0, time.UTC)
	if preview := got.(syncPlanSchedulePreview); !preview.NextRunAt.Equal(want) {
		t.Fatalf("schedule preview = %s, want %s", preview.NextRunAt, want)
	}
	if _, err = s.RPC(t.Context(), "syncPlanPreviewSchedule", []byte(`{"schedule":{"frequency":"daily","time":"24:00"}}`)); err == nil {
		t.Fatal("invalid wall time was accepted")
	}
	if _, err = os.Stat(s.path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("schedule preview changed persistent state: %v", err)
	}
}

func TestSyncPlanWeeklyMultipleDays(t *testing.T) {
	loc := time.FixedZone("local", 8*60*60)
	monday := time.Date(2026, 11, 16, 20, 0, 0, 0, loc)
	thursday := monday.AddDate(0, 0, 3)
	schedule := SyncPlanSchedule{Frequency: "weekly", Time: "20:00", Weekdays: []int{4, 1}}
	due, next := syncPlanSlots(schedule, monday.AddDate(0, 0, -7), "", monday.Add(time.Minute))
	if !due.at.Equal(monday) || !next.at.Equal(thursday) {
		t.Fatalf("Monday due=%v next=%v, want %v and %v", due, next, monday, thursday)
	}
	due, next = syncPlanSlots(schedule, monday.AddDate(0, 0, -7), due.day, thursday.Add(time.Minute))
	if !due.at.Equal(thursday) || !next.at.Equal(monday.AddDate(0, 0, 7)) {
		t.Fatalf("Thursday due=%v next=%v", due, next)
	}
	due, _ = syncPlanSlots(schedule, monday.AddDate(0, 0, -7), due.day, thursday.Add(time.Hour))
	if !due.at.IsZero() {
		t.Fatalf("Thursday was queued twice: %v", due)
	}
	legacy := SyncPlanSchedule{Frequency: "weekly", Time: "20:00", Weekday: 0}
	_, next = syncPlanSlots(legacy, monday, "", monday)
	if !next.at.Equal(monday.AddDate(0, 0, 6)) || !legacy.equal(SyncPlanSchedule{Frequency: "weekly", Time: "20:00", Weekdays: []int{0}}) {
		t.Fatalf("legacy Sunday should retain its schedule: %v", next)
	}
	schedule.Weekdays = []int{}
	if _, err := schedule.clock(); err == nil {
		t.Fatal("weekly schedule accepted an empty selection")
	}
}

func syncTestHooks(execute SyncPlanHooks) SyncPlanHooks {
	execute.CurrentLibraryID = func() string { return "fixture-library" }
	if execute.Bind == nil {
		execute.Bind = func(_ context.Context, inputs []SyncPlanTargetInput) (SyncPlanBinding, error) {
			out := SyncPlanBinding{LibraryID: "fixture-library", LibraryLabel: "Fixture", AccountID: "1234", Namespace: "fixture"}
			for _, input := range inputs {
				out.Targets = append(out.Targets, SyncPlanTarget{Peer: input.Peer, Slug: input.Slug, Name: input.Peer, Cursor: 7})
			}
			return out, nil
		}
	}
	if execute.Check == nil {
		execute.Check = func(context.Context, SyncPlan) error { return nil }
	}
	return execute
}

func syncTestService(t *testing.T, dir string, now *time.Time, hooks SyncPlanHooks) *SyncPlanService {
	t.Helper()
	service, err := NewSyncPlanService(dir, syncTestHooks(hooks))
	if err != nil {
		t.Fatal(err)
	}
	service.now = func() time.Time { return *now }
	return service
}

func syncTestDraft() syncPlanDraft {
	return syncPlanDraft{
		Name: "Fixture", Enabled: true, Schedule: SyncPlanSchedule{Frequency: "daily", Time: "12:00"},
		Targets: []SyncPlanTargetInput{{Peer: "channel:10", Slug: "fixture"}},
	}
}

func syncTestJob(t *testing.T, s *SyncPlanService) (syncPlanJob, context.Context) {
	t.Helper()
	job, ctx, closing := s.advance()
	if job == nil || closing {
		t.Fatalf("advance = %v, closing %v", job, closing)
	}
	return *job, ctx
}

func syncTestRun(t *testing.T, s *SyncPlanService) {
	t.Helper()
	job, ctx := syncTestJob(t, s)
	if !s.execute(ctx, job) {
		t.Fatal("execution outcome was not saved")
	}
}

func TestSyncPlanCatchupIsCoalescedAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	var calls int
	hooks := SyncPlanHooks{Execute: func(_ context.Context, _ SyncPlan, target SyncPlanTarget, _ SyncPlanCheckpoint, _ func(SyncPlanCheckpoint) error) (SyncPlanTargetResult, error) {
		calls++
		return SyncPlanTargetResult{Cursor: target.Cursor + 1}, nil
	}}
	s := syncTestService(t, dir, &now, hooks)
	if err := s.save(t.Context(), syncTestDraft(), false); err != nil {
		t.Fatal(err)
	}
	now = now.AddDate(0, 0, 4).Add(5 * time.Hour)
	syncTestRun(t, s)
	s = syncTestService(t, dir, &now, hooks)
	if next, _, _ := s.advance(); next != nil {
		t.Fatalf("already processed slot was queued again: %v", next)
	}
	snapshot := s.snapshot()
	if calls != 1 || len(snapshot.Runs) != 1 || snapshot.Runs[0].ScheduledAt.Day() != 14 ||
		snapshot.Runs[0].State != "succeeded" || snapshot.Plans[0].NextRunAt.Day() != 15 {
		t.Fatalf("unexpected coalescing: calls=%d snapshot=%+v", calls, snapshot)
	}
}

func TestSyncPlanSaveUsesLightweightTargetBinding(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	var gotName string
	hooks := SyncPlanHooks{Bind: func(_ context.Context, inputs []SyncPlanTargetInput) (SyncPlanBinding, error) {
		gotName = inputs[0].Name
		return SyncPlanBinding{LibraryID: "fixture-library", AccountID: "1234", Namespace: "fixture", Targets: []SyncPlanTarget{{Peer: inputs[0].Peer, Slug: inputs[0].Slug, Name: inputs[0].Name}}}, nil
	}}
	s := syncTestService(t, t.TempDir(), &now, hooks)
	draft := syncTestDraft()
	draft.Targets[0].Name = "保存时的聊天名称"
	if err := s.save(t.Context(), draft, false); err != nil {
		t.Fatal(err)
	}
	target := s.snapshot().Plans[0].Targets[0]
	if gotName != draft.Targets[0].Name || target.Name != draft.Targets[0].Name || target.Cursor != 0 {
		t.Fatalf("lightweight binding = input %q, target %+v", gotName, target)
	}
}

func TestSyncPlanPauseRunResumesCheckpoint(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	s := syncTestService(t, t.TempDir(), &now, SyncPlanHooks{Execute: func(context.Context, SyncPlan, SyncPlanTarget, SyncPlanCheckpoint, func(SyncPlanCheckpoint) error) (SyncPlanTargetResult, error) {
		return SyncPlanTargetResult{}, nil
	}})
	if err := s.save(t.Context(), syncTestDraft(), true); err != nil {
		t.Fatal(err)
	}
	job, ctx := syncTestJob(t, s)
	if err := s.markStarted(ctx, job); err != nil {
		t.Fatal(err)
	}
	checkpoint := job.checkpoint
	checkpoint.Stage, checkpoint.Offset, checkpoint.Through = "fetch", 9, 15
	if err := s.checkpoint(job, checkpoint); err != nil {
		t.Fatal(err)
	}
	if err := s.control("syncPlanPauseRun", job.plan.ID); err != nil {
		t.Fatal(err)
	}
	if ctx.Err() == nil {
		t.Fatal("pause run did not cancel active execution")
	}
	if !s.finish(job, SyncPlanTargetResult{}, ctx.Err()) {
		t.Fatal("pause outcome was not saved")
	}
	snap := s.snapshot()
	if snap.Runs[0].State != "paused" || snap.Runs[0].Targets[0].State != "paused" {
		t.Fatalf("run was not paused: %+v", snap.Runs[0])
	}
	if err := s.control("syncPlanResumeRun", job.plan.ID); err != nil {
		t.Fatal(err)
	}
	resumed, _ := syncTestJob(t, s)
	if resumed.runID != job.runID || resumed.checkpoint.WorkID != checkpoint.WorkID || resumed.checkpoint.Stage != "fetch" || resumed.checkpoint.Offset != 9 || resumed.checkpoint.Through != 15 {
		t.Fatalf("resume lost checkpoint: %+v", resumed)
	}
}

func TestSyncPlanConflictAndPause(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	s := syncTestService(t, t.TempDir(), &now, SyncPlanHooks{})
	draft := syncTestDraft()
	if err := s.save(t.Context(), draft, true); err != nil {
		t.Fatal(err)
	}
	if err := s.save(t.Context(), draft, false); err == nil {
		t.Fatal("overlapping enabled plan accepted")
	}
	id := s.snapshot().Plans[0].ID
	if err := s.control("syncPlanPause", id); err != nil {
		t.Fatal(err)
	}
	if err := s.save(t.Context(), draft, false); err != nil {
		t.Fatal(err)
	}
	if err := s.control("syncPlanResume", id); err == nil {
		t.Fatal("overlap accepted on resume")
	}
	snap := s.snapshot()
	if snap.Plans[0].Enabled || snap.Plans[0].State != "queued" {
		t.Fatalf("pause modified the pending run: %+v", snap.Plans[0])
	}
	if err := s.control("syncPlanRunNow", id); err != nil {
		t.Fatal(err)
	}
	if len(s.snapshot().Runs) != 1 {
		t.Fatal("manual trigger queued the same plan twice")
	}
}

func TestSyncPlanFailedRunKeepsPreviousSuccess(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	successAt := now
	hooks := SyncPlanHooks{Execute: func(_ context.Context, _ SyncPlan, target SyncPlanTarget, _ SyncPlanCheckpoint, _ func(SyncPlanCheckpoint) error) (SyncPlanTargetResult, error) {
		if now.After(successAt) {
			return SyncPlanTargetResult{}, errors.New("test failure")
		}
		return SyncPlanTargetResult{Cursor: target.Cursor + 1}, nil
	}}
	s := syncTestService(t, t.TempDir(), &now, hooks)
	if err := s.save(t.Context(), syncTestDraft(), true); err != nil {
		t.Fatal(err)
	}
	syncTestRun(t, s)
	now = now.Add(time.Hour)
	if err := s.control("syncPlanRunNow", s.snapshot().Plans[0].ID); err != nil {
		t.Fatal(err)
	}
	syncTestRun(t, s)
	run := s.snapshot().Runs[0]
	if run.State != "failed" || !run.Targets[0].LastSuccessAt.Equal(successAt) {
		t.Fatalf("latest run should be failed with the previous success at %s: %+v", successAt, run)
	}
}

func TestSyncPlanRetryKeepsCheckpointAndCompletedTargets(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	var workID string
	var calls []string
	s := syncTestService(t, t.TempDir(), &now, SyncPlanHooks{Execute: func(_ context.Context, _ SyncPlan, target SyncPlanTarget, cp SyncPlanCheckpoint, write func(SyncPlanCheckpoint) error) (SyncPlanTargetResult, error) {
		calls = append(calls, target.Peer)
		if target.Peer == "channel:10" {
			return SyncPlanTargetResult{Cursor: 10, TaskID: "download-first"}, nil
		}
		if workID == "" {
			workID = cp.WorkID
			cp.Stage, cp.Offset, cp.Through = "fetch", 9, 15
			if err := write(cp); err != nil {
				return SyncPlanTargetResult{}, err
			}
		} else if cp.WorkID != workID || cp.Offset != 9 || cp.Through != 15 {
			t.Errorf("checkpoint lost: %+v, workID %s", cp, workID)
		}
		if len(calls) < 5 {
			return SyncPlanTargetResult{}, SyncPlanTransient(SyncPlanReasonNetwork, "fixture network", 0)
		}
		return SyncPlanTargetResult{Cursor: 15, AddedMessages: 8, TaskID: "download-second"}, nil
	}})
	draft := syncTestDraft()
	legacyLimit := 2
	draft.MaxRetries = &legacyLimit
	draft.Targets = append(draft.Targets, SyncPlanTargetInput{Peer: "channel:20"})
	if err := s.save(t.Context(), draft, true); err != nil {
		t.Fatal(err)
	}
	syncTestRun(t, s)
	syncTestRun(t, s)
	for _, wait := range []time.Duration{time.Minute, 5 * time.Minute} {
		if until := s.snapshot().Runs[0].RetryAt; !until.Equal(now.Add(wait)) {
			t.Fatalf("retry at %s, want %s", until, now.Add(wait))
		}
		if job, _, _ := s.advance(); job != nil {
			t.Fatal("retried before backoff expired")
		}
		now = now.Add(wait)
		syncTestRun(t, s)
	}
	snap := s.snapshot()
	if snap.Runs[0].State != "failed" {
		t.Fatalf("retry budget was not exhausted: %+v", snap.Runs[0])
	}
	if err := s.control("syncPlanRetry", snap.Plans[0].ID); err != nil {
		t.Fatal(err)
	}
	syncTestRun(t, s)
	snap = s.snapshot()
	want := []string{"channel:10", "channel:20", "channel:20", "channel:20", "channel:20"}
	if !reflect.DeepEqual(calls, want) || len(snap.Runs) != 2 || snap.Runs[0].State != "succeeded" ||
		snap.Runs[0].Targets[0].TaskID != "download-first" || snap.Plans[0].Targets[1].Cursor != 15 {
		t.Fatalf("retry = calls %v, snapshot %+v", calls, snap)
	}
}

func TestSyncPlanRetriesAreBoundedPerTargetAcrossRestart(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	var firstCalls, secondCalls int
	hooks := SyncPlanHooks{Execute: func(_ context.Context, _ SyncPlan, target SyncPlanTarget, cp SyncPlanCheckpoint, _ func(SyncPlanCheckpoint) error) (SyncPlanTargetResult, error) {
		if target.Peer == "channel:10" {
			firstCalls++
			return SyncPlanTargetResult{}, SyncPlanBlocked(SyncPlanBlockRemote, "fixture remote")
		}
		secondCalls++
		return SyncPlanTargetResult{Cursor: cp.Cursor + 1}, nil
	}}
	s := syncTestService(t, dir, &now, hooks)
	draft := syncTestDraft()
	draft.Targets = append(draft.Targets, SyncPlanTargetInput{Peer: "channel:20"})
	if err := s.save(t.Context(), draft, true); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 4; attempt++ {
		syncTestRun(t, s)
		if attempt < 3 {
			if got := s.snapshot().Runs[0].Targets[0].RetryCount; got != attempt+1 {
				t.Fatalf("saved retry count = %d after attempt %d", got, attempt+1)
			}
			now = now.Add(5 * time.Minute)
			if attempt == 1 {
				s = syncTestService(t, dir, &now, hooks)
			}
		}
	}
	if target := s.snapshot().Runs[0].Targets[0]; target.State != "failed" || target.RetryCount != 3 {
		t.Fatalf("retry limit did not finish the failed target: %+v", target)
	}
	syncTestRun(t, s)
	if run := s.snapshot().Runs[0]; run.State != "failed" || run.Targets[1].State != "succeeded" || firstCalls != 4 || secondCalls != 1 {
		t.Fatalf("other targets were not handled independently: %+v, calls %d/%d", run, firstCalls, secondCalls)
	}
}

func TestSyncPlanSpaceFailureDoesNotRetry(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	var calls int
	s := syncTestService(t, t.TempDir(), &now, SyncPlanHooks{Execute: func(_ context.Context, _ SyncPlan, _ SyncPlanTarget, _ SyncPlanCheckpoint, _ func(SyncPlanCheckpoint) error) (SyncPlanTargetResult, error) {
		calls++
		return SyncPlanTargetResult{}, SyncPlanBlocked(SyncPlanBlockSpace, "fixture space")
	}})
	if err := s.save(t.Context(), syncTestDraft(), true); err != nil {
		t.Fatal(err)
	}
	syncTestRun(t, s)
	if run := s.snapshot().Runs[0]; run.State != "failed" || run.Targets[0].RetryCount != 0 || !run.RetryAt.IsZero() {
		t.Fatalf("space failure was scheduled for retry: %+v", run)
	}
	now = now.Add(time.Hour)
	s.Wake()
	if job, _, _ := s.advance(); job != nil || calls != 1 {
		t.Fatal("space failure started an automatic retry")
	}
}

func TestLegacyBlockedSpaceRunIsNotRestarted(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	s := syncTestService(t, t.TempDir(), &now, SyncPlanHooks{})
	if err := s.save(t.Context(), syncTestDraft(), true); err != nil {
		t.Fatal(err)
	}
	state := s.state.clone()
	state.Runs[0].State = "blocked"
	state.Runs[0].BlockedReason = SyncPlanBlockSpace
	state.Runs[0].Message = "fixture space"
	state.Runs[0].Targets[0].State = "blocked"
	state.Runs[0].Targets[0].BlockedReason = SyncPlanBlockSpace
	state.Runs[0].Targets[0].Message = "fixture space"
	if err := s.commitLocked(state); err != nil {
		t.Fatal(err)
	}
	if job, _, _ := s.advance(); job != nil {
		t.Fatal("legacy space failure was restarted")
	}
	if run := s.snapshot().Runs[0]; run.State != "failed" || run.Targets[0].State != "failed" {
		t.Fatalf("legacy blocked run was not finished: %+v", run)
	}
}

func TestSyncPlanRetryLimitCanBeZero(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	s := syncTestService(t, t.TempDir(), &now, SyncPlanHooks{Execute: func(_ context.Context, _ SyncPlan, _ SyncPlanTarget, _ SyncPlanCheckpoint, _ func(SyncPlanCheckpoint) error) (SyncPlanTargetResult, error) {
		return SyncPlanTargetResult{}, SyncPlanTransient(SyncPlanReasonNetwork, "fixture network", 0)
	}})
	draft := syncTestDraft()
	zero := 0
	draft.MaxRetries = &zero
	if err := s.save(t.Context(), draft, true); err != nil {
		t.Fatal(err)
	}
	syncTestRun(t, s)
	if run := s.snapshot().Runs[0]; run.State != "failed" || run.Targets[0].RetryCount != 0 {
		t.Fatalf("zero retry limit was not respected: %+v", run)
	}
}

func TestSyncPlanInterruptedCheckpointAndDeferredStateWrite(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	first := syncTestService(t, dir, &now, SyncPlanHooks{})
	if err := first.save(t.Context(), syncTestDraft(), true); err != nil {
		t.Fatal(err)
	}
	job, ctx := syncTestJob(t, first)
	if err := first.markStarted(ctx, job); err != nil {
		t.Fatal(err)
	}
	cp := job.checkpoint
	cp.Stage, cp.Through = "staged", 25
	cp.PendingMedia = []string{"video/fixture.mp4"}
	if err := first.checkpoint(job, cp); err != nil {
		t.Fatal(err)
	}
	first.active.cancel()

	calls := 0
	reopened := syncTestService(t, dir, &now, SyncPlanHooks{Execute: func(_ context.Context, _ SyncPlan, _ SyncPlanTarget, got SyncPlanCheckpoint, _ func(SyncPlanCheckpoint) error) (SyncPlanTargetResult, error) {
		calls++
		if !reflect.DeepEqual(cp, got) {
			t.Errorf("reopened checkpoint = %+v, want %+v", got, cp)
		}
		return SyncPlanTargetResult{Cursor: 25, AddedMessages: 3, PendingMedia: cp.PendingMedia}, nil
	}})
	if reopened.snapshot().Runs[0].State != "queued" {
		t.Fatal("interrupted run did not return to the queue")
	}
	fail := false
	reopened.write = func(path string, data []byte, mode os.FileMode) error {
		if fail {
			return errors.New("fixture storage unavailable")
		}
		return platform.AtomicWriteFile(path, data, mode)
	}
	job, ctx = syncTestJob(t, reopened)
	if err := reopened.markStarted(ctx, job); err != nil {
		t.Fatal(err)
	}
	result, err := reopened.hooks.Execute(ctx, job.plan, job.target, job.checkpoint, nil)
	fail = true
	if reopened.finish(job, result, err) {
		t.Fatal("fixture write should fail")
	}
	if next, _, _ := reopened.advance(); next != nil || reopened.snapshot().Error == "" {
		t.Fatalf("work restarted before result could be persisted: %v", next)
	}
	fail = false
	if next, _, _ := reopened.advance(); next != nil {
		t.Fatalf("persisted result unexpectedly re-executed: %v", next)
	}
	last := syncTestService(t, dir, &now, SyncPlanHooks{})
	snapshot := last.snapshot()
	work := last.state.Plans[0].Work["channel:10"]
	if calls != 1 || snapshot.Error != "" || snapshot.Runs[0].State != "succeeded" ||
		snapshot.Plans[0].Targets[0].Cursor != 25 || !reflect.DeepEqual(work.PendingMedia, cp.PendingMedia) {
		t.Fatalf("deferred outcome was lost: calls=%d snapshot=%+v checkpoint=%+v", calls, snapshot, work)
	}
}

func TestSyncPlanShutdownPreservesQueuedRecovery(t *testing.T) {
	now := time.Now()
	dir := t.TempDir()
	entered := make(chan struct{})
	s := syncTestService(t, dir, &now, SyncPlanHooks{Execute: func(ctx context.Context, _ SyncPlan, _ SyncPlanTarget, cp SyncPlanCheckpoint, write func(SyncPlanCheckpoint) error) (SyncPlanTargetResult, error) {
		cp.Stage = "fetch"
		err := write(cp)
		close(entered)
		if err != nil {
			return SyncPlanTargetResult{}, err
		}
		<-ctx.Done()
		return SyncPlanTargetResult{}, ctx.Err()
	}})
	if err := s.save(t.Context(), syncTestDraft(), true); err != nil {
		t.Fatal(err)
	}
	s.Start()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	s = syncTestService(t, dir, &now, SyncPlanHooks{})
	if s.snapshot().Runs[0].State != "queued" || s.state.Plans[0].Work["channel:10"].Stage != "fetch" {
		t.Fatalf("shutdown discarded recovery: %+v", s.snapshot())
	}
}

func TestSyncPlanEngineStopAndDiscard(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	var discarded SyncPlanCheckpoint
	hooks := SyncPlanHooks{
		Execute: func(_ context.Context, _ SyncPlan, _ SyncPlanTarget, cp SyncPlanCheckpoint, write func(SyncPlanCheckpoint) error) (SyncPlanTargetResult, error) {
			cp.Stage, cp.TaskID = "fetch", "fixture-task"
			if err := write(cp); err != nil {
				return SyncPlanTargetResult{}, err
			}
			return SyncPlanTargetResult{}, context.Canceled
		},
		DiscardWork: func(_ SyncPlan, _ SyncPlanTarget, cp SyncPlanCheckpoint) { discarded = cp },
	}
	s := syncTestService(t, t.TempDir(), &now, hooks)
	if err := s.save(t.Context(), syncTestDraft(), true); err != nil {
		t.Fatal(err)
	}
	syncTestRun(t, s)
	snapshot := s.snapshot()
	if snapshot.Runs[0].State != "stopped" || snapshot.Runs[0].Targets[0].TaskID != "fixture-task" {
		t.Fatalf("task stop = %+v", snapshot.Runs[0])
	}
	if err := s.control("syncPlanDelete", snapshot.Plans[0].ID); err != nil {
		t.Fatal(err)
	}
	if discarded.Stage != "fetch" || discarded.WorkID == "" || len(s.snapshot().Runs) != 1 {
		t.Fatalf("delete cleanup discarded=%+v, snapshot=%+v", discarded, s.snapshot())
	}
}

func TestSyncPlanFloodWaitSurvivesRestartAndGatesOtherPlans(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	var calls int
	hooks := SyncPlanHooks{Execute: func(_ context.Context, _ SyncPlan, _ SyncPlanTarget, cp SyncPlanCheckpoint, _ func(SyncPlanCheckpoint) error) (SyncPlanTargetResult, error) {
		calls++
		if calls == 1 {
			return SyncPlanTargetResult{}, SyncPlanTransient(SyncPlanReasonFloodWait, "fixture FloodWait", 90*time.Second)
		}
		return SyncPlanTargetResult{Cursor: cp.Cursor}, nil
	}}
	s := syncTestService(t, dir, &now, hooks)
	for _, peer := range []string{"channel:10", "channel:11"} {
		draft := syncTestDraft()
		draft.Targets = []SyncPlanTargetInput{{Peer: peer}}
		if err := s.save(t.Context(), draft, true); err != nil {
			t.Fatal(err)
		}
	}
	syncTestRun(t, s)
	s = syncTestService(t, dir, &now, hooks)
	now = now.Add(89 * time.Second)
	if job, _, _ := s.advance(); job != nil {
		t.Fatal("another plan bypassed the account cooldown")
	}
	for _, run := range s.snapshot().Runs {
		if run.State != "retrying" || run.BlockedReason != SyncPlanReasonFloodWait {
			t.Fatalf("missing rate limit reason: %+v", run)
		}
	}
	now = now.Add(time.Second)
	syncTestRun(t, s)
	syncTestRun(t, s)
	if calls != 3 {
		t.Fatalf("unexpected requests: %d", calls)
	}
}

func TestSyncPlanTargetFailureDoesNotBlockOtherTargets(t *testing.T) {
	now := time.Date(2026, 11, 10, 8, 0, 0, 0, time.UTC)
	var calls []string
	s := syncTestService(t, t.TempDir(), &now, SyncPlanHooks{Execute: func(_ context.Context, _ SyncPlan, target SyncPlanTarget, cp SyncPlanCheckpoint, _ func(SyncPlanCheckpoint) error) (SyncPlanTargetResult, error) {
		calls = append(calls, target.Peer)
		if len(calls) == 1 {
			return SyncPlanTargetResult{}, SyncPlanFailed(SyncPlanBlockTarget, "fixture peer denied")
		}
		return SyncPlanTargetResult{Cursor: cp.Cursor + 1}, nil
	}})
	draft := syncTestDraft()
	draft.Targets = append(draft.Targets, SyncPlanTargetInput{Peer: "channel:20"})
	if err := s.save(t.Context(), draft, true); err != nil {
		t.Fatal(err)
	}
	syncTestRun(t, s)
	syncTestRun(t, s)
	snapshot := s.snapshot()
	run := snapshot.Runs[0]
	if run.State != "failed" || run.Targets[0].State != "failed" || run.Targets[1].State != "succeeded" ||
		run.Targets[0].BlockedReason != SyncPlanBlockTarget {
		t.Fatalf("unexpected mixed target result: %+v", run)
	}
	if err := s.control("syncPlanRetry", snapshot.Plans[0].ID); err != nil {
		t.Fatal(err)
	}
	syncTestRun(t, s)
	if want := []string{"channel:10", "channel:20", "channel:10"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("unexpected retry targets: got %v, want %v", calls, want)
	}
	if run := s.snapshot().Runs[0]; run.State != "succeeded" {
		t.Fatalf("selective retry did not finish run: %+v", run)
	}
}
