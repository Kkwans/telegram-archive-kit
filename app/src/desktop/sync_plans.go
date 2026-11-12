package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"time"

	"telegramarchivekit/internal/platform"
)

const (
	SyncPlanBlockLibrary    = "library"
	SyncPlanBlockAccount    = "account"
	SyncPlanBlockSession    = "session"
	SyncPlanBlockRemote     = "remote"
	SyncPlanBlockReadOnly   = "readOnly"
	SyncPlanBlockTarget     = "target"
	SyncPlanBlockBusy       = "busy"
	SyncPlanBlockSpace      = "space"
	SyncPlanReasonNetwork   = "network"
	SyncPlanReasonFloodWait = "floodWait"
	SyncPlanReasonMedia     = "media"

	syncPlanStateVersion = 1
	syncPlanHistorySize  = 30
	syncPlanPollInterval = 15 * time.Second
	syncPlanBlockDelay   = 30 * time.Second
)

type syncPlanError struct {
	reason, message string
	blocked         bool
	transient       bool
	retryAfter      time.Duration
}

func (e *syncPlanError) Error() string { return e.message }

func SyncPlanBlocked(reason, message string) error {
	return &syncPlanError{reason: reason, message: message, blocked: true}
}

func SyncPlanTransient(reason, message string, retryAfter time.Duration) error {
	return &syncPlanError{reason: reason, message: message, transient: true, retryAfter: retryAfter}
}

func SyncPlanFailed(reason, message string) error {
	return &syncPlanError{reason: reason, message: message}
}

type SyncPlanTargetInput struct {
	Peer string `json:"peer"`
	Slug string `json:"slug,omitempty"`
}

type SyncPlanTarget struct {
	Peer          string    `json:"peer"`
	Slug          string    `json:"slug,omitempty"`
	Name          string    `json:"name"`
	Cursor        int       `json:"cursor"`
	AddedAt       int64     `json:"addedAt,omitempty"`
	LastSuccessAt time.Time `json:"lastSuccessAt,omitzero"`
	AddedMessages int       `json:"addedMessages"`
	AddedMedia    int       `json:"addedMedia"`
	Missing       int       `json:"missing"`
	TaskID        string    `json:"taskId,omitempty"`
}

type SyncPlan struct {
	ID             string           `json:"id"`
	Name           string           `json:"name"`
	LibraryID      string           `json:"libraryId"`
	LibraryLabel   string           `json:"libraryLabel"`
	AccountID      string           `json:"accountId"`
	Namespace      string           `json:"namespace"`
	Schedule       SyncPlanSchedule `json:"schedule"`
	Enabled        bool             `json:"enabled"`
	FirstScope     string           `json:"firstScope"`
	MediaKinds     []string         `json:"mediaKinds"`
	IncludeHistory bool             `json:"includeHistory"`
	Targets        []SyncPlanTarget `json:"targets"`
	CreatedAt      int64            `json:"createdAt"`
	NextRunAt      time.Time        `json:"nextRunAt,omitzero"`
	State          string           `json:"state"`
	BlockedReason  string           `json:"blockedReason,omitempty"`
	Message        string           `json:"message,omitempty"`
	ActiveRunID    string           `json:"activeRunId,omitempty"`
}

type SyncPlanBinding struct {
	LibraryID, LibraryLabel, AccountID, Namespace string
	Targets                                       []SyncPlanTarget
}

// Checkpoints belong to a target and remain private to the scheduler and
// executor. A work ID continues across interrupted runs and explicit retries.
type SyncPlanCheckpoint struct {
	Cursor, Offset, Through, AddedMessages, AddedMedia, Missing int
	Stage, TaskID, WorkID                                       string
	PendingMedia                                                []string
}

type SyncPlanTargetResult struct {
	Cursor, AddedMessages, AddedMedia, Missing int
	TaskID, Slug                               string
	PendingMedia                               []string
}

type SyncPlanHooks struct {
	CurrentLibraryID func() string
	Bind             func(context.Context, []SyncPlanTargetInput) (SyncPlanBinding, error)
	Check            func(context.Context, SyncPlan) error
	Execute          func(context.Context, SyncPlan, SyncPlanTarget, SyncPlanCheckpoint, func(SyncPlanCheckpoint) error) (SyncPlanTargetResult, error)
	GetLaunchOnLogin func() (bool, error)
	SetLaunchOnLogin func(bool) error
	DiscardWork      func(SyncPlan, SyncPlanTarget, SyncPlanCheckpoint)
}

