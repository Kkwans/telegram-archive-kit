package main

import (
	"context"
	"crypto/sha1"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

//go:embed ui/*
var uiFS embed.FS

type App struct {
	ExeDir     string
	ConfigDir  string
	ConfigPath string
	Settings   Settings
}

func newApp() (*App, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	exeDir := filepath.Dir(exe)
	cfgBase, err := os.UserConfigDir()
	if err != nil || cfgBase == "" {
		home, _ := os.UserHomeDir()
		cfgBase = filepath.Join(home, "AppData", "Roaming")
	}
	cfgDir := filepath.Join(cfgBase, "TelegramArchiveKit")
	if err := os.MkdirAll(cfgDir, 0755); err != nil {
		return nil, err
	}
	a := &App{ExeDir: exeDir, ConfigDir: cfgDir, ConfigPath: filepath.Join(cfgDir, "config.json")}
	a.Settings = defaultSettings()
	_ = a.loadSettings()
	return a, nil
}

func (a *App) loadSettings() error {
	b, err := os.ReadFile(a.ConfigPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var s Settings
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	d := defaultSettings()
	if s.TdlNamespace == "" {
		s.TdlNamespace = d.TdlNamespace
	}
	if s.Concurrent <= 0 {
		s.Concurrent = d.Concurrent
	}
	if s.Threads <= 0 {
		s.Threads = d.Threads
	}
	if s.ReconnectTimeout == "" {
		s.ReconnectTimeout = d.ReconnectTimeout
	}
	if s.MaxRepairPasses <= 0 {
		s.MaxRepairPasses = d.MaxRepairPasses
	}
	if s.NetworkRetryMinutes <= 0 {
		s.NetworkRetryMinutes = d.NetworkRetryMinutes
	}
	if s.UnknownRetryCount < 0 {
		s.UnknownRetryCount = d.UnknownRetryCount
	}
	if s.StallTimeoutSeconds <= 0 {
		s.StallTimeoutSeconds = d.StallTimeoutSeconds
	}
	// v9.5 changes thumbnail generation back to ON by default. Earlier releases
	// defaulted it to false, so pre-9.5 configs would otherwise silently keep the
	// old behavior even after upgrading.
	if s.SchemaVersion < 95 {
		s.GenerateThumbnails = true
		s.AdaptiveConcurrency = false
		s.SchemaVersion = 95
	}
	if s.SchemaVersion < 98 {
		if s.StallTimeoutSeconds == 90 {
			s.StallTimeoutSeconds = 60
		}
		s.AdaptiveConcurrency = false
		s.SchemaVersion = 98
	}
	if s.SchemaVersion < 985 {
		s.StalledFileRetries = 3
		s.TransferAdjustment = "increase"
		s.AdaptiveConcurrency = false
		s.SchemaVersion = 985
	}
	if s.StalledFileRetries < 1 {
		s.StalledFileRetries = 3
	}
	if s.TransferAdjustment != "increase" && s.TransferAdjustment != "increase-both" && s.TransferAdjustment != "decrease" && s.TransferAdjustment != "keep" {
		s.TransferAdjustment = "increase"
	}
	if s.SchemaVersion == 0 {
		s.SchemaVersion = d.SchemaVersion
	}
	a.Settings = s
	return nil
}

func (a *App) saveSettings() error {
	b, _ := json.MarshalIndent(a.Settings, "", "  ")
	return os.WriteFile(a.ConfigPath, b, 0644)
}

func recommendedLibraryRoot() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Documents", "Telegram Archive Library")
}

func (a *App) ensureLibraryDirs() error {
	if strings.TrimSpace(a.Settings.LibraryRoot) == "" {
		return fmt.Errorf("尚未设置档案库目录")
	}
	for _, p := range []string{a.Settings.LibraryRoot, a.chatsDir(), a.runtimeDir(), a.logsDir()} {
		if err := os.MkdirAll(p, 0755); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) chatsDir() string     { return filepath.Join(a.Settings.LibraryRoot, "chats") }
func (a *App) runtimeDir() string   { return filepath.Join(a.Settings.LibraryRoot, ".runtime") }
func (a *App) logsDir() string      { return filepath.Join(a.Settings.LibraryRoot, ".logs") }
func (a *App) libraryIndex() string { return filepath.Join(a.Settings.LibraryRoot, "index.html") }

func (a *App) workspaceDir(slug string) string { return filepath.Join(a.chatsDir(), slug) }
func (a *App) sourcePath(slug string) string {
	return filepath.Join(a.workspaceDir(slug), "source", "result.json")
}
func (a *App) mediaDir(slug string) string { return filepath.Join(a.workspaceDir(slug), "media") }
func (a *App) dataDir(slug string) string  { return filepath.Join(a.workspaceDir(slug), "data") }
func (a *App) reportPath(slug string) string {
	return filepath.Join(a.workspaceDir(slug), "archive-report.json")
}
func (a *App) workspaceMetaPath(slug string) string {
	return filepath.Join(a.workspaceDir(slug), "workspace.json")
}

func readRawExport(path string) (RawExport, map[string]any, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return RawExport{}, nil, err
	}
	var raw RawExport
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return RawExport{}, nil, fmt.Errorf("不是有效的 Telegram result.json: %w", err)
	}
	if len(raw.Messages) == 0 {
		return RawExport{}, nil, fmt.Errorf("JSON 中没有 messages；请选择单个聊天导出的 result.json")
	}
	var root map[string]any
	dec2 := json.NewDecoder(strings.NewReader(string(b)))
	dec2.UseNumber()
	if err := dec2.Decode(&root); err != nil {
		return RawExport{}, nil, err
	}
	return raw, root, nil
}

