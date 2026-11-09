package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"telegramarchivekit/internal/archive"
)

// TaskDTO is one background operation shown in the desktop task center.
type TaskDTO struct {
	ID                  string  `json:"id"`
	Kind                string  `json:"kind"`
	Title               string  `json:"title"`
	Chat                string  `json:"chat,omitempty"`
	ChatID              string  `json:"chatId,omitempty"`
	Slug                string  `json:"slug,omitempty"`
	Mode                string  `json:"mode,omitempty"`
	Source              string  `json:"source,omitempty"`
	Target              string  `json:"target,omitempty"`
	Messages            int     `json:"messages,omitempty"`
	Media               int     `json:"media,omitempty"`
	Images              int     `json:"images,omitempty"`
	Videos              int     `json:"videos,omitempty"`
	Audio               int     `json:"audio,omitempty"`
	Files               int     `json:"files,omitempty"`
	DoneImages          int     `json:"doneImages,omitempty"`
	DoneVideos          int     `json:"doneVideos,omitempty"`
	DoneAudio           int     `json:"doneAudio,omitempty"`
	DoneFiles           int     `json:"doneFiles,omitempty"`
	DoneStats           bool    `json:"doneStats,omitempty"`
	PlanKnown           bool    `json:"planKnown,omitempty"`
	BaselineTotal       int     `json:"baselineTotal,omitempty"`
	BaselineBytes       int64   `json:"baselineBytes,omitempty"`
	BaselineImages      int     `json:"baselineImages,omitempty"`
	BaselineVideos      int     `json:"baselineVideos,omitempty"`
	BaselineAudio       int     `json:"baselineAudio,omitempty"`
	BaselineFiles       int     `json:"baselineFiles,omitempty"`
	FilesDone           int     `json:"filesDone,omitempty"`
	FilesTotal          int     `json:"filesTotal,omitempty"`
	Detail              string  `json:"detail,omitempty"`
	State               string  `json:"state"` // running|done|failed
	Percent             int     `json:"percent"`
	AvgSpeed            float64 `json:"avgSpeed,omitempty"`
	PeakSpeed           float64 `json:"peakSpeed,omitempty"`
	Bytes               int64   `json:"bytes,omitempty"`
	TotalBytes          int64   `json:"totalBytes,omitempty"`
	TotalBytesEstimated bool    `json:"totalBytesEstimated,omitempty"`
	Done                int     `json:"done,omitempty"`
	Total               int     `json:"total,omitempty"`
	ETAMs               int64   `json:"etaMs,omitempty"`
	ElapsedMs           int64   `json:"elapsedMs,omitempty"`
	Concurrent          int     `json:"concurrent,omitempty"`
	Threads             int     `json:"threads,omitempty"`
	StartedAt           int64   `json:"startedAt"`
	FinishedAt          int64   `json:"finishedAt,omitempty"`
	Error               string  `json:"error,omitempty"`
	RecordsComplete     bool    `json:"recordsComplete,omitempty"`
}

// SpeedPoint is one persisted sample of a download task's speed curve.
type SpeedPoint struct {
	At  int64   `json:"at"`
	Now float64 `json:"now"`
	Avg float64 `json:"avg"`
}

// TaskDetailDTO adds the full speed series; it is only fetched on demand so
// the 600ms state poll stays small.
type TaskDetailDTO struct {
	TaskDTO
	Series    []SpeedPoint   `json:"series,omitempty"`
	Active    []TaskProgress `json:"active,omitempty"`
	Completed []TaskProgress `json:"completed,omitempty"`
}

type backgroundTask struct {
	mu           sync.Mutex
	dto          TaskDTO
	series       []SpeedPoint
	active       []TaskProgress
	completed    []TaskProgress
	lastPass     int
	lastSampleAt time.Time
	activeBaseMs int64
	activeSince  time.Time
	ctx          context.Context
	cancel       context.CancelFunc
}

// context returns the cancellation context owned by this task. Persisted tasks
// loaded from disk are not running, so they fall back to a background context.
func (t *backgroundTask) context() context.Context {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.ctx == nil {
		return context.Background()
	}
	return t.ctx
}

func (t *backgroundTask) setChat(chat string) {
	t.mu.Lock()
	t.dto.Chat = chat
	t.mu.Unlock()
}

func (t *backgroundTask) setTitle(title string) {
	t.mu.Lock()
	if title != "" {
		t.dto.Title = title
	}
	t.mu.Unlock()
}

func (t *backgroundTask) setSlug(slug string) {
	t.mu.Lock()
	t.dto.Slug = slug
	t.mu.Unlock()
}

// setInfo fills the type-specific detail fields. Only non-zero values replace
// existing data so callers can update one aspect at a time.
func (t *backgroundTask) setInfo(chatID, mode, source, target string, messages, media int) {
	t.mu.Lock()
	if chatID != "" {
		t.dto.ChatID = chatID
	}
	if mode != "" {
		t.dto.Mode = mode
	}
	if source != "" {
		t.dto.Source = source
	}
	if target != "" {
		t.dto.Target = target
	}
	if messages > 0 {
		t.dto.Messages = messages
	}
	if media > 0 {
		t.dto.Media = media
	}
	t.mu.Unlock()
}

func (t *backgroundTask) setStats(messages, media int) {
	t.mu.Lock()
	if messages > 0 {
		t.dto.Messages = messages
	}
	if media > 0 {
		t.dto.Media = media
	}
	t.mu.Unlock()
}

func (t *backgroundTask) setMediaStats(images, videos, audio, files int) {
	t.mu.Lock()
	if images > 0 {
		t.dto.Images = images
	}
	if videos > 0 {
		t.dto.Videos = videos
	}
	if audio > 0 {
		t.dto.Audio = audio
	}
	if files > 0 {
		t.dto.Files = files
	}
	t.mu.Unlock()
}

func (t *backgroundTask) setTotalBytes(total int64) {
	t.mu.Lock()
	if total > 0 {
		t.dto.TotalBytes = total
	}
	t.mu.Unlock()
}

