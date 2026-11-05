package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// TaskDTO is one background operation shown in the desktop task center.
type TaskDTO struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Title      string `json:"title"`
	Chat       string `json:"chat,omitempty"`
	Detail     string `json:"detail,omitempty"`
	State      string `json:"state"` // running|done|failed
	Percent    int    `json:"percent"`
	StartedAt  int64  `json:"startedAt"`
	FinishedAt int64  `json:"finishedAt,omitempty"`
	Error      string `json:"error,omitempty"`
}

type backgroundTask struct {
	mu  sync.Mutex
	dto TaskDTO
}

func (t *backgroundTask) setChat(chat string) {
	t.mu.Lock()
	t.dto.Chat = chat
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

func (t *backgroundTask) snapshot() TaskDTO {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.dto
}

func (t *backgroundTask) finish(err error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.dto.FinishedAt = time.Now().UnixMilli()
	if err != nil {
		t.dto.State = "failed"
		t.dto.Error = err.Error()
		return
	}
	t.dto.State = "done"
	t.dto.Percent = 100
}

func (f *Facade) startTask(kind, title string, fn func(t *backgroundTask) error) string {
	f.taskMu.Lock()
	f.taskSeq++
	id := fmt.Sprintf("task-%d-%d", time.Now().UnixNano(), f.taskSeq)
	task := &backgroundTask{dto: TaskDTO{
		ID: id, Kind: kind, Title: title, State: "running",
		StartedAt: time.Now().UnixMilli(),
	}}
	f.tasks = append([]*backgroundTask{task}, f.tasks...)
	if len(f.tasks) > 50 {
		f.tasks = f.tasks[:50]
	}
	f.taskMu.Unlock()

	f.saveTasks()
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
	return id
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

func (f *Facade) ClearFinishedTasks() {
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
	tasks := f.Tasks()
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
	var stored []TaskDTO
	if json.Unmarshal(b, &stored) != nil {
		return
	}
	f.taskMu.Lock()
	for _, dto := range stored {
		if dto.State == "running" {
			dto.State = "failed"
			dto.Error = "应用上次退出时任务未完成"
			if dto.FinishedAt == 0 {
				dto.FinishedAt = dto.StartedAt
			}
		}
		f.tasks = append(f.tasks, &backgroundTask{dto: dto})
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
	return f.startTask("sync-all", fmt.Sprintf("同步全部缺失（%d 个聊天）", len(targets)), func(t *backgroundTask) error {
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