func chatFromRaw(raw RawExport) Chat {
	name := strings.TrimSpace(raw.Name)
	if name == "" {
		name = "Telegram Archive"
	}
	return Chat{Name: name, Type: raw.Type, ID: anyString(raw.ID)}
}

func sanitizePathComponent(s string) string {
	var b strings.Builder
	lastSep := false
	for _, r := range strings.TrimSpace(s) {
		bad := r < 32 || strings.ContainsRune(`<>:"/\\|?*`, r)
		if bad || r == '\t' || r == '\r' || r == '\n' || r == ' ' {
			if !lastSep {
				b.WriteRune('_')
				lastSep = true
			}
			continue
		}
		b.WriteRune(r)
		lastSep = false
	}
	out := strings.Trim(strings.TrimSpace(b.String()), "._ ")
	if out == "" {
		return "Telegram"
	}
	runes := []rune(out)
	if len(runes) > 48 {
		out = string(runes[:48])
	}
	return out
}

func sanitizeASCII(s string) string {
	var b strings.Builder
	lastUnderscore := false
	for _, r := range s {
		ok := (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '-'
		if ok {
			b.WriteRune(r)
			lastUnderscore = false
		} else if !lastUnderscore {
			b.WriteByte('_')
			lastUnderscore = true
		}
	}
	return strings.Trim(b.String(), "_")
}

func stableSlug(chat Chat) string {
	name := sanitizePathComponent(chat.Name)
	id := strings.TrimSpace(chat.ID)
	if id != "" {
		clean := sanitizeASCII(id)
		if clean == "" {
			clean = shortHash(id)
		}
		return "chat_" + name + "__" + clean
	}
	return "chat_" + name + "__legacy_" + shortHash(chat.Name+"|"+chat.Type)
}

func shortHash(s string) string {
	h := sha1.Sum([]byte(s))
	return hex.EncodeToString(h[:])[:12]
}

func (a *App) findWorkspaceByChat(chat Chat) (string, bool) {
	entries, _ := os.ReadDir(a.chatsDir())
	// Strong identity first: Telegram chat ID.
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		m, err := a.readWorkspaceMeta(e.Name())
		if err != nil {
			continue
		}
		if chat.ID != "" && m.Chat.ID == chat.ID {
			return e.Name(), true
		}
	}
	// Official HTML exports do not expose the chat ID in a stable machine-readable
	// place. A provisional legacy workspace therefore joins a later full result.json
	// by exact chat name only when that workspace still has no ID.
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		m, err := a.readWorkspaceMeta(e.Name())
		if err != nil {
			continue
		}
		if m.Chat.ID == "" && strings.EqualFold(strings.TrimSpace(m.Chat.Name), strings.TrimSpace(chat.Name)) {
			return e.Name(), true
		}
		if chat.ID == "" && m.Chat.ID == "" && strings.EqualFold(m.Chat.Name, chat.Name) && (m.Chat.Type == chat.Type || m.Chat.Type == "" || chat.Type == "") {
			return e.Name(), true
		}
	}
	return stableSlug(chat), false
}