func (t *backgroundTask) setDownloadComposition(images, videos, audio, files int) {
	t.mu.Lock()
	t.dto.Images = images
	t.dto.Videos = videos
	t.dto.Audio = audio
	t.dto.Files = files
	t.dto.PlanKnown = true
	t.mu.Unlock()
}

func (t *backgroundTask) setDownloadBaseline(total int, bytes int64, images, videos, audio, files int) {
	t.mu.Lock()
	t.dto.BaselineTotal = total
	t.dto.BaselineBytes = bytes
	t.dto.BaselineImages = images
	t.dto.BaselineVideos = videos
	t.dto.BaselineAudio = audio
	t.dto.BaselineFiles = files
	t.mu.Unlock()
}

func (t *backgroundTask) setDoneMediaStats(images, videos, audio, files int) {
	t.mu.Lock()
	t.dto.DoneImages = images
	t.dto.DoneVideos = videos
	t.dto.DoneAudio = audio
	t.dto.DoneFiles = files
	t.dto.DoneStats = true
	t.mu.Unlock()
}

// copyStats advances byte/file counters for copy-style tasks without
// clobbering the generic download fields used by sync tasks.
func (t *backgroundTask) copyStats(doneBytes, totalBytes int64, filesDone, filesTotal, percent int, detail string) {
	t.mu.Lock()
	if totalBytes > 0 {
		t.dto.TotalBytes = totalBytes
	}
	t.dto.Bytes = doneBytes
	if filesTotal > 0 {
		t.dto.FilesDone = filesDone
		t.dto.FilesTotal = filesTotal
	}
	if percent >= 0 {
		if percent > 100 {
			percent = 100
		}
		t.dto.Percent = percent
	}
	if detail != "" {
		t.dto.Detail = detail
	}
	t.mu.Unlock()
}

func (t *backgroundTask) fileProgress(done, total int) {
	t.mu.Lock()
	if total > 0 {
		t.dto.FilesDone = done
		t.dto.FilesTotal = total
	}
	t.mu.Unlock()
}

func (t *backgroundTask) update(percent int, detail string) {
	t.mu.Lock()
	if percent >= 0 {
		if percent > 100 {
			percent = 100
		}
		t.dto.Percent = percent
	}
	if detail != "" {
		t.dto.Detail = detail
	}
	t.mu.Unlock()
}

// updateDownload stores summary stats and samples the curve at most every
// 1.5 seconds, keeping the persisted history compact.
func (t *backgroundTask) updateDownload(s DownloadSnapshot) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if s.Percent >= 0 {
		t.dto.Percent = int(s.Percent + 0.5)
		if t.dto.Percent > 100 {
			t.dto.Percent = 100
		}
	}
	if s.State != "" {
		t.dto.Detail = s.State
		if s.Total > 0 {
			t.dto.Detail = fmt.Sprintf("%s · %d/%d 个媒体", s.State, s.Done, s.Total)
		}
	}
	t.dto.AvgSpeed = s.SpeedAvg
	if s.SpeedPeak > t.dto.PeakSpeed {
		t.dto.PeakSpeed = s.SpeedPeak
	}
	if s.SpeedNow > t.dto.PeakSpeed {
		t.dto.PeakSpeed = s.SpeedNow
	}
	t.dto.RecordsComplete = true
	t.dto.Bytes = s.Bytes
	t.dto.TotalBytes = s.TotalBytes
	t.dto.TotalBytesEstimated = s.TotalBytesEstimated
	t.dto.Done = s.Done
	t.dto.Total = s.Total
	t.dto.ETAMs = s.ETAMs
	t.dto.Concurrent = s.Concurrent
	t.dto.Threads = s.Threads
	t.active = append([]TaskProgress(nil), s.Active...)
	if t.lastPass == 0 || s.Pass == t.lastPass {
		t.completed = append([]TaskProgress(nil), s.Completed...)
	} else {
		t.completed = mergeTaskProgress(s.Completed, t.completed)
	}
	if s.Pass > 0 {
		t.lastPass = s.Pass
	}
	if !t.activeSince.IsZero() {
		t.dto.ElapsedMs = t.activeBaseMs + time.Since(t.activeSince).Milliseconds()
	} else if t.dto.ElapsedMs <= 0 && s.ElapsedMs > 0 {
		t.dto.ElapsedMs = s.ElapsedMs
	}
	now := time.Now()
	if len(t.series) == 0 || now.Sub(t.lastSampleAt) >= 1500*time.Millisecond {
		t.lastSampleAt = now
		t.series = append(t.series, SpeedPoint{At: now.UnixMilli(), Now: s.SpeedNow, Avg: s.SpeedAvg})
		if len(t.series) > 360 {
			t.series = t.series[len(t.series)-360:]
		}
	}
}

func (t *backgroundTask) snapshot() TaskDTO {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.dto
}

func (t *backgroundTask) detail() TaskDetailDTO {
	t.mu.Lock()
	defer t.mu.Unlock()
	return TaskDetailDTO{
		TaskDTO:   t.dto,
		Series:    append([]SpeedPoint{}, t.series...),
		Active:    append([]TaskProgress{}, t.active...),
		Completed: append([]TaskProgress{}, t.completed...),
	}
}

