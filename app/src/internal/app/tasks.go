package app

import (
	"context"
	"encoding/json"
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
	Slug                string  `json:"slug,omitempty"`
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
}

func (t *backgroundTask) setChat(chat string) {
	t.mu.Lock()
	t.dto.Chat = chat
	t.mu.Unlock()
}

func (t *backgroundTask) setSlug(slug string) {
	t.mu.Lock()
	t.dto.Slug = slug
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
	if t.dto.StartedAt > 0 {
		t.dto.ElapsedMs = time.Now().UnixMilli() - t.dto.StartedAt
	} else if s.ElapsedMs > 0 {
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
	defer t.mu.Unlock()
	if t.dto.State != "running" {
		return
	}
	t.closeRunning()
	if err != nil {
		t.dto.State = "failed"
		t.dto.Error = err.Error()
		return
	}
	t.dto.State = "done"
	t.dto.Percent = 100
}

func (t *backgroundTask) pause() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.dto.State != "running" {
		return
	}
	t.closeRunning()
	t.dto.State = "paused"
	t.dto.Error = "任务已暂停，可继续下载"
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
	t.dto.FinishedAt = time.Now().UnixMilli()
	t.dto.ETAMs = 0
	t.active = nil
	if t.dto.FinishedAt > t.dto.StartedAt {
		t.dto.ElapsedMs = t.dto.FinishedAt - t.dto.StartedAt
	}
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
	task := &backgroundTask{dto: TaskDTO{
		ID: id, Kind: kind, Title: title, Chat: chat, State: "running",
		StartedAt: time.Now().UnixMilli(),
	}}
	f.tasks = append([]*backgroundTask{task}, f.tasks...)
	if len(f.tasks) > 50 {
		f.tasks = f.tasks[:50]
	}
	f.taskMu.Unlock()
	f.saveTasks()
	return task
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
		out = append(out, t.snapshot())
	}
	return out
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

func (f *Facade) TaskDetail(id string) (TaskDetailDTO, error) {
	f.taskMu.Lock()
	for _, t := range f.tasks {
		d := t.detail()
		if d.ID != id {
			continue
		}
		f.taskMu.Unlock()
		if d.Slug != "" && (d.Kind == "sync" || d.Kind == "sync-all") {
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
			if d.TotalBytes > 0 && d.Bytes > 0 && d.State != "done" {
				pct := float64(d.Bytes) * 100 / float64(d.TotalBytes)
				if pct > 100 {
					pct = 100
				}
				d.Percent = int(pct + 0.5)
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
	for _, detail := range stored {
		dto := detail.TaskDTO
		if dto.State == "running" {
			dto.State = "failed"
			dto.Error = "应用上次退出时任务未完成"
			if dto.FinishedAt == 0 {
				dto.FinishedAt = dto.StartedAt
			}
		}
		if len(detail.Completed) == 0 && dto.Done > 0 {
			dto.RecordsComplete = false
		}
		f.tasks = append(f.tasks, &backgroundTask{dto: dto, series: detail.Series, active: detail.Active, completed: detail.Completed})
	}
	f.taskMu.Unlock()
}

func (f *Facade) StartImportJSON(paths []string) (string, error) {
	if len(paths) == 0 {
		return "", fmt.Errorf("没有选择文件")
	}
	return f.startTask("import-json", fmt.Sprintf("导入 %d 个 result.json", len(paths)), func(t *backgroundTask) error {
		var firstErr error
		ok := 0
		for i, p := range paths {
			t.update(i*100/len(paths), filepath.Base(p))
			if _, _, err := f.a.importResultJSONMode(p, false); err != nil {
				if firstErr == nil {
					firstErr = fmt.Errorf("%s: %w", filepath.Base(p), err)
				}
				continue
			}
			ok++
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
		t.update(20, "分析导出目录")
		chat, err := f.ImportOfficial(folder, slug, mode)
		if err != nil {
			return err
		}
		t.setChat(chat.Name)
		t.update(100, "已登记："+chat.Name)
		return nil
	}), nil
}

func (f *Facade) StartExportChat(slug, dstRoot string) (string, error) {
	name := slug
	if meta, err := f.a.readWorkspaceMeta(slug); err == nil {
		name = meta.Chat.Name
	}
	return f.startTask("export", "导出聊天："+name, func(t *backgroundTask) error {
		t.setChat(name)
		t.update(15, "复制聊天文件")
		if err := f.ExportChat(slug, dstRoot); err != nil {
			return err
		}
		t.update(100, "导出完成")
		return nil
	}), nil
}

func (f *Facade) StartRefreshWeb(slug string) (string, error) {
	name := slug
	if meta, err := f.a.readWorkspaceMeta(slug); err == nil {
		name = meta.Chat.Name
	}
	return f.startTask("refresh", "重建网页："+name, func(t *backgroundTask) error {
		t.setChat(name)
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
		failures := 0
		ok := 0
		for i, m := range list {
			t.update(i*100/len(list), m.Chat.Name)
			if _, err := os.Stat(filepath.Join(f.a.dataDir(m.Slug), "archive-data.js")); err != nil {
				continue
			}
			if err := f.a.refreshWorkspaceWeb(m.Slug); err != nil {
				failures++
				continue
			}
			ok++
			t.update((i+1)*100/len(list), m.Chat.Name)
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
	return f.startTask("sync-all", fmt.Sprintf("批量下载缺失（%d 个聊天）", len(targets)), func(t *backgroundTask) error {
		failures := 0
		for i, m := range targets {
			t.setChat(m.Chat.Name)
			t.update(i*100/len(targets), m.Chat.Name)
			rep := &eventReporter{opID: "sync-all", emit: f.send}
			rep.Phase(context.Background(), "sync", "同步缺失媒体", m.Chat.Name)
			if err := f.a.smartSyncCtx(context.Background(), m.Slug, rep); err != nil {
				failures++
				continue
			}
			if _, err := f.a.buildWorkspaceModeWithProgressCtx(context.Background(), m.Slug, true, nil); err != nil {
				failures++
			}
			t.update((i+1)*100/len(targets), m.Chat.Name)
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
		ok := 0
		for i, slug := range slugs {
			t.update(i*100/len(slugs), slug)
			if _, err := f.a.copyChatFromLibrary(srcRoot, slug); err != nil {
				continue
			}
			ok++
		}
		if err := f.a.buildLibrary(); err != nil {
			return err
		}
		f.a.rememberLibrary(srcRoot)
		t.update(100, fmt.Sprintf("合并 %d/%d 个聊天", ok, len(slugs)))
		return nil
	}), nil
}