func (a *App) migrateWorkspaceSlug(oldSlug string, chat Chat) string {
	want := stableSlug(chat)
	if oldSlug == "" || oldSlug == want {
		return oldSlug
	}
	oldPath := a.workspaceDir(oldSlug)
	newPath := a.workspaceDir(want)
	if _, err := os.Stat(oldPath); err != nil {
		return oldSlug
	}
	if _, err := os.Stat(newPath); err == nil {
		return oldSlug
	}
	if err := os.Rename(oldPath, newPath); err != nil {
		return oldSlug
	}
	m, _ := a.readWorkspaceMeta(want)
	m.Slug = want
	m.Chat = chat
	_ = writeJSON(a.workspaceMetaPath(want), m)
	if a.Settings.LastWorkspaceSlug == oldSlug {
		a.Settings.LastWorkspaceSlug = want
		_ = a.saveSettings()
	}
	return want
}

func (a *App) importResultJSON(src string) (WorkspaceMeta, bool, error) {
	return a.importResultJSONMode(src, true)
}

// importResultJSONMode keeps the source-data import path cheap. earlier builds rebuilt the whole
// Viewer (including media scans / thumbnails / search pages) *inside* JSON import and
// then the one-click flow rebuilt it again after media sync. On a large archive that
// looked like a 20-40 second freeze. v9 can register/merge source data first and build
// exactly once after synchronization.
func (a *App) importResultJSONMode(src string, buildNow bool) (WorkspaceMeta, bool, error) {
	if err := a.ensureLibraryDirs(); err != nil {
		return WorkspaceMeta{}, false, err
	}
	src, _ = filepath.Abs(strings.Trim(src, `"`))
	raw, incomingRoot, err := readRawExport(src)
	if err != nil {
		return WorkspaceMeta{}, false, err
	}
	chat := chatFromRaw(raw)
	slug, existed := a.findWorkspaceByChat(chat)
	if existed {
		slug = a.migrateWorkspaceSlug(slug, chat)
	}
	ws := a.workspaceDir(slug)
	for _, p := range []string{filepath.Join(ws, "source"), filepath.Join(ws, "source", "history"), a.mediaDir(slug), a.dataDir(slug)} {
		if err := os.MkdirAll(p, 0755); err != nil {
			return WorkspaceMeta{}, existed, err
		}
	}

	stamp := time.Now().Format("20060102-150405") + fmt.Sprintf("-%09d", time.Now().Nanosecond())
	_ = copyFile(src, filepath.Join(ws, "source", "history", "import-"+stamp+".json"))

	dst := a.sourcePath(slug)
	var merged map[string]any
	if _, err := os.Stat(dst); err == nil {
		_, existingRoot, er := readRawExport(dst)
		if er == nil {
			merged = mergeExportRoots(existingRoot, incomingRoot)
			old, _ := os.ReadFile(dst)
			if len(old) > 0 {
				history := filepath.Join(ws, "source", "history", "aggregate-"+stamp+".json")
				_ = os.WriteFile(history, old, 0644)
			}
		}
	}
	if merged == nil {
		merged = incomingRoot
	}
	out, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return WorkspaceMeta{}, existed, err
	}
	if err := os.WriteFile(dst, out, 0644); err != nil {
		return WorkspaceMeta{}, existed, err
	}

	// Derive source metadata without walking media or generating HTML. Those expensive
	// operations belong to sync/build, not to the instant "I selected a JSON" action.
	var mergedRaw RawExport
	dec := json.NewDecoder(strings.NewReader(string(out)))
	dec.UseNumber()
	if err := dec.Decode(&mergedRaw); err != nil {
		return WorkspaceMeta{}, existed, err
	}
	now := time.Now()
	meta := WorkspaceMeta{Slug: slug, Chat: chatFromRaw(mergedRaw), ImportedAt: now, UpdatedAt: now, MessageCount: len(mergedRaw.Messages), SourceVersion: version}
	if old, er := a.readWorkspaceMeta(slug); er == nil {
		meta.ImportedAt = old.ImportedAt
		meta.MediaCount = old.MediaCount
		meta.MissingCount = old.MissingCount
		meta.OfficialExports = old.OfficialExports
		meta.ExternalStorage = old.ExternalStorage
		if meta.ImportedAt.IsZero() {
			meta.ImportedAt = now
		}
	}
	for _, rm := range mergedRaw.Messages {
		ts := rawMessageTS(rm)
		if ts <= 0 {
			continue
		}
		if meta.FirstTS == 0 || ts < meta.FirstTS {
			meta.FirstTS = ts
		}
		if ts > meta.LastTS {
			meta.LastTS = ts
		}
	}
	if err := writeJSON(a.workspaceMetaPath(slug), meta); err != nil {
		return WorkspaceMeta{}, existed, err
	}
	a.Settings.LastWorkspaceSlug = slug
	_ = a.saveSettings()
	if buildNow {
		if _, err := a.buildWorkspace(slug); err != nil {
			return WorkspaceMeta{}, existed, err
		}
		meta, _ = a.readWorkspaceMeta(slug)
	}
	return meta, existed, nil
}

