package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"telegramarchivekit/internal/archive"
	"telegramarchivekit/internal/media"
	"telegramarchivekit/internal/platform"
)

// ErrOperationRunning is returned when the desktop asks for a second write
// operation while one is already in flight.
var ErrOperationRunning = errors.New("已有任务正在进行，请等待完成或先取消")

type desktopOp struct {
	id      string
	slug    string
	chat    string
	cancel  context.CancelFunc
	task    *backgroundTask
	paused  bool
	stopped bool
}

// Facade is the desktop client's only door into the engine. It owns the App
// state, serializes write operations and emits JSON-ready progress events.
type Facade struct {
	a    *App
	emit func(event string, data any)

	mu      sync.Mutex
	op      *desktopOp
	seq     int64
	latest  DownloadSnapshot
	hasDl   bool
	opState OperationDTO
	hasOp   bool
	done    DoneDTO
	hasDone bool
	running bool
	login   *loginSession

	loginLaunch     loginLauncher
	libLock         *sessionLock
	remoteSuspended bool

	taskMu          sync.Mutex
	taskSaveMu      sync.Mutex
	rebuildMu       sync.Mutex
	taskSeq         int64
	tasks           []*backgroundTask
	lastTaskPersist time.Time

	mediaMu    sync.Mutex
	mediaCache map[string]*mediaCatalogEntry
	mediaSlots chan struct{}
	mediaJobs  int
}

// DesktopState is polled by the window; it intentionally excludes Bootstrap
// (which probes tdl/PATH) so a 500ms poll stays cheap.
type DesktopState struct {
	Download  *DownloadSnapshot `json:"download,omitempty"`
	Operation *OperationDTO     `json:"operation,omitempty"`
	Done      *DoneDTO          `json:"done,omitempty"`
	Login     *LoginStateDTO    `json:"login,omitempty"`
	Tasks     []TaskDTO         `json:"tasks"`
	Running   bool              `json:"running"`
}

// OpenFacade loads settings exactly like the console client does.
func OpenFacade() (*Facade, error) {
	a, err := newApp()
	if err != nil {
		return nil, err
	}
	f := &Facade{a: a}
	a.workspaceChanged = f.invalidateWorkspaceMedia
	f.loadTasks()
	return f, nil
}

// AcquireLibraryLock marks this process as the writer for the current library.
// It is held for the whole desktop session; the console client checks it.
func (f *Facade) AcquireLibraryLock() error {
	lock, err := acquireSessionLock(f.a.Settings.LibraryRoot)
	if err != nil {
		return err
	}
	f.mu.Lock()
	old := f.libLock
	f.libLock = lock
	f.mu.Unlock()
	old.release()
	return nil
}

func (f *Facade) LoginActive() bool {
	f.mu.Lock()
	s := f.login
	f.mu.Unlock()
	if s == nil {
		return false
	}
	st := s.snapshot().State
	return st == "starting" || st == "waiting"
}

// Shutdown stops any in-flight work and releases the library mutex.
func (f *Facade) Shutdown() {
	f.Cancel()
	f.mu.Lock()
	s := f.login
	f.mu.Unlock()
	if s != nil {
		s.cancel()
		_ = killAllTdl()
	}
	// Downloads also own a tdl child; without this a quit leaves it running,
	// holding the session file and continuing to write into the library.
	killTrackedTdl()
	f.ReleaseLibraryLock()
}

func (f *Facade) ReleaseLibraryLock() {
	f.mu.Lock()
	lock := f.libLock
	f.libLock = nil
	f.mu.Unlock()
	lock.release()
}

func (f *Facade) SetEmitter(fn func(event string, data any)) {
	f.mu.Lock()
	f.emit = fn
	f.mu.Unlock()
}

