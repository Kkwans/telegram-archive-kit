package app

import (
	"context"
	"sync"
	"time"
)

// tuiReporter keeps the console client on its existing rendering path.
type tuiReporter struct{ a *App }

func (r *tuiReporter) Check(ctx context.Context, title, subtitle, initial string,
	fn func(context.Context, func(OperationProgress)) error) error {
	return runOperation(title, subtitle, initial, fn)
}

func (r *tuiReporter) BeginDownload(parent context.Context, meta downloadMeta) (context.Context, downloadUI, func()) {
	ctx, cancel := context.WithCancel(parent)
	stop := make(chan struct{})
	var once sync.Once
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			if k, ok := pollKey(70 * time.Millisecond); ok && k.Code == keyEsc {
				cancel()
				return
			}
		}
	}()
	done := func() {
		once.Do(func() {
			close(stop)
			cancel()
		})
	}
	return ctx, &tuiDownloadUI{a: r.a}, done
}

func (r *tuiReporter) Phase(ctx context.Context, phase, stage, detail string) {}

type tuiDownloadUI struct{ a *App }

func (u *tuiDownloadUI) Render(s DownloadSnapshot) {
	if u.a == nil {
		return
	}
	if s.full {
		u.a.renderDownloadDashboardDetailed(s.Chat, s.Pass, s.plan, s.Done, s.Bytes, s.SpeedNow,
			time.Duration(s.ElapsedMs)*time.Millisecond, s.State, s.Detail,
			time.Duration(s.RetryInMs)*time.Millisecond, s.Concurrent, s.Threads,
			s.activeViews, s.finishedViews)
		return
	}
	u.a.renderDownloadDashboardState(s.Chat, s.Pass, s.plan, s.Done, s.Bytes, s.SpeedNow,
		time.Duration(s.ElapsedMs)*time.Millisecond, s.Recent, s.State, s.Detail,
		time.Duration(s.RetryInMs)*time.Millisecond, s.Concurrent, s.Threads)
}

// eventReporter turns engine progress into JSON events for the desktop client.
// Average speed deliberately starts from the first reported byte count: the
// archived byte total includes files downloaded in earlier sessions, so using
// it directly would report a fictional average.
type eventReporter struct {
	opID string
	emit func(string, any)

	mu        sync.Mutex
	baseBytes int64
	baseSet   bool
	baseTime  time.Time
	active    time.Duration
	lastTick  time.Time
	lastSent  time.Time
	lastState string
	peak      float64
}

func (r *eventReporter) Check(ctx context.Context, title, subtitle, initial string,
	fn func(context.Context, func(OperationProgress)) error) error {
	started := time.Now()
	r.emit("tak:operation", OperationDTO{OpID: r.opID, Phase: "check", Stage: title, Detail: initial})
	return fn(ctx, func(p OperationProgress) {
		r.emit("tak:operation", OperationDTO{
			OpID: r.opID, Phase: "check", Stage: p.Stage, Detail: p.Detail,
			Current: p.Current, Total: p.Total, Unit: p.Unit,
			ElapsedMs: time.Since(started).Milliseconds(),
		})
	})
}

func (r *eventReporter) BeginDownload(parent context.Context, meta downloadMeta) (context.Context, downloadUI, func()) {
	ctx, cancel := context.WithCancel(parent)
	r.mu.Lock()
	r.baseSet = false
	r.baseBytes = 0
	r.active = 0
	r.lastTick = time.Time{}
	r.peak = 0
	r.mu.Unlock()
	return ctx, r, cancel
}

func (r *eventReporter) Phase(ctx context.Context, phase, stage, detail string) {
	r.emit("tak:operation", OperationDTO{OpID: r.opID, Phase: phase, Stage: stage, Detail: detail})
}

func (r *eventReporter) Render(s DownloadSnapshot) {
	now := time.Now()
	r.mu.Lock()
	if !r.baseSet {
		r.baseSet = true
		r.baseBytes = s.Bytes
		r.baseTime = now
		r.lastTick = now
	}
	downloading := s.State == "正在下载" || s.State == "已完成"
	if downloading && !r.lastTick.IsZero() {
		r.active += now.Sub(r.lastTick)
	}
	r.lastTick = now
	if s.SpeedNow > r.peak {
		r.peak = s.SpeedNow
	}
	s.OpID = r.opID
	s.SpeedPeak = r.peak
	if r.active >= time.Second && s.Bytes >= r.baseBytes {
		s.SpeedAvg = float64(s.Bytes-r.baseBytes) / r.active.Seconds()
		if wall := now.Sub(r.baseTime).Seconds(); wall >= 1 {
			s.SpeedAvgWall = float64(s.Bytes-r.baseBytes) / wall
		}
	}
	s.UpdatedAt = now.UnixMilli()
	stateChanged := s.State != r.lastState
	r.lastState = s.State
	throttled := now.Sub(r.lastSent) < 220*time.Millisecond && !stateChanged
	if !throttled {
		r.lastSent = now
	}
	r.mu.Unlock()

	if throttled {
		return
	}
	r.emit("tak:download", s)
}