func (t *backgroundTask) finish(err error) {
	t.mu.Lock()
	if t.dto.State != "running" {
		t.mu.Unlock()
		return
	}
	t.closeRunning()
	if err != nil {
		t.dto.State = "failed"
		t.dto.Error = err.Error()
	} else {
		t.dto.State = "done"
		t.dto.Percent = 100
	}
	cancel := t.cancel
	t.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (t *backgroundTask) pause() {
	t.mu.Lock()
	if t.dto.State != "running" {
		t.mu.Unlock()
		return
	}
	t.closeRunning()
	t.dto.State = "paused"
	t.dto.Detail = "任务已暂停，可继续下载"
	t.dto.Error = "任务已暂停，可继续下载"
	cancel := t.cancel
	t.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (t *backgroundTask) stop() {
	t.mu.Lock()
	if t.dto.State != "running" && t.dto.State != "paused" && t.dto.State != "partial" {
		t.mu.Unlock()
		return
	}
	t.closeRunning()
	t.dto.State = "stopped"
	t.dto.Error = "任务已终止，进度已保留"
	cancel := t.cancel
	t.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (t *backgroundTask) partial(err error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.dto.State != "running" {
		return
	}
	t.closeRunning()
	t.dto.State = "partial"
	if err != nil {
		t.dto.Error = err.Error()
	}
}

func (t *backgroundTask) closeRunning() {
	now := time.Now()
	if !t.activeSince.IsZero() {
		t.activeBaseMs += now.Sub(t.activeSince).Milliseconds()
		t.activeSince = time.Time{}
	} else if t.activeBaseMs <= 0 && t.dto.ElapsedMs > 0 {
		t.activeBaseMs = t.dto.ElapsedMs
	}
	t.dto.FinishedAt = now.UnixMilli()
	t.dto.ETAMs = 0
	t.active = nil
	t.dto.ElapsedMs = t.activeBaseMs
}

// resume reuses one logical task after a pause or a recoverable failure. The
// accumulated elapsed time contains active download time only.
func (t *backgroundTask) resume() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch t.dto.State {
	case "paused", "failed", "partial":
	default:
		return false
	}
	if t.activeBaseMs <= 0 && t.dto.ElapsedMs > 0 {
		t.activeBaseMs = t.dto.ElapsedMs
	}
	t.dto.State = "running"
	t.dto.Error = ""
	t.dto.FinishedAt = 0
	t.dto.ETAMs = 0
	t.active = nil
	if t.activeSince.IsZero() {
		t.activeSince = time.Now()
	}
	return true
}

// mergeTaskProgress prepends records from a newer repair pass while keeping
// earlier completions, so the task detail can show the whole run. Both inputs
// use newest-first order.
func mergeTaskProgress(newer, older []TaskProgress) []TaskProgress {
	key := func(p TaskProgress) string {
		if p.ID != "" {
			return p.ID + "\x00" + p.Name
		}
		return p.Name
	}
	seen := make(map[string]bool, len(older))
	for _, p := range older {
		seen[key(p)] = true
	}
	out := make([]TaskProgress, 0, len(newer)+len(older))
	for _, p := range newer {
		k := key(p)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, p)
	}
	return append(out, older...)
}

// createTask registers a running task without starting a goroutine. One-click
// sync uses it so downloads show up in the same persisted history as imports
// and exports.
func (f *Facade) createTask(kind, title, chat string) *backgroundTask {
	f.taskMu.Lock()
	f.taskSeq++
	id := fmt.Sprintf("task-%d-%d", time.Now().UnixNano(), f.taskSeq)
	ctx, cancel := context.WithCancel(context.Background())
	task := &backgroundTask{
		dto: TaskDTO{
			ID: id, Kind: kind, Title: title, Chat: chat, State: "running",
			StartedAt: time.Now().UnixMilli(),
		},
		activeSince: time.Now(),
		ctx:         ctx,
		cancel:      cancel,
	}
	f.tasks = append([]*backgroundTask{task}, f.tasks...)
	if len(f.tasks) > 50 {
		f.tasks = f.tasks[:50]
	}
	f.taskMu.Unlock()
	f.saveTasks()
	return task
}

func (f *Facade) pausedTaskForSlug(slug string) *backgroundTask {
	if slug == "" {
		return nil
	}
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	for _, task := range f.tasks {
		dto := task.snapshot()
		if dto.State == "paused" && dto.Kind == "sync" && dto.Slug == slug {
			return task
		}
	}
	return nil
}

func (f *Facade) startTask(kind, title string, fn func(t *backgroundTask) error) string {
	task := f.createTask(kind, title, "")
	go func() {
		defer func() {
			if r := recover(); r != nil {
				task.finish(fmt.Errorf("任务异常：%v", r))
				f.saveTasks()
			}
		}()
		task.finish(fn(task))
		f.saveTasks()
	}()
	return task.snapshot().ID
}

func (f *Facade) Tasks() []TaskDTO {
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	out := make([]TaskDTO, 0, len(f.tasks))
	for _, t := range f.tasks {
		d := t.snapshot()
		applyBaselineToTask(&d)
		out = append(out, d)
	}
	return out
}

// applyBaselineToTask turns engine progress (which includes media that existed
// before the task) into this task's increment.
func applyBaselineToTask(d *TaskDTO) {
	if d == nil || d.BaselineTotal <= 0 || d.Total <= d.BaselineTotal {
		return
	}
	d.Done = max(0, d.Done-d.BaselineTotal)
	d.Total -= d.BaselineTotal
	d.Bytes = max(0, d.Bytes-d.BaselineBytes)
	d.TotalBytes = max(0, d.TotalBytes-d.BaselineBytes)
	if d.Total > 0 {
		d.Percent = int(float64(d.Done)*100/float64(d.Total) + 0.5)
	}
}

func (f *Facade) taskDetails() []TaskDetailDTO {
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	out := make([]TaskDetailDTO, 0, len(f.tasks))
	for _, t := range f.tasks {
		out = append(out, t.detail())
	}
	return out
}

// sourceMediaComposition counts every media message in result.json by type.
// It is the task plan for a legacy download that started from an empty TAK
// media directory, and is scaled down when the task plan was smaller.
func (f *Facade) sourceMediaComposition(slug string) [4]int {
	var out [4]int
	b, err := os.ReadFile(f.a.sourcePath(slug))
	if err != nil {
		return out
	}
	var root struct {
		Messages []map[string]any `json:"messages"`
	}
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.UseNumber()
	if dec.Decode(&root) != nil {
		return out
	}
	for _, m := range root.Messages {
		mt := strings.ToLower(archive.AnyString(m["media_type"]))
		if mt == "" {
			continue
		}
		switch mt {
		case "photo":
			out[0]++
		case "video_file", "video_message", "animation":
			out[1]++
		case "voice_message", "audio_file":
			out[2]++
		default:
			out[3]++
		}
	}
	return out
}

// workspacePresentComposition counts media the archive can currently serve:
// inherited official exports plus files actually present in media/ and files/.
func (f *Facade) workspacePresentComposition(slug string) [4]int {
	var out [4]int
	if meta, err := f.a.readWorkspaceMeta(slug); err == nil {
		for _, ex := range meta.OfficialExports {
			out[0] += ex.Images
			out[1] += ex.Videos
			out[2] += ex.Audio
			out[3] += ex.Files
		}
	}
	for _, dir := range []string{f.a.mediaDir(slug), f.a.filesDir(slug)} {
		_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			name := d.Name()
			if strings.HasSuffix(strings.ToLower(name), ".tak-part") || archive.IsThumbnailFile(path) || archive.IsThumbnailFile(name) {
				return nil
			}
			if info, er := d.Info(); er != nil || info.Size() <= 0 {
				return nil
			}
			switch archive.MediaKind(name) {
			case "image":
				out[0]++
			case "video":
				out[1]++
			case "audio":
				out[2]++
			default:
				out[3]++
			}
			return nil
		})
	}
	return out
}