func (f *Facade) send(event string, data any) {
	var finished *backgroundTask
	var finishErr error
	var pausedDone, stoppedDone, partialDone bool
	persist := false
	f.mu.Lock()
	switch event {
	case "tak:download":
		if s, ok := data.(DownloadSnapshot); ok {
			f.latest = s
			f.hasDl = true
			if f.op != nil && f.op.task != nil {
				f.op.task.updateDownload(s)
				if time.Since(f.lastTaskPersist) >= 10*time.Second {
					f.lastTaskPersist = time.Now()
					persist = true
				}
			}
		}
	case "tak:operation":
		if o, ok := data.(OperationDTO); ok {
			f.opState = o
			f.hasOp = true
			if f.op != nil && f.op.task != nil {
				pct := -1
				if o.Total > 0 {
					pct = int(o.Current * 100 / o.Total)
				}
				f.op.task.update(pct, o.Stage)
			}
		}
	case "tak:done":
		if d, ok := data.(DoneDTO); ok {
			f.done = d
			f.hasDone = true
			f.running = false
			if f.op != nil && f.op.task != nil {
				finished = f.op.task
				pausedDone = d.Paused
				stoppedDone = d.Stopped
				partialDone = d.Partial
				if !d.OK {
					finishErr = errors.New(fallbackText(d.Error, d.Stage, "同步失败"))
				}
			}
		}
	}
	fn := f.emit
	f.mu.Unlock()
	if finished != nil {
		if stoppedDone {
			finished.stop()
		} else if pausedDone {
			finished.pause()
		} else if partialDone {
			finished.partial(finishErr)
		} else {
			finished.finish(finishErr)
		}
		f.saveTasks()
	} else if persist {
		f.saveTasks()
	}
	if fn != nil {
		fn(event, data)
	}
}

func fallbackText(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// State is the polling endpoint for the desktop window.
func (f *Facade) State() DesktopState {
	f.mu.Lock()
	st := DesktopState{Running: f.running}
	if f.hasDl {
		dl := f.latest
		st.Download = &dl
	}
	if f.hasOp {
		op := f.opState
		st.Operation = &op
	}
	if f.hasDone {
		done := f.done
		st.Done = &done
	}
	login := f.login
	f.mu.Unlock()
	if login != nil {
		ls := login.snapshot()
		st.Login = &ls
	}
	st.Tasks = f.Tasks()
	return st
}

func (f *Facade) Ping() string { return "pong" }

func (f *Facade) ConfigDir() string { return f.a.ConfigDir }

func (f *Facade) libraryRoot() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.a.Settings.LibraryRoot
}

func (f *Facade) LibraryKey() string {
	return libraryFingerprint(f.libraryRoot())
}

func (f *Facade) MediaLibrary(key string) (root string, remote bool, ok bool) {
	if f.ManagedRemoteUnavailable() {
		return "", false, false
	}
	f.mu.Lock()
	root, lastRemote := f.a.Settings.LibraryRoot, f.a.Settings.LastRemoteRoot
	f.mu.Unlock()
	if root == "" || key == "" || key != libraryFingerprint(root) {
		return "", false, false
	}
	remote, _ = platform.NetworkPathKind(root)
	return root, remote || (lastRemote != "" && strings.EqualFold(filepath.Clean(lastRemote), filepath.Clean(root))), true
}

func (f *Facade) Bootstrap() BootstrapDTO {
	f.mu.Lock()
	root, current := f.a.Settings.LibraryRoot, f.a.Settings.LastWorkspaceSlug
	lastRemote := f.a.Settings.LastRemoteRoot
	history := append([]string(nil), f.a.Settings.LibraryHistory...)
	f.mu.Unlock()
	remote, kind := platform.NetworkPathKind(root)
	if remote || (lastRemote != "" && strings.EqualFold(filepath.Clean(lastRemote), filepath.Clean(root))) {
		kind = "remote"
	}
	return BootstrapDTO{
		Version:     version,
		LibraryRoot: root,
		LibraryKey:  libraryFingerprint(root),
		LibraryKind: kind,
		Tdl:         f.a.resolveTdl(),
		TdlRunning:  isTdlRunning(),
		HasSession:  hasTdlSessionData(),
		FFmpeg:      media.FindFFmpeg(),
		Current:     current,
		ConfigPath:  f.a.ConfigPath,
		History:     history,
	}
}

func (f *Facade) ListChats() []ChatDTO {
	result, _ := f.LibraryChats()
	return result.Chats
}