type SyncPlanRunTarget struct {
	Peer          string    `json:"peer"`
	Name          string    `json:"name"`
	Slug          string    `json:"slug,omitempty"`
	State         string    `json:"state"`
	Cursor        int       `json:"cursor"`
	LastSuccessAt time.Time `json:"lastSuccessAt,omitzero"`
	AddedMessages int       `json:"addedMessages"`
	AddedMedia    int       `json:"addedMedia"`
	Missing       int       `json:"missing"`
	TaskID        string    `json:"taskId,omitempty"`
	BlockedReason string    `json:"blockedReason,omitempty"`
	Message       string    `json:"message,omitempty"`
}

type SyncPlanRun struct {
	ID            string              `json:"id"`
	PlanID        string              `json:"planId"`
	PlanName      string              `json:"planName"`
	Trigger       string              `json:"trigger"`
	State         string              `json:"state"`
	ScheduledAt   time.Time           `json:"scheduledAt,omitzero"`
	StartedAt     time.Time           `json:"startedAt,omitzero"`
	FinishedAt    time.Time           `json:"finishedAt,omitzero"`
	RetryAt       time.Time           `json:"retryAt,omitzero"`
	BlockedReason string              `json:"blockedReason,omitempty"`
	Message       string              `json:"message,omitempty"`
	Targets       []SyncPlanRunTarget `json:"targets"`
}

type SyncPlanSnapshot struct {
	Plans              []SyncPlan    `json:"plans"`
	Runs               []SyncPlanRun `json:"runs"`
	CurrentLibraryID   string        `json:"currentLibraryId,omitempty"`
	LaunchOnLogin      bool          `json:"launchOnLogin"`
	LaunchOnLoginError string        `json:"launchOnLoginError,omitempty"`
	Error              string        `json:"error,omitempty"`
}

type syncPlanRecord struct {
	SyncPlan
	EligibleAt time.Time
	LastSlot   string
	Revision   uint64
	Edit       uint64
	Work       map[string]SyncPlanCheckpoint
}

type syncRunRecord struct {
	SyncPlanRun
	Revision      uint64
	RetryCount    int
	LastBlockedAt time.Time
}

type syncPlanDiskState struct {
	Version   int
	Sequence  uint64
	Plans     []syncPlanRecord
	Runs      []syncRunRecord
	Cooldowns map[string]time.Time
}

type syncPlanDraft struct {
	ID             string                `json:"id"`
	Name           string                `json:"name"`
	Schedule       SyncPlanSchedule      `json:"schedule"`
	Enabled        bool                  `json:"enabled"`
	FirstScope     string                `json:"firstScope"`
	MediaKinds     []string              `json:"mediaKinds"`
	IncludeHistory bool                  `json:"includeHistory"`
	Targets        []SyncPlanTargetInput `json:"targets"`
}

type syncPlanActive struct {
	id     string
	cancel context.CancelFunc
}

type SyncPlanService struct {
	hooks SyncPlanHooks
	path  string
	now   func() time.Time
	write func(string, []byte, os.FileMode) error

	mu         sync.Mutex
	state      syncPlanDiskState
	deferred   *syncPlanDiskState
	active     *syncPlanActive
	wakeAt     time.Time
	persistErr error
	closing    bool
	signal     chan struct{}
	done       chan struct{}
	startOnce  sync.Once
}

func NewSyncPlanService(configDir string, hooks SyncPlanHooks) (*SyncPlanService, error) {
	path := filepath.Join(configDir, "sync-plans.json")
	state := syncPlanDiskState{Version: syncPlanStateVersion}
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err = json.Unmarshal(raw, &state); err != nil {
			return nil, fmt.Errorf("无法读取同步计划：%w", err)
		}
		if state.Version != syncPlanStateVersion {
			return nil, fmt.Errorf("不支持的同步计划版本 %d", state.Version)
		}
		for _, p := range state.Plans {
			if _, err := p.Schedule.clock(); err != nil {
				return nil, err
			}
			if err := validateSyncPlanSlot(p.LastSlot); err != nil {
				return nil, err
			}
		}
	case !errors.Is(err, os.ErrNotExist):
		return nil, fmt.Errorf("无法读取同步计划：%w", err)
	}
	service := &SyncPlanService{
		hooks: hooks, path: path, state: state, now: time.Now, write: platform.AtomicWriteFile,
		signal: make(chan struct{}, 1), done: make(chan struct{}),
	}
	if err := service.recoverInterrupted(); err != nil {
		return nil, err
	}
	return service, nil
}

func syncPending(state string) bool {
	switch state {
	case "queued", "running", "retrying", "blocked", "stopping":
		return true
	default:
		return false
	}
}