// scaleComposition distributes a known composition to an exact total. Used for
// legacy tasks whose original preview plan was not persisted.
func scaleComposition(values [4]int, target int) [4]int {
	sum := values[0] + values[1] + values[2] + values[3]
	if sum <= 0 || target <= 0 {
		return [4]int{}
	}
	if sum == target {
		return values
	}
	var out [4]int
	used := 0
	for i := 0; i < 3; i++ {
		out[i] = (values[i]*target + sum/2) / sum
		used += out[i]
	}
	out[3] = target - used
	if out[3] < 0 {
		out[3] = 0
	}
	return out
}

// effectivePlanComposition repairs legacy/malformed plans that classified all
// media as files. The source message types are the authoritative type split.
func (f *Facade) effectivePlanComposition(slug string, total, images, videos, audio, files int) [4]int {
	if images+videos == 0 {
		src := f.sourceMediaComposition(slug)
		if src[0]+src[1] > 0 {
			if total <= 0 {
				total = src[0] + src[1] + src[2] + src[3]
			}
			return scaleComposition(src, total)
		}
	}
	return [4]int{images, videos, audio, files}
}

func (f *Facade) officialExportBaseline(slug string) (counts [4]int, total int, bytes int64) {
	meta, err := f.a.readWorkspaceMeta(slug)
	if err != nil {
		return
	}
	for _, ex := range meta.OfficialExports {
		counts[0] += ex.Images
		counts[1] += ex.Videos
		counts[2] += ex.Audio
		counts[3] += ex.Files
		total += ex.MediaFiles
		bytes += ex.TotalBytes
	}
	return
}