func mergeExportRoots(oldRoot, newRoot map[string]any) map[string]any {
	merged := map[string]any{}
	for k, v := range oldRoot {
		merged[k] = v
	}
	for k, v := range newRoot {
		if k != "messages" {
			merged[k] = v
		}
	}
	byID := map[string]map[string]any{}
	orderless := make([]map[string]any, 0)
	add := func(root map[string]any, prefer bool) {
		arr, _ := root["messages"].([]any)
		for _, it := range arr {
			m, ok := it.(map[string]any)
			if !ok {
				continue
			}
			id := anyString(m["id"])
			if id == "" {
				orderless = append(orderless, m)
				continue
			}
			if _, exists := byID[id]; !exists || prefer {
				byID[id] = m
			}
		}
	}
	add(oldRoot, false)
	add(newRoot, true)
	msgs := make([]map[string]any, 0, len(byID)+len(orderless))
	for _, m := range byID {
		msgs = append(msgs, m)
	}
	msgs = append(msgs, orderless...)
	sort.SliceStable(msgs, func(i, j int) bool {
		ti := rawMessageTS(msgs[i])
		tj := rawMessageTS(msgs[j])
		if ti != tj {
			return ti < tj
		}
		ai, _ := strconv.ParseInt(anyString(msgs[i]["id"]), 10, 64)
		aj, _ := strconv.ParseInt(anyString(msgs[j]["id"]), 10, 64)
		return ai < aj
	})
	out := make([]any, len(msgs))
	for i := range msgs {
		out[i] = msgs[i]
	}
	merged["messages"] = out
	return merged
}

func rawMessageTS(m map[string]any) int64 {
	if n := anyInt64(m["date_unixtime"]); n > 0 {
		return n
	}
	return parseAnyTimestamp(nil, anyString(m["date"]))
}

func (a *App) readWorkspaceMeta(slug string) (WorkspaceMeta, error) {
	var m WorkspaceMeta
	b, err := os.ReadFile(a.workspaceMetaPath(slug))
	if err != nil {
		return m, err
	}
	err = json.Unmarshal(b, &m)
	return m, err
}