// LibraryChats refreshes workspace metadata independently of fast task polling.
func (f *Facade) LibraryChats() (LibraryChatsDTO, error) {
	if f.ManagedRemoteUnavailable() {
		return LibraryChatsDTO{}, errors.New("远程档案库等待重连")
	}
	f.mu.Lock()
	root, current := f.a.Settings.LibraryRoot, f.a.Settings.LastWorkspaceSlug
	f.mu.Unlock()
	key := libraryFingerprint(root)
	if root == "" {
		return LibraryChatsDTO{LibraryKey: key, Chats: []ChatDTO{}}, nil
	}
	a := &App{Settings: Settings{LibraryRoot: root}}
	list, err := a.readWorkspaces()
	if err != nil {
		return LibraryChatsDTO{}, errors.New("档案库暂时不可访问，请重试")
	}
	out := make([]ChatDTO, 0, len(list))
	for _, m := range list {
		messages := m.MessageCount
		summary, ready := f.cachedWorkspaceMediaSummary(root, m.Slug)
		mediaCount := m.MediaCount
		if ready {
			mediaCount = summary.Total
		}
		firstTS, lastTS := m.FirstTS, m.LastTS
		if len(m.OfficialExports) > 0 && (messages == 0 || (!ready && mediaCount == 0)) {
			officialMessages, officialMedia := 0, 0
			for _, ex := range m.OfficialExports {
				officialMessages += ex.MessageCount
				officialMedia += ex.MediaFiles
				if firstTS == 0 || (ex.FirstTS > 0 && ex.FirstTS < firstTS) {
					firstTS = ex.FirstTS
				}
				if ex.LastTS > lastTS {
					lastTS = ex.LastTS
				}
			}
			if messages == 0 {
				messages = officialMessages
			}
			if !ready && mediaCount == 0 {
				mediaCount = officialMedia
			}
		}
		dto := ChatDTO{
			Slug: m.Slug, Name: m.Chat.Name, Type: m.Chat.Type, ID: m.Chat.ID,
			Messages: messages, Media: mediaCount, MediaReady: ready, Missing: m.MissingCount,
			Images: summary.Images, Videos: summary.Videos, Audio: summary.Audio, Files: summary.Files,
			TotalBytes: summary.Bytes,
			ImageBytes: summary.ImageBytes, VideoBytes: summary.VideoBytes,
			AudioBytes: summary.AudioBytes, FileBytes: summary.FileBytes,
			FirstTS: firstTS, LastTS: lastTS, UpdatedAt: formatMetaTime(m.UpdatedAt),
			HasSource: fileExists(a.sourcePath(m.Slug)),
			Official:  len(m.OfficialExports),
			Dir:       a.workspaceDir(m.Slug),
			Current:   m.Slug == current,
		}
		if entries, err := os.ReadDir(a.workspaceDir(m.Slug)); err == nil {
			for _, e := range entries {
				n := strings.ToLower(e.Name())
				if !e.IsDir() && (n == "messages.html" || (strings.HasPrefix(n, "messages") && strings.HasSuffix(n, ".html") && len(n) > len("messages.html"))) {
					dto.Pages++
				}
			}
		}
		if dto.Pages == 0 {
			for _, ex := range m.OfficialExports {
				root := filepath.FromSlash(ex.Root)
				if !filepath.IsAbs(root) {
					root = filepath.Join(a.workspaceDir(m.Slug), root)
				}
				if pages, err := archive.ListOfficialHTMLPages(root); err == nil {
					dto.Pages += len(pages)
				}
			}
		}
		out = append(out, dto)
	}
	return LibraryChatsDTO{LibraryKey: key, Chats: out}, nil
}