func (f *Facade) TaskDetail(id string) (TaskDetailDTO, error) {
	f.taskMu.Lock()
	for _, t := range f.tasks {
		d := t.detail()
		if d.ID != id {
			continue
		}
		f.taskMu.Unlock()
		if d.Slug != "" && (d.Kind == "sync" || d.Kind == "sync-all") {
			src := f.sourceMediaComposition(d.Slug)
			srcTotal := src[0] + src[1] + src[2] + src[3]
			planKnown := d.PlanKnown
			if !planKnown && srcTotal > 0 {
				target := d.Total
				if target <= 0 {
					target = srcTotal
				}
				scaled := scaleComposition(src, target)
				d.Images, d.Videos, d.Audio, d.Files = scaled[0], scaled[1], scaled[2], scaled[3]
				t.setDownloadComposition(d.Images, d.Videos, d.Audio, d.Files)
			}
			planCounts := [4]int{d.Images, d.Videos, d.Audio, d.Files}
			planTotal := planCounts[0] + planCounts[1] + planCounts[2] + planCounts[3]
			// A plan saved with every item classified as "file" is unusable;
			// rebuild the type split from the source messages.
			brokenPlan := d.PlanKnown && planCounts[0]+planCounts[1] == 0 && src[0]+src[1] > 0
			if brokenPlan {
				planCounts = src
				planTotal = srcTotal
			}
			// A plan whose total equals the full source means the downloader
			// included media that was already present. Subtract that baseline so
			// the task detail only shows this task's increment.
			includesBaseline := srcTotal > 0 && d.Total > 0 && d.Total*100 >= srcTotal*95
			baseCounts := [4]int{d.BaselineImages, d.BaselineVideos, d.BaselineAudio, d.BaselineFiles}
			baseTotal := d.BaselineTotal
			baseBytes := d.BaselineBytes
			if baseTotal <= 0 && includesBaseline {
				baseCounts, baseTotal, baseBytes = f.officialExportBaseline(d.Slug)
			}
			if baseTotal > 0 && d.Total > 0 {
				incTotal := max(0, d.Total-baseTotal)
				incDone := max(0, d.Done-baseTotal)
				incBytes := max(0, d.Bytes-baseBytes)
				incTotalBytes := max(0, d.TotalBytes-baseBytes)
				if incTotal > 0 {
					d.Total, d.Done, d.Bytes, d.TotalBytes = incTotal, incDone, incBytes, incTotalBytes
					d.Percent = int(float64(incDone)*100/float64(incTotal) + 0.5)
					incPlan := [4]int{
						max(0, planCounts[0]-baseCounts[0]),
						max(0, planCounts[1]-baseCounts[1]),
						max(0, planCounts[2]-baseCounts[2]),
						max(0, planCounts[3]-baseCounts[3]),
					}
					if incPlan[0]+incPlan[1]+incPlan[2]+incPlan[3] != incTotal {
						incPlan = scaleComposition(incPlan, incTotal)
					}
					d.Images, d.Videos, d.Audio, d.Files = incPlan[0], incPlan[1], incPlan[2], incPlan[3]
					t.setDownloadComposition(d.Images, d.Videos, d.Audio, d.Files)
					if d.State != "running" {
						present := f.workspacePresentComposition(d.Slug)
						done := [4]int{
							max(0, present[0]-baseCounts[0]),
							max(0, present[1]-baseCounts[1]),
							max(0, present[2]-baseCounts[2]),
							max(0, present[3]-baseCounts[3]),
						}
						if done[0]+done[1]+done[2]+done[3] > 0 {
							done = scaleComposition(done, incDone)
							d.DoneImages = min(done[0], d.Images)
							d.DoneVideos = min(done[1], d.Videos)
							d.DoneAudio = min(done[2], d.Audio)
							d.DoneFiles = min(done[3], d.Files)
							d.DoneStats = true
							t.setDoneMediaStats(d.DoneImages, d.DoneVideos, d.DoneAudio, d.DoneFiles)
						}
					} else {
						summary := f.workspaceMediaSummary(d.Slug)
						done := [4]int{
							max(0, summary.Images-baseCounts[0]),
							max(0, summary.Videos-baseCounts[1]),
							max(0, summary.Audio-baseCounts[2]),
							max(0, summary.Files-baseCounts[3]),
						}
						if done[0]+done[1]+done[2]+done[3] > 0 {
							done = scaleComposition(done, incDone)
							d.DoneImages = min(done[0], d.Images)
							d.DoneVideos = min(done[1], d.Videos)
							d.DoneAudio = min(done[2], d.Audio)
							d.DoneFiles = min(done[3], d.Files)
							d.DoneStats = true
							t.setDoneMediaStats(d.DoneImages, d.DoneVideos, d.DoneAudio, d.DoneFiles)
						}
					}
				}
			} else if brokenPlan {
				target := d.Total
				if target <= 0 {
					target = planTotal
				}
				scaled := scaleComposition(planCounts, target)
				d.Images, d.Videos, d.Audio, d.Files = scaled[0], scaled[1], scaled[2], scaled[3]
				t.setDownloadComposition(d.Images, d.Videos, d.Audio, d.Files)
				if d.State != "running" {
					present := f.workspacePresentComposition(d.Slug)
					if d.Done > 0 && present[0]+present[1]+present[2]+present[3] > 0 {
						done := scaleComposition(present, d.Done)
						d.DoneImages = min(done[0], d.Images)
						d.DoneVideos = min(done[1], d.Videos)
						d.DoneAudio = min(done[2], d.Audio)
						d.DoneFiles = min(done[3], d.Files)
						d.DoneStats = true
						t.setDoneMediaStats(d.DoneImages, d.DoneVideos, d.DoneAudio, d.DoneFiles)
					}
				} else {
					summary := f.workspaceMediaSummary(d.Slug)
					done := [4]int{summary.Images, summary.Videos, summary.Audio, summary.Files}
					if done[0]+done[1]+done[2]+done[3] > 0 {
						done = scaleComposition(done, d.Done)
						d.DoneImages = min(done[0], d.Images)
						d.DoneVideos = min(done[1], d.Videos)
						d.DoneAudio = min(done[2], d.Audio)
						d.DoneFiles = min(done[3], d.Files)
						d.DoneStats = true
						t.setDoneMediaStats(d.DoneImages, d.DoneVideos, d.DoneAudio, d.DoneFiles)
					}
				}
			} else if d.State != "running" {
				present := f.workspacePresentComposition(d.Slug)
				presentTotal := present[0] + present[1] + present[2] + present[3]
				if d.Done == 0 {
					d.DoneImages, d.DoneVideos, d.DoneAudio, d.DoneFiles = 0, 0, 0, 0
					d.DoneStats = true
					t.setDoneMediaStats(0, 0, 0, 0)
				} else if presentTotal > 0 {
					done := scaleComposition(present, d.Done)
					d.DoneImages = min(done[0], d.Images)
					d.DoneVideos = min(done[1], d.Videos)
					d.DoneAudio = min(done[2], d.Audio)
					d.DoneFiles = min(done[3], d.Files)
					d.DoneStats = true
					t.setDoneMediaStats(d.DoneImages, d.DoneVideos, d.DoneAudio, d.DoneFiles)
				}
			}
			if len(d.Completed) == 0 && d.State != "running" {
				d.Completed = f.recentWorkspaceMedia(d.Slug, 5)
				d.RecordsComplete = false
			}
			if d.TotalBytes == 0 {
				if plan, err := loadDownloadPlan(f.a.sourcePath(d.Slug)); err == nil {
					if total, estimated := estimatedTotalBytes(plan); total > 0 {
						d.TotalBytes = total
						d.TotalBytesEstimated = estimated
					}
				}
			}
			if baseTotal <= 0 && d.TotalBytes > 0 && d.Bytes > 0 && d.State != "done" {
				pct := float64(d.Bytes) * 100 / float64(d.TotalBytes)
				if pct > 100 {
					pct = 100
				}
				d.Percent = int(pct + 0.5)
			}
			_ = planTotal
		}
		// Task records written by older builds do not carry the type-specific
		// metadata. Recover it from the workspace on demand so the detail view
		// still shows chat id, counts and media composition.
		if d.Kind != "sync" && d.Kind != "sync-all" &&
			(d.ChatID == "" || d.Messages == 0 || d.Media == 0 || d.Images+d.Videos+d.Audio+d.Files == 0 ||
				(d.TotalBytes == 0 && (d.Kind == "import-official" || d.Kind == "export"))) {
			if meta, ok := f.a.workspaceMetaForTask(d.Slug, d.Chat); ok {
				if d.Slug == "" {
					d.Slug = meta.Slug
				}
				if d.Chat == "" {
					d.Chat = meta.Chat.Name
				}
				if d.ChatID == "" {
					d.ChatID = meta.Chat.ID
				}
				if d.Messages == 0 {
					d.Messages = meta.MessageCount
				}
				if d.Media == 0 {
					d.Media = meta.MediaCount
				}
				img, vid, aud, fl := f.a.workspaceReportStats(meta.Slug)
				if d.Images == 0 {
					d.Images = img
				}
				if d.Videos == 0 {
					d.Videos = vid
				}
				if d.Audio == 0 {
					d.Audio = aud
				}
				if d.Files == 0 {
					d.Files = fl
				}
				if d.TotalBytes == 0 && (d.Kind == "import-official" || d.Kind == "export") {
					d.TotalBytes = f.a.workspaceSize(meta.Slug)
				}
				if d.Source == "" && d.Kind == "import-official" && len(meta.OfficialExports) > 0 {
					root := filepath.FromSlash(meta.OfficialExports[0].Root)
					if !filepath.IsAbs(root) {
						root = filepath.Join(f.a.workspaceDir(meta.Slug), root)
					}
					d.Source = root
				}
			}
		}
		if d.Concurrent <= 0 {
			d.Concurrent = f.a.Settings.Concurrent
		}
		if d.Threads <= 0 {
			d.Threads = f.a.Settings.Threads
		}
		return d, nil
	}
	f.taskMu.Unlock()
	return TaskDetailDTO{}, fmt.Errorf("任务不存在")
}