func (a *App) listWorkspaces() []WorkspaceMeta {
	var out []WorkspaceMeta
	entries, _ := os.ReadDir(a.chatsDir())
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		m, err := a.readWorkspaceMeta(e.Name())
		if err == nil {
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			return out[i].Chat.Name < out[j].Chat.Name
		}
		return out[i].UpdatedAt.After(out[j].UpdatedAt)
	})
	return out
}

func (a *App) buildArchiveForWorkspace(slug string) (*Archive, error) {
	return buildArchiveWithExtra(a.sourcePath(slug), a.mediaDir(slug), a.officialMediaByID(slug))
}

func (a *App) buildWorkspace(slug string) (*Archive, error) {
	return a.buildWorkspaceModeWithProgress(slug, true, nil)
}

func (a *App) buildWorkspaceMode(slug string, rebuildLibrary bool) (*Archive, error) {
	return a.buildWorkspaceModeWithProgress(slug, rebuildLibrary, nil)
}

func (a *App) buildWorkspaceModeWithProgress(slug string, rebuildLibrary bool, progress func(OperationProgress)) (*Archive, error) {
	return a.buildWorkspaceModeWithProgressCtx(context.Background(), slug, rebuildLibrary, progress)
}

func (a *App) buildWorkspaceModeWithProgressCtx(ctx context.Context, slug string, rebuildLibrary bool, progress func(OperationProgress)) (*Archive, error) {
	stage := func(n int, message, detail string) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		if progress != nil {
			progress(OperationProgress{Stage: fmt.Sprintf("步骤 %d/8 · %s", n, message), Detail: detail, Current: int64(n - 1), Total: 8, Unit: "阶段"})
		}
		return nil
	}
	if e := stage(1, "扫描媒体与旧官方归档", "读取聊天源数据、复用已有文件并校验媒体大小"); e != nil {
		return nil, e
	}
	if err := a.ensureLibraryDirs(); err != nil {
		return nil, err
	}
	jsonPath := a.sourcePath(slug)
	if _, err := os.Stat(jsonPath); err != nil {
		return nil, fmt.Errorf("找不到聊天源数据: %s", jsonPath)
	}
	arc, err := buildArchiveWithExtra(jsonPath, a.mediaDir(slug), a.officialMediaByID(slug))
	if err != nil {
		return nil, err
	}
	if e := stage(2, "图片/视频缩略图", "增量生成缺失封面；已缓存图片不会重复处理"); e != nil {
		return nil, e
	}
	// v9.5 restores local thumbnails as the default because they materially improve
	// timeline/gallery responsiveness. Generation is cached, background-priority and
	// reports progress to interactive callers, so the first build is visible rather
	// than looking frozen.
	if a.Settings.GenerateThumbnails {
		if findFFmpeg() == "" {
			if progress != nil {
				progress(OperationProgress{Stage: "步骤 2/8 · 自动安装视频预览引擎", Detail: "正在下载并校验 FFmpeg，安装完成后继续构建"})
			}
			if _, e := ensureFFmpegInstalled(ctx, func(done, total int64, phase string) {
				if progress != nil {
					progress(OperationProgress{Stage: phase, Detail: "FFmpeg 安装程序正在准备", Current: done, Total: total, Unit: "字节"})
				}
			}); e != nil {
				return nil, fmt.Errorf("无法为视频生成预览图：自动安装 FFmpeg 失败：%w", e)
			}
		}
		a.ensureImageThumbnailsProgressCtx(ctx, slug, arc, func(done, total int, name string) {
			if progress == nil {
				return
			}
			detail := "缓存图片及视频预览"
			if strings.TrimSpace(name) != "" {
				detail = truncatePlain(name, 72)
			}
			progress(OperationProgress{Stage: "步骤 2/8 · 正在生成图片及视频封面", Detail: fmt.Sprintf("%d/%d · %s", done, total, detail), Current: int64(done), Total: int64(total), Unit: "张"})
		})
	}
	if e := stage(3, "整理缩略图完整性", "记录不能解码的文件，以便稍后补齐"); e != nil {
		return nil, e
	}
	// A video can exist while its thumbnail is absent (e.g. ffmpeg not installed).
	// Expose that distinction rather than silently implying every video has a poster.
	arc.Stats.MissingVideoPreviews = 0
	arc.Stats.MissingImagePreviews = 0
	for _, m := range arc.Messages {
		for _, media := range m.Media {
			if media.Kind == "video" && media.Thumb == "" {
				arc.Stats.MissingVideoPreviews++
			}
			if media.Kind == "image" && media.Thumb == "" {
				arc.Stats.MissingImagePreviews++
			}
		}
	}
	if e := stage(4, "归档数据序列化", "生成供离线网页直接读取的数据文件"); e != nil {
		return nil, e
	}
	if err := os.MkdirAll(a.dataDir(slug), 0755); err != nil {
		return nil, err
	}
	payload, err := json.Marshal(arc)
	if err != nil {
		return nil, err
	}
	js := append([]byte("window.__TAK_CHAT_DATA__ = "), payload...)
	js = append(js, []byte(";\n")...)
	if err := os.WriteFile(filepath.Join(a.dataDir(slug), "archive-data.js"), js, 0644); err != nil {
		return nil, err
	}
	if e := stage(5, "全文搜索索引", "整理消息内容与文件名以支持本地搜索"); e != nil {
		return nil, e
	}
	if err := a.writeSearchIndex(slug, arc); err != nil {
		return nil, err
	}
	if e := stage(6, "全量日期与分页索引", "建立跨页日期导航及消息 ID 到分页的映射"); e != nil {
		return nil, e
	}
	if err := a.writeDateIndex(slug, arc); err != nil {
		return nil, err
	}
	if e := stage(7, "生成聊天 HTML 页面", "使用 telegram-export-beautifier 的消息视图，保留分页与媒体灯箱"); e != nil {
		return nil, e
	}
	if err := a.buildBeautifierPages(slug, arc); err != nil {
		return nil, err
	}
	if e := stage(8, "保存统计与归档报告", "写入完整性结果并刷新档案库元数据"); e != nil {
		return nil, e
	}
	report := reportFromArchive(arc)
	if err := writeJSON(a.reportPath(slug), report); err != nil {
		return nil, err
	}
	first, last := archiveTimeRange(arc)
	meta, _ := a.readWorkspaceMeta(slug)
	if meta.Slug == "" {
		meta.Slug = slug
		meta.ImportedAt = time.Now()
	}
	meta.Chat = arc.Chat
	meta.UpdatedAt = time.Now()
	meta.MessageCount = arc.Stats.Messages
	meta.MediaCount = arc.Stats.MediaFiles
	meta.MissingCount = arc.Stats.MissingMedia
	meta.FirstTS = first
	meta.LastTS = last
	meta.SourceVersion = version
	_ = writeJSON(a.workspaceMetaPath(slug), meta)
	if err := a.writeWorkspaceRedirect(slug); err != nil {
		return nil, err
	}
	if rebuildLibrary {
		if err := a.buildLibrary(); err != nil {
			return nil, err
		}
	}
	if progress != nil {
		progress(OperationProgress{Stage: "归档构建完成", Detail: fmt.Sprintf("%d 条消息 · %d 个媒体 · 缺失 %d", arc.Stats.Messages, arc.Stats.MediaFiles, arc.Stats.MissingMedia), Current: 8, Total: 8, Unit: "阶段"})
	}
	return arc, nil
}