// StartOneClick runs sync + build for one chat and streams progress events.
// It returns the task id so callers can open the matching download detail;
// completion arrives as tak:done.
func (f *Facade) StartOneClick(slug string) (string, error) {
	if strings.TrimSpace(slug) == "" {
		return "", errors.New("缺少聊天标识")
	}
	f.mu.Lock()
	if f.op != nil {
		f.mu.Unlock()
		return "", ErrOperationRunning
	}
	library, root := f.libLock, f.a.Settings.LibraryRoot
	f.mu.Unlock()
	a := &App{Settings: Settings{LibraryRoot: root}}
	if _, err := checkedWorkspaceDir(root, slug); err != nil {
		return "", err
	}
	meta, err := a.readWorkspaceMeta(slug)
	if err != nil {
		return "", fmt.Errorf("读取聊天失败: %w", err)
	}
	if !fileExists(a.sourcePath(slug)) {
		return "", errors.New("该聊天只有官方导出，请先导入 result.json")
	}
	plan, _, planErr := a.estimateMissingPlan(slug)
	if planErr == nil && plan.Total > 0 && plan.KnownBytes > 0 {
		if free := int64(platform.FreeSpaceBytes(a.workspaceDir(slug))); free > 0 && free < plan.KnownBytes+downloadSpaceReserve {
			return "", fmt.Errorf("磁盘空间不足：仍需下载约 %s，当前可用 %s。请清理空间或更换档案库位置后再试", humanBytes(plan.KnownBytes), humanBytes(free))
		}
	}
	var baseline [4]int
	var baselineTotal int
	var baselineBytes int64
	if planErr == nil && plan.Total > 0 {
		if basePlan, err := loadDownloadPlan(a.sourcePath(slug)); err == nil {
			doneIDs, doneBytes := a.downloadExistingSnapshot(slug, basePlan)
			baselineTotal, baselineBytes = len(doneIDs), doneBytes
			for id := range doneIDs {
				switch basePlan.Kinds[id] {
				case "image":
					baseline[0]++
				case "video":
					baseline[1]++
				case "audio":
					baseline[2]++
				default:
					baseline[3]++
				}
			}
		}
	}

	f.mu.Lock()
	if f.libLock != library {
		f.mu.Unlock()
		return "", errors.New("档案库已切换，请重新选择聊天")
	}
	if f.op != nil {
		f.mu.Unlock()
		return "", ErrOperationRunning
	}
	f.seq++
	opID := fmt.Sprintf("op-%d-%d", time.Now().UnixNano(), f.seq)
	ctx, cancel := context.WithCancel(context.Background())
	task := f.pausedTaskForSlug(slug)
	if task != nil {
		task.resume()
	} else {
		task = f.createTask("sync", "下载聊天："+meta.Chat.Name, meta.Chat.Name)
	}
	task.setSlug(slug)
	// A task's plan is exactly what its preview dialog showed: the media that
	// are still missing. It is captured once when the task is created and kept
	// across pause/resume, so the denominator never drifts while downloading.
	currentPlan := task.snapshot()
	if planErr == nil && !currentPlan.PlanKnown && currentPlan.PlanTotal <= 0 {
		composition := f.effectivePlanComposition(slug, plan.Total, plan.Images, plan.Videos, plan.Audio, plan.Files)
		composition = normalizePlanComposition(composition, plan.Total)
		task.setDownloadPlan(plan.Total, plan.KnownBytes, composition[0], composition[1], composition[2], composition[3])
		// The engine reports progress against the complete chat plan, including
		// files that existed before this run. Measure that baseline with the same
		// ID/size matching and subtract it from every displayed value.
		task.setDownloadBaseline(baselineTotal, baselineBytes, baseline[0], baseline[1], baseline[2], baseline[3])
	}
	op := &desktopOp{id: opID, slug: slug, chat: meta.Chat.Name, cancel: cancel, task: task}
	f.op = op
	f.running = true
	f.hasDl = false
	f.hasOp = false
	f.hasDone = false
	taskID := task.snapshot().ID
	f.mu.Unlock()

	go f.runOneClick(ctx, op, meta)
	return taskID, nil
}