// recentWorkspaceMedia backfills the completed list for tasks recorded before
// per-file progress was persisted. The files are real workspace media, not a
// synthetic placeholder.
func (f *Facade) recentWorkspaceMedia(slug string, limit int) []TaskProgress {
	if f.a == nil || slug == "" || limit <= 0 {
		return nil
	}
	type recentFile struct {
		name string
		size int64
		mod  time.Time
	}
	files := make([]recentFile, 0, 32)
	for _, dir := range []string{f.a.mediaDir(slug), f.a.filesDir(slug)} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			files = append(files, recentFile{name: entry.Name(), size: info.Size(), mod: info.ModTime()})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.After(files[j].mod) })
	if len(files) > limit {
		files = files[:limit]
	}
	out := make([]TaskProgress, 0, len(files))
	for _, file := range files {
		out = append(out, TaskProgress{
			Name: file.name, Kind: archive.MediaKind(file.name), Done: true, Percent: 100,
			Expected: file.size, Transferred: file.size, ElapsedMs: -1,
		})
	}
	return out
}

func (f *Facade) ClearFinishedTasks() {
	f.taskMu.Lock()
	kept := f.tasks[:0]
	for _, t := range f.tasks {
		if state := t.snapshot().State; state == "running" || state == "paused" {
			kept = append(kept, t)
		}
	}
	f.tasks = kept
	f.taskMu.Unlock()
	f.saveTasks()
}

// ClearAllTasks removes all task records except currently running work. Archive
// files and workspace data are untouched.
func (f *Facade) ClearAllTasks() {
	f.taskMu.Lock()
	kept := f.tasks[:0]
	for _, t := range f.tasks {
		if t.snapshot().State == "running" {
			kept = append(kept, t)
		}
	}
	f.tasks = kept
	f.taskMu.Unlock()
	f.saveTasks()
}

// DeleteTask removes one finished task record. It never touches archive files.
func (f *Facade) DeleteTask(id string) error {
	if strings.TrimSpace(id) == "" {
		return errors.New("缺少任务标识")
	}
	f.taskMu.Lock()
	kept := f.tasks[:0]
	removed := false
	for _, t := range f.tasks {
		dto := t.snapshot()
		if dto.ID == id {
			if dto.State == "running" {
				f.taskMu.Unlock()
				return errors.New("进行中的任务不能删除记录，请先暂停或结束任务")
			}
			removed = true
			continue
		}
		kept = append(kept, t)
	}
	f.tasks = kept
	f.taskMu.Unlock()
	if !removed {
		return errors.New("找不到任务")
	}
	f.saveTasks()
	return nil
}

func (f *Facade) taskStorePath() string {
	if f.a == nil || f.a.ConfigDir == "" {
		return ""
	}
	return filepath.Join(f.a.ConfigDir, "tasks.json")
}

func (f *Facade) saveTasks() {
	path := f.taskStorePath()
	if path == "" {
		return
	}
	tasks := f.taskDetails()
	b, err := json.MarshalIndent(tasks, "", "  ")
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, 0644) == nil {
		_ = os.Rename(tmp, path)
	}
}

func (f *Facade) loadTasks() {
	path := f.taskStorePath()
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var stored []TaskDetailDTO
	if json.Unmarshal(b, &stored) != nil {
		return
	}
	f.taskMu.Lock()
	seenPaused := map[string]bool{}
	changed := false
	for _, detail := range stored {
		dto := detail.TaskDTO
		if dto.State == "running" {
			dto.State = "failed"
			dto.Error = "应用上次退出时任务未完成"
			if dto.FinishedAt == 0 {
				dto.FinishedAt = dto.StartedAt
			}
		}
		// Older builds created a fresh paused task each time a download was
		// resumed. Keep only the newest paused row per chat so the list reflects
		// one logical download.
		if dto.State == "paused" && dto.Slug != "" {
			if seenPaused[dto.Slug] {
				changed = true
				continue
			}
			seenPaused[dto.Slug] = true
		}
		if len(detail.Completed) == 0 && dto.Done > 0 {
			dto.RecordsComplete = false
		}
		f.tasks = append(f.tasks, &backgroundTask{
			dto:          dto,
			series:       detail.Series,
			active:       detail.Active,
			completed:    detail.Completed,
			activeBaseMs: dto.ElapsedMs,
		})
	}
	f.taskMu.Unlock()
	if changed {
		f.saveTasks()
	}
}

func (f *Facade) StartImportJSON(paths []string) (string, error) {
	if len(paths) == 0 {
		return "", fmt.Errorf("没有选择文件")
	}
	return f.startTask("import-json", fmt.Sprintf("导入 %d 个 result.json", len(paths)), func(t *backgroundTask) error {
		if dir := filepath.Dir(paths[0]); dir != "" {
			t.setInfo("", "", dir, "", 0, 0)
		}
		t.fileProgress(0, len(paths))
		var firstErr error
		ok := 0
		for i, p := range paths {
			t.fileProgress(i, len(paths))
			t.update(i*100/len(paths), filepath.Base(p))
			if _, _, err := f.a.importResultJSONMode(p, false); err != nil {
				if firstErr == nil {
					firstErr = fmt.Errorf("%s: %w", filepath.Base(p), err)
				}
				continue
			}
			ok++
			t.fileProgress(i+1, len(paths))
		}
		if firstErr != nil {
			return fmt.Errorf("成功 %d/%d：%w", ok, len(paths), firstErr)
		}
		t.update(100, fmt.Sprintf("已导入 %d 个聊天", ok))
		return nil
	}), nil
}