func (a *App) writeWorkspaceRedirect(slug string) error {
	html := `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Telegram Archive</title><script>location.replace('messages.html')</script><p><a href="messages.html">打开聊天归档</a></p>`
	return os.WriteFile(filepath.Join(a.workspaceDir(slug), "index.html"), []byte(html), 0644)
}

func formatMetaTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}

func (a *App) buildLibrary() error {
	if err := a.ensureLibraryDirs(); err != nil {
		return err
	}
	if err := a.ensureBeautifierAssets(nil); err != nil {
		return err
	}
	for _, name := range []string{"index.html", "favicon.svg", "favicon.ico", "app.css", "app.js", "tak-lightbox.css", "tak-lightbox.js", "tak-prelude.js", "tak-bridge.css", "tak-bridge.js"} {
		b, err := fs.ReadFile(uiFS, "ui/"+name)
		if err != nil {
			return err
		}
		dst := filepath.Join(a.Settings.LibraryRoot, name)
		if name != "index.html" && name != "favicon.svg" && name != "favicon.ico" {
			assets := filepath.Join(a.Settings.LibraryRoot, "assets")
			if err := os.MkdirAll(assets, 0755); err != nil {
				return err
			}
			dst = filepath.Join(assets, name)
		}
		if err := os.WriteFile(dst, b, 0644); err != nil {
			return err
		}
	}
	manifest := LibraryManifest{SchemaVersion: schemaVersion, Generator: "TelegramArchiveKit/" + version, GeneratedAt: time.Now().Format(time.RFC3339)}
	for _, meta := range a.listWorkspaces() {
		lc := LibraryChat{Slug: meta.Slug, Name: meta.Chat.Name, Type: meta.Chat.Type, ID: meta.Chat.ID, Messages: meta.MessageCount, MediaFiles: meta.MediaCount, Missing: meta.MissingCount, FirstTS: meta.FirstTS, LastTS: meta.LastTS, ImportedAt: formatMetaTime(meta.ImportedAt), UpdatedAt: formatMetaTime(meta.UpdatedAt), FolderName: meta.Slug, OfficialExports: len(meta.OfficialExports), DataScript: "chats/" + meta.Slug + "/data/archive-data.js", SourceRel: "chats/" + meta.Slug + "/source/result.json", ReportRel: "chats/" + meta.Slug + "/archive-report.json", WorkspaceRel: "chats/" + meta.Slug + "/", MessagesRel: "chats/" + meta.Slug + "/messages.html"}
		if !fileExists(a.sourcePath(meta.Slug)) {
			lc.SourceRel = ""
			lc.DataScript = ""
			lc.ReportRel = ""
			if rel := a.primaryOfficialMessagesRel(meta.Slug); rel != "" {
				lc.MessagesRel = rel
			}
		}
		var rep Report
		if b, err := os.ReadFile(a.reportPath(meta.Slug)); err == nil && json.Unmarshal(b, &rep) == nil {
			lc.Messages = rep.Stats.Messages
			lc.MediaFiles = rep.Stats.MediaFiles
			lc.Images = rep.Stats.Images
			lc.Videos = rep.Stats.Videos
			lc.Audio = rep.Stats.Audio
			lc.Files = rep.Stats.Files
			lc.Missing = rep.Stats.MissingMedia
		}
		// Count actual generated pagination files rather than guessing from the
		// number of Telegram messages (album groups can reduce visible rows).
		if pages, err := os.ReadDir(a.workspaceDir(meta.Slug)); err == nil {
			for _, entry := range pages {
				n := strings.ToLower(entry.Name())
				if !entry.IsDir() && (n == "messages.html" || (strings.HasPrefix(n, "messages") && strings.HasSuffix(n, ".html") && len(n) > len("messages.html"))) {
					lc.Pages++
				}
			}
		}
		manifest.Chats = append(manifest.Chats, lc)
	}
	b, _ := json.Marshal(manifest)
	js := append([]byte("window.__TAK_LIBRARY__ = "), b...)
	js = append(js, []byte(";\n")...)
	if err := os.WriteFile(filepath.Join(a.Settings.LibraryRoot, "library-data.js"), js, 0644); err != nil {
		return err
	}
	return writeJSON(filepath.Join(a.Settings.LibraryRoot, "library.json"), manifest)
}