func (f *Facade) runOneClick(ctx context.Context, op *desktopOp, meta WorkspaceMeta) {
	root := f.libraryRoot()
	defer func() {
		f.invalidateWorkspaceMedia(root, op.slug)
		op.cancel()
		f.mu.Lock()
		if f.op == op {
			f.op = nil
		}
		f.mu.Unlock()
		if op.task != nil {
			op.task.finish(errors.New("同步任务意外结束"))
			f.saveTasks()
		}
	}()

	rep := &eventReporter{opID: op.id, emit: f.send}
	rep.Phase(ctx, "preflight", "准备同步", meta.Chat.Name)
	err := f.a.smartSyncCtx(ctx, op.slug, rep)
	if err == nil {
		rep.Phase(ctx, "build", "正在构建网页", "生成页面、搜索与日期索引")
		var arc *Archive
		arc, err = f.a.buildWorkspaceModeWithProgressCtx(ctx, op.slug, true, func(p OperationProgress) {
			f.send("tak:operation", OperationDTO{
				OpID: op.id, Phase: "build", Stage: p.Stage, Detail: p.Detail,
				Current: p.Current, Total: p.Total, Unit: p.Unit,
			})
		})
		if err == nil && arc != nil {
			f.send("tak:done", DoneDTO{
				OpID: op.id, OK: true, Stage: "完成",
				Messages: arc.Stats.Messages, Media: arc.Stats.MediaFiles, Missing: arc.Stats.MissingMedia,
			})
			return
		}
	}
	f.mu.Lock()
	paused := op.paused
	stopped := op.stopped
	f.mu.Unlock()
	if stopped {
		f.send("tak:done", DoneDTO{OpID: op.id, Stopped: true, Stage: "任务已终止", Error: "任务已终止，进度已保留"})
		return
	}
	if paused {
		f.send("tak:done", DoneDTO{OpID: op.id, Paused: true, Stage: "任务已暂停", Error: "任务已暂停，可稍后继续下载"})
		return
	}
	stage := "同步失败"
	if err != nil {
		stage = err.Error()
	}
	var partial *PartialMediaError
	f.send("tak:done", DoneDTO{OpID: op.id, OK: false, Partial: errors.As(err, &partial), Stage: stage, Error: stage})
}

func (f *Facade) Cancel() bool {
	f.mu.Lock()
	op := f.op
	f.mu.Unlock()
	if op == nil {
		return false
	}
	op.cancel()
	return true
}

// Pause stops the current tdl run but records the task as paused so it can be
// resumed from the existing files instead of becoming a red failure.
func (f *Facade) Pause() bool {
	f.mu.Lock()
	op := f.op
	if op != nil {
		op.paused = true
		if op.task != nil {
			op.task.update(-1, "正在安全暂停，当前文件结束后会保留进度…")
		}
	}
	f.mu.Unlock()
	if op == nil {
		return false
	}
	op.cancel()
	return true
}

// StopTask terminates a running or paused task without marking it failed.
func (f *Facade) StopTask(id string) (bool, error) {
	f.mu.Lock()
	op := f.op
	if op != nil && (id == "" || (op.task != nil && op.task.snapshot().ID == id)) {
		op.stopped = true
		op.cancel()
		f.mu.Unlock()
		return true, nil
	}
	f.mu.Unlock()

	f.taskMu.Lock()
	for _, task := range f.tasks {
		dto := task.snapshot()
		if dto.ID != id {
			continue
		}
		if dto.State != "running" && dto.State != "paused" && dto.State != "partial" {
			f.taskMu.Unlock()
			return false, errors.New("该任务当前不可终止")
		}
		task.stop()
		f.taskMu.Unlock()
		f.saveTasks()
		return true, nil
	}
	f.taskMu.Unlock()
	return false, errors.New("找不到任务")
}

// SyncCurrentChat starts the one-click flow for the last selected chat; the
// tray uses it without opening the window first.
func (f *Facade) SyncCurrentChat() (string, error) {
	list := f.a.listWorkspaces()
	if len(list) == 0 {
		return "", errors.New("还没有聊天，请先导入 result.json")
	}
	slug := selectedSlug(f.a.selectedWorkspace(list))
	if !fileExists(f.a.sourcePath(slug)) {
		return "", errors.New("该聊天只有官方导出，请先导入 result.json")
	}
	_, err := f.StartOneClick(slug)
	if err != nil {
		return "", err
	}
	return slug, nil
}

func (f *Facade) Running() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.op != nil
}

func (f *Facade) OpenLibrary(slug string) error {
	target := localFileURL(f.a.libraryIndex(), slug)
	return openInBrowser(target)
}

func (f *Facade) RevealChat(slug string) error {
	return openFolder(f.a.workspaceDir(slug))
}

func (f *Facade) RevealLogs() error {
	return osMkdirAndOpen(f.a.logsDir())
}

func osMkdirAndOpen(dir string) error {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	return openFolder(filepath.Clean(dir))
}