func (f *Facade) StartImportOfficial(folder, slug, mode string) (string, error) {
	if st, err := os.Stat(folder); err != nil || !st.IsDir() {
		return "", fmt.Errorf("所选目录无效")
	}
	return f.startTask("import-official", "继承官方 ChatExport", func(t *backgroundTask) error {
		t.setInfo("", mode, folder, "", 0, 0)
		if name := strings.TrimSpace(filepath.Base(folder)); name != "" && name != "." {
			t.setChat(name)
		}
		if slug != "" {
			t.setSlug(slug)
			if meta, err := f.a.readWorkspaceMeta(slug); err == nil {
				t.setChat(meta.Chat.Name)
				t.setInfo(meta.Chat.ID, mode, folder, "", meta.MessageCount, meta.MediaCount)
			}
		}
		t.update(5, "分析导出目录")
		chat, err := f.importOfficial(folder, slug, mode, func(meta archive.OfficialExportMeta) {
			t.setChat(meta.Name)
			t.setInfo("", mode, folder, "", meta.MessageCount, meta.MediaFiles)
			t.setMediaStats(meta.Images, meta.Videos, meta.Audio, meta.Files)
			t.setTotalBytes(meta.TotalBytes)
			t.update(10, fmt.Sprintf("统计完成 · %s · %d 条消息 · %d 个媒体", humanBytes(meta.TotalBytes), meta.MessageCount, meta.MediaFiles))
		}, func(p OperationProgress) {
			pct := p.Percent
			if pct <= 0 {
				pct = 20
				if p.Total > 0 {
					pct = 20 + int(p.Current*78/p.Total)
				}
				if pct > 98 {
					pct = 98
				}
			}
			detail := strings.TrimSpace(p.Stage)
			if strings.TrimSpace(p.Detail) != "" {
				detail += " · " + p.Detail
			}
			if p.FilesTotal > 0 {
				t.copyStats(p.Current, p.Total, p.FilesDone, p.FilesTotal, pct, detail)
			} else {
				t.update(pct, detail)
			}
		})
		if err != nil {
			return err
		}
		t.setChat(chat.Name)
		t.setSlug(chat.Slug)
		t.setInfo(chat.ID, mode, folder, "", chat.Messages, chat.Media)
		if img, vid, aud, fl := f.a.workspaceReportStats(chat.Slug); img+vid+aud+fl > 0 {
			t.setMediaStats(img, vid, aud, fl)
		}
		t.update(100, "已登记："+chat.Name)
		return nil
	}), nil
}

// workspaceReportStats reads the media breakdown written by the last build.
func (a *App) workspaceReportStats(slug string) (images, videos, audio, files int) {
	b, err := os.ReadFile(filepath.Join(a.workspaceDir(slug), "archive-report.json"))
	if err != nil {
		return 0, 0, 0, 0
	}
	var report struct {
		Stats struct {
			Images int `json:"images"`
			Videos int `json:"videos"`
			Audio  int `json:"audio"`
			Files  int `json:"files"`
		} `json:"stats"`
	}
	if json.Unmarshal(b, &report) != nil {
		return 0, 0, 0, 0
	}
	return report.Stats.Images, report.Stats.Videos, report.Stats.Audio, report.Stats.Files
}

func (a *App) workspaceMetaForTask(slug, chat string) (WorkspaceMeta, bool) {
	if slug != "" {
		if meta, err := a.readWorkspaceMeta(slug); err == nil {
			return meta, true
		}
	}
	name := strings.TrimSpace(chat)
	if name == "" {
		return WorkspaceMeta{}, false
	}
	for _, meta := range a.listWorkspaces() {
		if strings.EqualFold(strings.TrimSpace(meta.Chat.Name), name) {
			return meta, true
		}
	}
	return WorkspaceMeta{}, false
}

// workspaceSize sums the files an export would copy. Directory entries are
// metadata-only, so this stays fast even for large archives on a local disk.
func (a *App) workspaceSize(slug string) int64 {
	ws := a.workspaceDir(slug)
	if ws == "" {
		return 0
	}
	var total int64
	for _, dir := range []string{a.mediaDir(slug), a.filesDir(slug), filepath.Join(ws, "source"), filepath.Join(ws, "official_exports")} {
		_ = filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if info, er := d.Info(); er == nil && info.Size() > 0 {
				total += info.Size()
			}
			return nil
		})
	}
	return total
}

func (f *Facade) StartExportChat(slug, dstRoot string) (string, error) {
	return f.startTask("export", "导出聊天："+slug, func(t *backgroundTask) error {
		name := slug
		chatID := ""
		messages, media := 0, 0
		if meta, err := f.a.readWorkspaceMeta(slug); err == nil {
			name = meta.Chat.Name
			chatID = meta.Chat.ID
			messages = meta.MessageCount
			media = meta.MediaCount
		}
		t.setChat(name)
		t.setTitle("导出聊天：" + name)
		t.setInfo(chatID, "", f.a.Settings.LibraryRoot, dstRoot, messages, media)
		if img, vid, aud, fl := f.a.workspaceReportStats(slug); img+vid+aud+fl > 0 {
			t.setMediaStats(img, vid, aud, fl)
		}
		t.update(5, "统计聊天数据")
		if total := f.a.workspaceSize(slug); total > 0 {
			t.setTotalBytes(total)
		}
		t.update(15, "复制聊天文件")
		if err := f.ExportChat(slug, dstRoot); err != nil {
			return err
		}
		t.update(100, "导出完成")
		return nil
	}), nil
}