func (a *App) generateMissingJSON(slug string) (int, string, error) {
	arc, err := a.buildArchiveForWorkspace(slug)
	if err != nil {
		return 0, "", err
	}
	missing := map[string]bool{}
	for _, id := range arc.Missing {
		missing[id] = true
	}
	if len(missing) == 0 {
		return 0, "", nil
	}
	b, err := os.ReadFile(a.sourcePath(slug))
	if err != nil {
		return 0, "", err
	}
	var root map[string]any
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.UseNumber()
	if err := dec.Decode(&root); err != nil {
		return 0, "", err
	}
	arr, _ := root["messages"].([]any)
	filtered := make([]any, 0, len(missing))
	for _, item := range arr {
		m, ok := item.(map[string]any)
		if ok && missing[anyString(m["id"])] {
			filtered = append(filtered, item)
		}
	}
	root["messages"] = filtered
	out, _ := json.MarshalIndent(root, "", "  ")
	work := filepath.Join(a.runtimeDir(), "work", slug)
	if err := os.MkdirAll(work, 0755); err != nil {
		return 0, "", err
	}
	path := filepath.Join(work, "missing.json")
	if err := os.WriteFile(path, out, 0644); err != nil {
		return 0, "", err
	}
	return len(filtered), path, nil
}

func (a *App) verifyWorkspace(slug string) (*Archive, error) {
	return a.buildArchiveForWorkspace(slug)
}

