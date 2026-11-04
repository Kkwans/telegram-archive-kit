package app

import (
	"context"
	"time"
)

// Reporter is the only UI boundary the download/build engine needs. The TUI
// implements it with runOperation + frame rendering; the desktop client
// implements it with JSON events. Business code never touches a screen.
type Reporter interface {
	// Check runs one coarse stage (verify/scan) with an optional progress sink.
	Check(ctx context.Context, title, subtitle, initial string, fn func(context.Context, func(OperationProgress)) error) error
	// BeginDownload returns the context and renderer used by the download loop.
	// Callers must invoke done() when the loop returns.
	BeginDownload(ctx context.Context, meta downloadMeta) (context.Context, downloadUI, func())
	// Phase reports non-download stages (preflight/build/verify) to the UI.
	Phase(ctx context.Context, phase, stage, detail string)
}

type downloadMeta struct {
	OpID    string
	Slug    string
	Chat    string
	Pass    int
	PassMax int
}

type downloadUI interface {
	Render(DownloadSnapshot)
}

// TaskProgress is one file download, in numbers rather than preformatted text.
type TaskProgress struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Kind        string  `json:"kind"`
	Percent     float64 `json:"percent"` // -1 when unknown
	Transferred int64   `json:"transferred"`
	Expected    int64   `json:"expected"`
	Speed       float64 `json:"speed"` // bytes/s
	ETAMs       int64   `json:"etaMs"`
	ElapsedMs   int64   `json:"elapsedMs"`
	Done        bool    `json:"done"`
	Stalled     bool    `json:"stalled"`
}

// DownloadSnapshot is the complete state of one download dashboard frame.
// Exported fields are the wire format; the unexported tail carries the exact
// taskView slices the TUI already renders, so the console output stays
// byte-identical after the refactor.
type DownloadSnapshot struct {
	OpID       string  `json:"opId"`
	Slug       string  `json:"slug"`
	Chat       string  `json:"chat"`
	Pass       int     `json:"pass"`
	PassMax    int     `json:"passMax"`
	Phase      string  `json:"phase"`
	State      string  `json:"state"`
	Detail     string  `json:"detail"`
	Done       int     `json:"done"`
	Total      int     `json:"total"`
	Percent    float64 `json:"percent"`
	Bytes      int64   `json:"bytes"`
	KnownBytes int64   `json:"knownBytes"`
	KnownCount int     `json:"knownCount"`

	SpeedNow     float64 `json:"speedNow"`
	SpeedAvg     float64 `json:"speedAvg"`
	SpeedAvgWall float64 `json:"speedAvgWall"`
	SpeedPeak    float64 `json:"speedPeak"`
	ETAMs        int64   `json:"etaMs"`
	ETASource    string  `json:"etaSource"`
	ElapsedMs    int64   `json:"elapsedMs"`
	RetryInMs    int64   `json:"retryInMs"`

	NetworkAttempt     int   `json:"networkAttempt"`
	NetworkAttemptMax  int   `json:"networkAttemptMax"`
	RestartsUsed       int   `json:"restartsUsed"`
	Deferred           int   `json:"deferred"`
	StalledFileRetries int   `json:"stalledFileRetries"`
	StallAfterMs       int64 `json:"stallAfterMs"`

	Concurrent     int `json:"concurrent"`
	Threads        int `json:"threads"`
	BaseConcurrent int `json:"baseConcurrent"`
	BaseThreads    int `json:"baseThreads"`

	Active    []TaskProgress `json:"active"`
	Completed []TaskProgress `json:"completed"`
	Recent    []string       `json:"recent"`
	LogPath   string         `json:"logPath,omitempty"`
	UpdatedAt int64          `json:"updatedAt"`

	// TUI-only inputs (never serialized).
	plan          downloadPlan
	activeViews   []taskView
	finishedViews []taskView
	full          bool
}

func newDownloadSnapshot(chat string, pass int, plan downloadPlan, done int, bytes int64,
	speed float64, elapsed time.Duration, recent []string, state, detail string,
	retryIn time.Duration, concurrent, threads int) DownloadSnapshot {
	s := newDownloadSnapshotFull(chat, pass, plan, done, bytes, speed, elapsed, state, detail,
		retryIn, concurrent, threads, nil, nil, nil, nil)
	s.Recent = recent
	return s
}

func newDownloadSnapshotFull(chat string, pass int, plan downloadPlan, done int, bytes int64,
	speed float64, elapsed time.Duration, state, detail string, retryIn time.Duration,
	concurrent, threads int, activeViews, finishedViews []taskView,
	active, completed []TaskProgress) DownloadSnapshot {
	pct := 0.0
	if plan.Total > 0 {
		pct = float64(done) * 100 / float64(plan.Total)
	}
	eta := estimateOverallETA(plan, done, bytes, speed, elapsed)
	source := "cadence"
	if plan.KnownBytes > 0 && plan.KnownCount > 0 {
		source = "bytes"
	}
	if eta <= 0 {
		source = ""
	}
	return DownloadSnapshot{
		Chat: chat, Pass: pass, State: state, Detail: detail,
		Done: done, Total: plan.Total, Percent: pct, Bytes: bytes,
		KnownBytes: plan.KnownBytes, KnownCount: plan.KnownCount,
		SpeedNow: speed, ETAMs: eta.Milliseconds(), ETASource: source,
		ElapsedMs: elapsed.Milliseconds(), RetryInMs: retryIn.Milliseconds(),
		Concurrent: concurrent, Threads: threads,
		Active: active, Completed: completed,
		plan: plan, activeViews: activeViews, finishedViews: finishedViews, full: true,
	}
}