func (f *Facade) StartRefreshWeb(slug string) (string, error) {
	return f.startTask("refresh", "重建网页："+slug, func(t *backgroundTask) error {
		name := slug
		chatID := ""
		messages, media := 0, 0
		if meta, err := f.a.readWorkspaceMeta(slug); err == nil {
			name = meta.Chat.Name
			chatID = meta.Chat.ID
			messages = meta.MessageCount
			media = meta.MediaCount
		}
		t.setChat(name)
		t.setTitle("重建网页：" + name)
		t.setInfo(chatID, "", f.a.workspaceDir(slug), "", messages, media)
		if img, vid, aud, fl := f.a.workspaceReportStats(slug); img+vid+aud+fl > 0 {
			t.setMediaStats(img, vid, aud, fl)
		}
		t.update(30, "扫描与渲染")
		if err := f.RefreshWeb(slug); err != nil {
			return err
		}
		t.update(100, "网页已重建："+name)
		return nil
	}), nil
}

func (f *Facade) StartRefreshAllWeb() (string, error) {
	return f.startTask("refresh-all", "重建全部网页", func(t *backgroundTask) error {
		list := f.a.listWorkspaces()
		t.setInfo("", "", "", f.a.Settings.LibraryRoot, 0, 0)
		t.fileProgress(0, len(list))
		failures := 0
		ok := 0
		for i, m := range list {
			t.update(i*100/len(list), m.Chat.Name)
			if _, err := os.Stat(filepath.Join(f.a.dataDir(m.Slug), "archive-data.js")); err != nil {
				t.fileProgress(i+1, len(list))
				continue
			}
			if err := f.a.refreshWorkspaceWeb(m.Slug); err != nil {
				failures++
				t.fileProgress(i+1, len(list))
				continue
			}
			ok++
			t.update((i+1)*100/len(list), m.Chat.Name)
			t.fileProgress(i+1, len(list))
		}
		if err := f.a.buildLibrary(); err != nil {
			return err
		}
		t.update(100, fmt.Sprintf("重建 %d 个聊天", ok))
		if failures > 0 {
			return fmt.Errorf("%d 个聊天重建失败", failures)
		}
		return nil
	}), nil
}

// StartSyncAllMissing runs the one-click sync for every chat that reports
// missing media, then rebuilds the library page once.
func (f *Facade) StartSyncAllMissing() (string, error) {
	var targets []WorkspaceMeta
	for _, m := range f.a.listWorkspaces() {
		if m.MissingCount > 0 && fileExists(f.a.sourcePath(m.Slug)) {
			targets = append(targets, m)
		}
	}
	if len(targets) == 0 {
		return "", fmt.Errorf("没有缺失媒体的聊天")
	}
	var planImages, planVideos, planAudio, planFiles int
	var planBytes int64
	for _, m := range targets {
		if plan, _, err := f.a.estimateMissingPlan(m.Slug); err == nil {
			planImages += plan.Images
			planVideos += plan.Videos
			planAudio += plan.Audio
			planFiles += plan.Files
			planBytes += plan.KnownBytes
		}
	}
	return f.startTask("sync-all", fmt.Sprintf("批量下载缺失（%d 个聊天）", len(targets)), func(t *backgroundTask) error {
		t.setDownloadComposition(planImages, planVideos, planAudio, planFiles)
		t.setTotalBytes(planBytes)
		t.fileProgress(0, len(targets))
		failures := 0
		ctx := t.context()
		for i, m := range targets {
			if ctx.Err() != nil {
				return errUserAbort
			}
			t.setChat(m.Chat.Name)
			t.update(i*100/len(targets), m.Chat.Name)
			t.fileProgress(i, len(targets))
			rep := &eventReporter{opID: "sync-all", emit: f.send}
			rep.Phase(ctx, "sync", "同步缺失媒体", m.Chat.Name)
			if err := f.a.smartSyncCtx(ctx, m.Slug, rep); err != nil {
				if errors.Is(err, errUserAbort) || errors.Is(err, context.Canceled) {
					return errUserAbort
				}
				failures++
				t.fileProgress(i+1, len(targets))
				continue
			}
			if _, err := f.a.buildWorkspaceModeWithProgressCtx(ctx, m.Slug, true, nil); err != nil {
				if ctx.Err() != nil {
					return errUserAbort
				}
				failures++
			}
			t.update((i+1)*100/len(targets), m.Chat.Name)
			t.fileProgress(i+1, len(targets))
		}
		if ctx.Err() != nil {
			return errUserAbort
		}
		if err := f.a.buildLibrary(); err != nil {
			return err
		}
		if failures > 0 {
			return fmt.Errorf("%d/%d 个聊天同步失败", failures, len(targets))
		}
		t.update(100, fmt.Sprintf("完成 %d 个聊天的同步", len(targets)))
		return nil
	}), nil
}

func (f *Facade) StartMergeLibrary(srcRoot string) (string, error) {
	srcRoot = strings.TrimSpace(srcRoot)
	if srcRoot == "" {
		return "", fmt.Errorf("缺少源档案库目录")
	}
	if strings.EqualFold(filepath.Clean(srcRoot), filepath.Clean(f.a.Settings.LibraryRoot)) {
		return "", fmt.Errorf("不能把档案库与自身合并")
	}
	if !looksLikeLibrary(srcRoot) {
		return "", fmt.Errorf("所选目录不是 TelegramArchiveKit 档案库")
	}
	return f.startTask("merge", "合并档案库", func(t *backgroundTask) error {
		slugs := librarySourceChats(srcRoot)
		if len(slugs) == 0 {
			return fmt.Errorf("源档案库没有可合并的聊天")
		}
		t.setInfo("", "", srcRoot, f.a.Settings.LibraryRoot, 0, 0)
		t.fileProgress(0, len(slugs))
		ok := 0
		for i, slug := range slugs {
			t.update(i*100/len(slugs), slug)
			t.fileProgress(i, len(slugs))
			if _, err := f.a.copyChatFromLibrary(srcRoot, slug); err != nil {
				continue
			}
			ok++
			t.fileProgress(i+1, len(slugs))
		}
		if err := f.a.buildLibrary(); err != nil {
			return err
		}
		f.a.rememberLibrary(srcRoot)
		t.update(100, fmt.Sprintf("合并 %d/%d 个聊天", ok, len(slugs)))
		return nil
	}), nil
}