func (a *App) deleteWorkspace(slug string) error {
	if slug == "" {
		return nil
	}
	if err := os.RemoveAll(a.workspaceDir(slug)); err != nil {
		return err
	}
	if a.Settings.LastWorkspaceSlug == slug {
		a.Settings.LastWorkspaceSlug = ""
		_ = a.saveSettings()
	}
	return a.buildLibrary()
}

func writeJSON(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0644)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func (a *App) removeZeroByteMedia(slug string) int {
	count := 0
	_ = filepath.WalkDir(a.mediaDir(slug), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, er := d.Info(); er == nil && info.Size() == 0 {
			if os.Remove(path) == nil {
				count++
			}
		}
		return nil
	})
	return count
}

// estimateMissingMedia reports the number of currently missing media messages and the
// sum of file_size values available in result.json. Telegram JSON does not always carry
// file_size, so knownCount/knownBytes are explicitly partial estimates.
func (a *App) estimateMissingMedia(slug string) (count int, knownCount int, knownBytes int64, err error) {
	arc, err := a.buildArchiveForWorkspace(slug)
	if err != nil {
		return 0, 0, 0, err
	}
	missing := make(map[string]bool, len(arc.Missing))
	for _, id := range arc.Missing {
		missing[id] = true
	}
	for _, m := range arc.Messages {
		if !missing[m.ID] {
			continue
		}
		count++
		if m.ExpectedSize > 0 {
			knownCount++
			knownBytes += m.ExpectedSize
		}
	}
	return count, knownCount, knownBytes, nil
}

func (a *App) normalizeWorkspaceSlugs() bool {
	changed := false
	entries, _ := os.ReadDir(a.chatsDir())
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		m, err := a.readWorkspaceMeta(e.Name())
		if err != nil || strings.TrimSpace(m.Chat.Name) == "" {
			continue
		}
		want := stableSlug(m.Chat)
		if want == e.Name() {
			continue
		}
		if _, err := os.Stat(a.workspaceDir(want)); err == nil {
			continue
		}
		if err := os.Rename(a.workspaceDir(e.Name()), a.workspaceDir(want)); err != nil {
			continue
		}
		m.Slug = want
		_ = writeJSON(a.workspaceMetaPath(want), m)
		if a.Settings.LastWorkspaceSlug == e.Name() {
			a.Settings.LastWorkspaceSlug = want
		}
		changed = true
	}
	if changed {
		_ = a.saveSettings()
		_ = a.buildLibrary()
	}
	return changed
}