func (s *syncPlanDiskState) planIndex(id string) int {
	return slices.IndexFunc(s.Plans, func(p syncPlanRecord) bool { return p.ID == id })
}

func (s *syncPlanDiskState) runIndex(id string) int {
	return slices.IndexFunc(s.Runs, func(r syncRunRecord) bool { return r.ID == id })
}

func (s *syncPlanDiskState) pendingIndex(id string) int {
	return slices.IndexFunc(s.Runs, func(r syncRunRecord) bool { return r.PlanID == id && syncPending(r.State) })
}

func (s *syncPlanDiskState) newestRunIndex(id string) int {
	for i := len(s.Runs) - 1; i >= 0; i-- {
		if s.Runs[i].PlanID == id {
			return i
		}
	}
	return -1
}

func (s *syncPlanDiskState) nextID(prefix string) string {
	s.Sequence++
	return prefix + strconv.FormatUint(s.Sequence, 36)
}

func (s *syncPlanDiskState) trimRuns() {
	if len(s.Runs) <= syncPlanHistorySize {
		return
	}
	runs := make([]syncRunRecord, 0, len(s.Runs))
	finished := 0
	for i := len(s.Runs) - 1; i >= 0; i-- {
		run := s.Runs[i]
		if !syncPending(run.State) {
			finished++
			if finished > syncPlanHistorySize {
				continue
			}
		}
		runs = append(runs, run)
	}
	slices.Reverse(runs)
	s.Runs = runs
}

func cloneSyncCheckpoint(c SyncPlanCheckpoint) SyncPlanCheckpoint {
	c.PendingMedia = slices.Clone(c.PendingMedia)
	return c
}

func cloneSyncPlan(p SyncPlan) SyncPlan {
	p.Schedule.Weekdays = slices.Clone(p.Schedule.Weekdays)
	p.MediaKinds = slices.Clone(p.MediaKinds)
	p.Targets = slices.Clone(p.Targets)
	return p
}

func (s syncPlanDiskState) clone() syncPlanDiskState {
	s.Plans = slices.Clone(s.Plans)
	for i := range s.Plans {
		p := &s.Plans[i]
		p.SyncPlan = cloneSyncPlan(p.SyncPlan)
		p.Work = maps.Clone(p.Work)
	}
	s.Runs = slices.Clone(s.Runs)
	for i := range s.Runs {
		s.Runs[i].Targets = slices.Clone(s.Runs[i].Targets)
	}
	s.Cooldowns = maps.Clone(s.Cooldowns)
	return s
}

func (s *SyncPlanService) commitLocked(state syncPlanDiskState) error {
	state.trimRuns()
	raw, err := json.Marshal(state)
	if err == nil {
		err = os.MkdirAll(filepath.Dir(s.path), 0700)
	}
	if err == nil {
		err = s.write(s.path, raw, 0600)
	}
	if err != nil {
		if s.persistErr == nil {
			log.Printf("sync plans: %v", err)
		}
		s.persistErr = fmt.Errorf("无法保存同步计划：%w", err)
		return s.persistErr
	}
	s.state = state
	s.persistErr = nil
	return nil
}

func (s *SyncPlanService) recoverInterrupted() error {
	state := s.state.clone()
	changed := false
	now := s.now()
	for i := range state.Runs {
		run := &state.Runs[i]
		switch run.State {
		case "running":
			run.State, run.Message = "queued", "上次执行中断，等待从断点恢复"
			for j := range run.Targets {
				if run.Targets[j].State == "running" {
					run.Targets[j].State = "queued"
				}
			}
		case "stopping":
			finishSyncRun(run, "stopped", "执行已停止", now)
		default:
			continue
		}
		changed = true
	}
	if changed {
		return s.commitLocked(state)
	}
	return nil
}

func (s *SyncPlanService) notify() {
	select {
	case s.signal <- struct{}{}:
	default:
	}
}

func (s *SyncPlanService) Wake() {
	s.mu.Lock()
	s.wakeAt = s.now()
	s.mu.Unlock()
	s.notify()
}

func (s *SyncPlanService) Busy() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active != nil
}

func (s *SyncPlanService) Start() {
	s.startOnce.Do(func() { go s.loop() })
}

func (s *SyncPlanService) Close(ctx context.Context) error {
	s.mu.Lock()
	s.closing = true
	if s.active != nil {
		s.active.cancel()
	}
	s.mu.Unlock()
	s.Start()
	s.notify()
	select {
	case <-s.done:
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.flushLocked()
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *SyncPlanService) flushLocked() error {
	if s.deferred == nil {
		return nil
	}
	if err := s.commitLocked(*s.deferred); err != nil {
		return err
	}
	s.deferred = nil
	return nil
}
