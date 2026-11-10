package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"telegramarchivekit/internal/archive"
	"telegramarchivekit/internal/media"
	"telegramarchivekit/internal/platform"
	"telegramarchivekit/internal/transfer"
)

type OfficialMetaDTO struct {
	Name          string `json:"name"`
	Root          string `json:"root"`
	Mode          string `json:"mode"`
	MessageCount  int    `json:"messageCount"`
	MediaMessages int    `json:"mediaMessages"`
	MediaFiles    int    `json:"mediaFiles"`
	Images        int    `json:"images"`
	Videos        int    `json:"videos"`
	Audio         int    `json:"audio"`
	Files         int    `json:"files"`
	TotalBytes    int64  `json:"totalBytes"`
	FirstID       string `json:"firstId,omitempty"`
	LastID        string `json:"lastId,omitempty"`
}

type OfficialPreviewDTO struct {
	Meta      OfficialMetaDTO `json:"meta"`
	MatchSlug string          `json:"matchSlug,omitempty"`
	Chats     []ChatDTO       `json:"chats"`
}

type StatsDTO struct {
	Messages      int `json:"messages"`
	Media         int `json:"media"`
	Images        int `json:"images"`
	Videos        int `json:"videos"`
	Audio         int `json:"audio"`
	Files         int `json:"files"`
	Missing       int `json:"missing"`
	MissingImages int `json:"missingImages"`
	MissingVideos int `json:"missingVideos"`
}

// BackfillPreviewDTO describes what "按 result.json 补全" would download. It is
// computed read-only so the UI can warn about disk space before a task exists.
type BackfillPreviewDTO struct {
	Slug       string `json:"slug"`
	Chat       string `json:"chat"`
	Messages   int    `json:"messages"`
	Media      int    `json:"media"`
	Missing    int    `json:"missing"`
	KnownCount int    `json:"knownCount"`
	KnownBytes int64  `json:"knownBytes"`
	Images     int    `json:"images"`
	Videos     int    `json:"videos"`
	Audio      int    `json:"audio"`
	Files      int    `json:"files"`
	Other      int    `json:"other"`
	FreeBytes  int64  `json:"freeBytes"`
	SpaceShort bool   `json:"spaceShort"`
}

const downloadSpaceReserve = int64(256 << 20)

func (f *Facade) PreviewBackfill(slug string) (BackfillPreviewDTO, error) {
	if strings.TrimSpace(slug) == "" {
		return BackfillPreviewDTO{}, errors.New("缺少聊天标识")
	}
	meta, err := f.a.readWorkspaceMeta(slug)
	if err != nil {
		return BackfillPreviewDTO{}, fmt.Errorf("读取聊天失败: %w", err)
	}
	plan, arc, err := f.a.estimateMissingPlan(slug)
	if err != nil {
		return BackfillPreviewDTO{}, err
	}
	out := BackfillPreviewDTO{
		Slug: slug, Chat: meta.Chat.Name,
		Missing: plan.Total, KnownCount: plan.KnownCount, KnownBytes: plan.KnownBytes,
		Images: plan.Images, Videos: plan.Videos, Audio: plan.Audio,
		Files: plan.Files, Other: plan.Other,
	}
	if arc != nil {
		out.Messages = arc.Stats.Messages
		out.Media = arc.Stats.MediaFiles
	}
	comp := f.effectivePlanComposition(slug, plan.Total, out.Images, out.Videos, out.Audio, out.Files)
	comp = normalizePlanComposition(comp, plan.Total)
	out.Images, out.Videos, out.Audio, out.Files = comp[0], comp[1], comp[2], comp[3]
	out.FreeBytes = int64(platform.FreeSpaceBytes(f.a.workspaceDir(slug)))
	out.SpaceShort = out.FreeBytes > 0 && out.KnownBytes > 0 && out.FreeBytes < out.KnownBytes+downloadSpaceReserve
	return out, nil
}

// BulkPreviewDTO is the combined download estimate for "同步全部缺失".
type BulkPreviewDTO struct {
	Chats      int   `json:"chats"`
	Missing    int   `json:"missing"`
	KnownBytes int64 `json:"knownBytes"`
	Images     int   `json:"images"`
	Videos     int   `json:"videos"`
	Audio      int   `json:"audio"`
	Files      int   `json:"files"`
	Other      int   `json:"other"`
	FreeBytes  int64 `json:"freeBytes"`
	SpaceShort bool  `json:"spaceShort"`
}

func (f *Facade) PreviewSyncAll() (BulkPreviewDTO, error) {
	var out BulkPreviewDTO
	for _, c := range f.ListChats() {
		if c.Missing <= 0 {
			continue
		}
		plan, _, err := f.a.estimateMissingPlan(c.Slug)
		if err != nil || plan.Total == 0 {
			continue
		}
		out.Chats++
		out.Missing += plan.Total
		out.KnownBytes += plan.KnownBytes
		out.Images += plan.Images
		out.Videos += plan.Videos
		out.Audio += plan.Audio
		out.Files += plan.Files
		out.Other += plan.Other
	}
	comp := normalizePlanComposition([4]int{out.Images, out.Videos, out.Audio, out.Files}, out.Missing)
	out.Images, out.Videos, out.Audio, out.Files = comp[0], comp[1], comp[2], comp[3]
	out.FreeBytes = int64(platform.FreeSpaceBytes(f.a.Settings.LibraryRoot))
	out.SpaceShort = out.FreeBytes > 0 && out.KnownBytes > 0 && out.FreeBytes < out.KnownBytes+downloadSpaceReserve
	return out, nil
}

type SettingsDTO struct {
	LibraryRoot           string  `json:"libraryRoot"`
	Concurrent            int     `json:"concurrent"`
	Threads               int     `json:"threads"`
	Proxy                 string  `json:"proxy"`
	NetworkRetryMinutes   int     `json:"networkRetryMinutes"`
	UnknownRetryCount     int     `json:"unknownRetryCount"`
	GenerateThumbnails    bool    `json:"generateThumbnails"`
	StallTimeoutSeconds   int     `json:"stallTimeoutSeconds"`
	StalledFileRetries    int     `json:"stalledFileRetries"`
	TransferAdjustment    string  `json:"transferAdjustment"`
	ReconnectTimeout      string  `json:"reconnectTimeout"`
	MaxRepairPasses       int     `json:"maxRepairPasses"`
	OpenAfterBuild        bool    `json:"openAfterBuild"`
	TdlNamespace          string  `json:"tdlNamespace"`
	VideoSeekSeconds      int     `json:"videoSeekSeconds"`
	VideoLongPressRate    float64 `json:"videoLongPressRate"`
	VideoLongPressDelayMS int     `json:"videoLongPressDelayMs"`
	VideoMaxVolume        int     `json:"videoMaxVolume"`
	VideoVolumeStep       int     `json:"videoVolumeStep"`
	VideoFrameAspect      string  `json:"videoFrameAspect"`
	SpeedWindowSeconds    int     `json:"speedWindowSeconds"`
	ViewerBackdrop        string  `json:"viewerBackdrop"`
	ToastSeconds          int     `json:"toastSeconds"`
	Version               string  `json:"version"`
}

type DiagRow struct {
	Label string `json:"label"`
	Value string `json:"value"`
	State string `json:"state"` // ok | warn | error
}

type LogInfo struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"`
}

func (f *Facade) ImportJSONFiles(paths []string) ([]ChatDTO, error) {
	if len(paths) == 0 {
		return nil, errors.New("没有选择文件")
	}
	var lastErr error
	ok := 0
	for _, p := range paths {
		if _, _, err := f.a.importResultJSONMode(p, false); err != nil {
			lastErr = fmt.Errorf("%s: %w", filepath.Base(p), err)
			continue
		}
		ok++
	}
	if ok == 0 && lastErr != nil {
		return nil, lastErr
	}
	if err := f.a.buildLibrary(); err != nil {
		return nil, err
	}
	return f.ListChats(), lastErr
}

func (f *Facade) AnalyzeOfficial(folder string) (OfficialPreviewDTO, error) {
	meta, _, err := archive.AnalyzeOfficialExport(folder, f.a.Settings.LibraryRoot, "referenced")
	if err != nil {
		return OfficialPreviewDTO{}, err
	}
	out := OfficialPreviewDTO{
		Meta: OfficialMetaDTO{
			Name: meta.Name, Root: meta.Root, Mode: meta.Mode,
			MessageCount: meta.MessageCount, MediaMessages: meta.MediaMessages, MediaFiles: meta.MediaFiles,
			Images: meta.Images, Videos: meta.Videos, Audio: meta.Audio, Files: meta.Files, TotalBytes: meta.TotalBytes,
			FirstID: meta.FirstMessageID, LastID: meta.LastMessageID,
		},
		Chats: f.ListChats(),
	}
	for _, m := range f.a.listWorkspaces() {
		if strings.EqualFold(strings.TrimSpace(m.Chat.Name), strings.TrimSpace(meta.Name)) {
			out.MatchSlug = m.Slug
			break
		}
	}
	return out, nil
}

func (f *Facade) ImportOfficial(folder, slug, mode string) (ChatDTO, error) {
	return f.importOfficial(folder, slug, mode, nil, nil)
}

func (f *Facade) importOfficial(folder, slug, mode string, onMeta func(archive.OfficialExportMeta), progress func(OperationProgress)) (ChatDTO, error) {
	if st, err := os.Stat(folder); err != nil || !st.IsDir() {
		return ChatDTO{}, errors.New("所选目录无效")
	}
	meta, _, err := archive.AnalyzeOfficialExport(folder, f.a.Settings.LibraryRoot, "referenced")
	if err != nil {
		return ChatDTO{}, err
	}
	if onMeta != nil {
		onMeta(meta)
	}
	if strings.TrimSpace(slug) == "" {
		m, err := f.a.ensureProvisionalWorkspace(meta.Name, meta.LastTS)
		if err != nil {
			return ChatDTO{}, err
		}
		slug = m.Slug
	}
	switch mode {
	case "reference":
		if progress != nil {
			progress(OperationProgress{Stage: "登记官方导出", Detail: "引用原目录，不复制文件", Percent: 20})
		}
		if _, err := f.a.registerOfficialExport(slug, folder, "referenced"); err != nil {
			return ChatDTO{}, err
		}
	case "copy":
		dst := f.a.managedOfficialRoot(slug, meta.Name)
		if progress != nil {
			progress(OperationProgress{Stage: "正在复制导出文件", Detail: "准备复制 " + humanBytes(meta.TotalBytes), Percent: 10})
		}
		if _, err := transfer.DirIncremental(context.Background(), folder, dst, false, func(p transfer.Progress) {
			if progress == nil {
				return
			}
			pct := 10
			if p.BytesTotal > 0 {
				pct = 10 + int(p.BytesDone*68/p.BytesTotal)
				if pct > 78 {
					pct = 78
				}
			}
			detail := fmt.Sprintf("已复制 %s / %s · %d/%d 个文件", humanBytes(p.BytesDone), humanBytes(p.BytesTotal), p.FilesDone, p.FilesTotal)
			if p.Current != "" && p.FilesTotal <= 200 {
				detail = fmt.Sprintf("已复制 %s / %s · %s", humanBytes(p.BytesDone), humanBytes(p.BytesTotal), truncatePlain(p.Current, 60))
			}
			progress(OperationProgress{
				Stage: "正在复制导出文件", Detail: detail,
				Current: p.BytesDone, Total: p.BytesTotal, Unit: "字节",
				Percent: pct, FilesDone: p.FilesDone, FilesTotal: p.FilesTotal,
			})
		}); err != nil {
			return ChatDTO{}, err
		}
		if _, err := f.a.registerOfficialExport(slug, dst, "copied"); err != nil {
			return ChatDTO{}, err
		}
	case "move", "managed":
		dst := f.a.managedOfficialRoot(slug, meta.Name)
		if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
			return ChatDTO{}, err
		}
		if progress != nil {
			progress(OperationProgress{Stage: "正在纳管导出目录", Detail: "同盘快速移动，不复制媒体", Percent: 20})
		}
		if err := os.Rename(folder, dst); err != nil {
			return ChatDTO{}, fmt.Errorf("无法直接纳管（通常因为源目录与档案库不在同一磁盘）：请改用“复制”模式。%v", err)
		}
		if _, err := f.a.registerOfficialExport(slug, dst, "managed"); err != nil {
			return ChatDTO{}, err
		}
	default:
		return ChatDTO{}, errors.New("未知的导入模式")
	}

	// Official HTML exports do not carry result.json, so populate the library
	// metadata directly; otherwise the imported chat looks empty in chat lists.
	wm, _ := f.a.readWorkspaceMeta(slug)
	if wm.Chat.Name == "" {
		wm.Chat.Name = meta.Name
	}
	wm.MessageCount = meta.MessageCount
	wm.MediaCount = meta.MediaFiles
	wm.FirstTS = meta.FirstTS
	wm.LastTS = meta.LastTS
	wm.UpdatedAt = time.Now()
	if wm.Slug == "" {
		wm.Slug = slug
	}
	_ = writeJSON(f.a.workspaceMetaPath(slug), wm)

	// Official-only workspaces can now build thumbnails and pages from their
	// messages.html. Do the full build here so an import immediately shows covers
	// and a browsable archive instead of an empty shell.
	if fileExists(f.a.sourcePath(slug)) || f.a.hasOfficialExport(slug) {
		buildProgress := progress
		if progress != nil {
			buildProgress = func(p OperationProgress) {
				if p.Percent <= 0 && p.Total > 0 {
					p.Percent = 80 + int(p.Current*18/p.Total)
					if p.Percent > 98 {
						p.Percent = 98
					}
				}
				progress(p)
			}
		}
		if _, err := f.a.buildWorkspaceModeWithProgressCtx(context.Background(), slug, true, buildProgress); err != nil {
			return ChatDTO{}, err
		}
	} else if err := f.a.buildLibrary(); err != nil {
		return ChatDTO{}, err
	}
	for _, c := range f.ListChats() {
		if c.Slug == slug {
			return c, nil
		}
	}
	return ChatDTO{}, nil
}

func (f *Facade) EnsureOfficialSource(slug string) error {
	_, err := f.a.ensureOfficialSource(slug)
	return err
}

// BindChatIdentity attaches the live Telegram id/name to an official-imported
// workspace before an online export, so the new result.json merges into it
// instead of creating a duplicate chat.
func (f *Facade) BindChatIdentity(slug, id, name, chatType string) error {
	if strings.TrimSpace(slug) == "" || slug != filepath.Base(slug) {
		return errors.New("无效的聊天标识")
	}
	meta, err := f.a.readWorkspaceMeta(slug)
	if err != nil {
		return err
	}
	if id = strings.TrimSpace(id); id != "" {
		meta.Chat.ID = id
	}
	if name = strings.TrimSpace(name); name != "" {
		meta.Chat.Name = name
	}
	if chatType = strings.TrimSpace(chatType); chatType != "" {
		meta.Chat.Type = chatType
	}
	meta.UpdatedAt = time.Now()
	return writeJSON(f.a.workspaceMetaPath(slug), meta)
}

func (f *Facade) DeleteChat(slug string) error {
	return f.a.deleteWorkspace(slug)
}

func (f *Facade) VerifyChat(slug string) (StatsDTO, error) {
	arc, err := f.a.verifyWorkspace(slug)
	if err != nil {
		return StatsDTO{}, err
	}
	s := arc.Stats
	return StatsDTO{
		Messages: s.Messages, Media: s.MediaFiles, Images: s.Images, Videos: s.Videos,
		Audio: s.Audio, Files: s.Files, Missing: s.MissingMedia,
		MissingImages: s.MissingImagePreviews, MissingVideos: s.MissingVideoPreviews,
	}, nil
}

func (f *Facade) RefreshWeb(slug string) error {
	// A failed download can end before the viewer data and thumbnails are
	// written. Rebuilding from source handles both cases and fills missing
	// video covers instead of only re-rendering an old data file.
	_, err := f.a.buildWorkspaceModeWithProgressCtx(context.Background(), slug, true, nil)
	return err
}

func (f *Facade) RefreshAllWeb() (ok, skipped int, err error) {
	var failures []string
	for _, m := range f.a.listWorkspaces() {
		if !fileExists(filepath.Join(f.a.dataDir(m.Slug), "archive-data.js")) {
			skipped++
			continue
		}
		if e := f.a.refreshWorkspaceWeb(m.Slug); e != nil {
			failures = append(failures, m.Chat.Name)
			continue
		}
		ok++
	}
	if err := f.a.buildLibrary(); err != nil {
		return ok, skipped, err
	}
	if len(failures) > 0 {
		return ok, skipped, fmt.Errorf("%d 个聊天重建失败：%s", len(failures), strings.Join(failures, "、"))
	}
	return ok, skipped, nil
}

func (f *Facade) ExportChat(slug, dstRoot string) error {
	if strings.TrimSpace(dstRoot) == "" {
		return errors.New("缺少目标档案库目录")
	}
	if strings.EqualFold(filepath.Clean(dstRoot), filepath.Clean(f.a.Settings.LibraryRoot)) {
		return errors.New("目标与当前档案库相同")
	}
	dst := appAtLibrary(f.a, dstRoot)
	if err := dst.ensureLibraryDirs(); err != nil {
		return err
	}
	if _, err := dst.copyChatFromLibrary(f.a.Settings.LibraryRoot, slug); err != nil {
		return err
	}
	return dst.buildLibrary()
}

func (f *Facade) SwitchLibrary(root string) error {
	if strings.TrimSpace(root) == "" {
		return errors.New("缺少档案库目录")
	}
	lock, err := acquireSessionLock(root)
	if err != nil {
		return err
	}
	old := f.a.Settings.LibraryRoot
	f.a.rememberLibrary(old)
	f.a.Settings.LibraryRoot = root
	f.a.rememberLibrary(root)
	if err := f.a.ensureLibraryDirs(); err != nil {
		f.a.Settings.LibraryRoot = old
		lock.release()
		return err
	}
	if remote, kind := platform.NetworkPathKind(root); remote {
		f.a.Settings.LastRemoteRoot = root
		f.a.Settings.LastRemoteKind = kind
	}
	if err := f.a.saveSettings(); err != nil {
		lock.release()
		return err
	}
	if err := f.a.buildLibrary(); err != nil {
		lock.release()
		return err
	}
	f.mu.Lock()
	oldLock := f.libLock
	f.libLock = lock
	f.mu.Unlock()
	oldLock.release()
	return nil
}

func (f *Facade) MergeLibrary(srcRoot string) (int, int, error) {
	srcRoot = strings.TrimSpace(srcRoot)
	if srcRoot == "" {
		return 0, 0, errors.New("缺少源档案库目录")
	}
	if strings.EqualFold(filepath.Clean(srcRoot), filepath.Clean(f.a.Settings.LibraryRoot)) {
		return 0, 0, errors.New("不能把档案库与自身合并")
	}
	if !looksLikeLibrary(srcRoot) {
		return 0, 0, errors.New("所选目录不是 TelegramArchiveKit 档案库")
	}
	slugs := librarySourceChats(srcRoot)
	if len(slugs) == 0 {
		return 0, 0, errors.New("源档案库没有可合并的聊天")
	}
	ok := 0
	for _, slug := range slugs {
		if _, err := f.a.copyChatFromLibrary(srcRoot, slug); err != nil {
			continue
		}
		ok++
	}
	if err := f.a.buildLibrary(); err != nil {
		return ok, len(slugs), err
	}
	f.a.rememberLibrary(srcRoot)
	return ok, len(slugs), nil
}

func (f *Facade) GetSettings() SettingsDTO {
	s := f.a.Settings
	return SettingsDTO{
		LibraryRoot: s.LibraryRoot, Concurrent: s.Concurrent, Threads: s.Threads,
		Proxy: s.Proxy, NetworkRetryMinutes: s.NetworkRetryMinutes, UnknownRetryCount: s.UnknownRetryCount,
		GenerateThumbnails: s.GenerateThumbnails, StallTimeoutSeconds: s.StallTimeoutSeconds,
		StalledFileRetries: s.StalledFileRetries, TransferAdjustment: s.TransferAdjustment,
		ReconnectTimeout: s.ReconnectTimeout, MaxRepairPasses: s.MaxRepairPasses,
		OpenAfterBuild: s.OpenAfterBuild, TdlNamespace: s.TdlNamespace,
		VideoSeekSeconds: s.VideoSeekSeconds, VideoLongPressRate: s.VideoLongPressRate, VideoLongPressDelayMS: s.VideoLongPressDelayMS,
		VideoMaxVolume: s.VideoMaxVolume, VideoVolumeStep: s.VideoVolumeStep, VideoFrameAspect: s.VideoFrameAspect, SpeedWindowSeconds: s.SpeedWindowSeconds,
		ViewerBackdrop: s.ViewerBackdrop,
		ToastSeconds:   toastSecondsOrDefault(s.ToastSeconds),
		Version:        version,
	}
}

func toastSecondsOrDefault(v int) int {
	if v < 1 || v > 10 {
		return 3
	}
	return v
}

func (f *Facade) SetSettings(dto SettingsDTO) (SettingsDTO, error) {
	if dto.Concurrent < 1 || dto.Concurrent > 8 {
		return f.GetSettings(), errors.New("并发文件任务需在 1–8 之间")
	}
	if dto.Threads < 1 || dto.Threads > 16 {
		return f.GetSettings(), errors.New("单文件线程需在 1–16 之间")
	}
	if dto.NetworkRetryMinutes < 1 || dto.NetworkRetryMinutes > 180 {
		return f.GetSettings(), errors.New("网络恢复窗口需在 1–180 分钟之间")
	}
	if dto.UnknownRetryCount < 0 || dto.UnknownRetryCount > 10 {
		return f.GetSettings(), errors.New("未知错误重试需在 0–10 次之间")
	}
	if dto.StallTimeoutSeconds < 30 || dto.StallTimeoutSeconds > 600 {
		return f.GetSettings(), errors.New("无进展阈值需在 30–600 秒之间")
	}
	if dto.StalledFileRetries < 1 || dto.StalledFileRetries > 10 {
		return f.GetSettings(), errors.New("疑难文件重试需在 1–10 次之间")
	}
	switch dto.TransferAdjustment {
	case "increase", "increase-both", "decrease", "keep":
	default:
		return f.GetSettings(), errors.New("未知的重试传输策略")
	}
	if dto.VideoSeekSeconds < 1 || dto.VideoSeekSeconds > 60 {
		return f.GetSettings(), errors.New("视频快进步长需在 1–60 秒之间")
	}
	if dto.VideoLongPressRate < 1.1 || dto.VideoLongPressRate > 10 {
		return f.GetSettings(), errors.New("长按倍速需在 1.1–10.0 之间")
	}
	if dto.VideoLongPressDelayMS < 150 || dto.VideoLongPressDelayMS > 1000 {
		return f.GetSettings(), errors.New("长按触发时间需在 150–1000 毫秒之间")
	}
	if dto.VideoMaxVolume < 100 || dto.VideoMaxVolume > 300 {
		return f.GetSettings(), errors.New("音量上限需在 100–300% 之间")
	}
	if dto.VideoVolumeStep < 1 || dto.VideoVolumeStep > 50 {
		return f.GetSettings(), errors.New("音量步进需在 1–50% 之间")
	}
	switch dto.VideoFrameAspect {
	case "original", "16:9", "4:3":
	default:
		return f.GetSettings(), errors.New("未知的视频容器比例")
	}
	if dto.SpeedWindowSeconds < 60 || dto.SpeedWindowSeconds > 900 {
		return f.GetSettings(), errors.New("速度曲线时间窗需在 60–900 秒之间")
	}
	switch dto.ViewerBackdrop {
	case "ambient", "frosted", "solid":
	default:
		return f.GetSettings(), errors.New("未知的查看器背景模式")
	}
	if dto.ToastSeconds < 1 || dto.ToastSeconds > 10 {
		return f.GetSettings(), errors.New("通知停留时间需在 1–10 秒之间")
	}
	s := f.a.Settings
	s.Concurrent = dto.Concurrent
	s.Threads = dto.Threads
	s.Proxy = strings.TrimSpace(dto.Proxy)
	s.NetworkRetryMinutes = dto.NetworkRetryMinutes
	s.UnknownRetryCount = dto.UnknownRetryCount
	s.GenerateThumbnails = dto.GenerateThumbnails
	s.StallTimeoutSeconds = dto.StallTimeoutSeconds
	s.StalledFileRetries = dto.StalledFileRetries
	s.TransferAdjustment = dto.TransferAdjustment
	if strings.TrimSpace(dto.ReconnectTimeout) != "" {
		s.ReconnectTimeout = strings.TrimSpace(dto.ReconnectTimeout)
	}
	if dto.MaxRepairPasses > 0 {
		s.MaxRepairPasses = dto.MaxRepairPasses
	}
	s.OpenAfterBuild = dto.OpenAfterBuild
	s.VideoSeekSeconds = dto.VideoSeekSeconds
	s.VideoLongPressRate = dto.VideoLongPressRate
	s.VideoLongPressDelayMS = dto.VideoLongPressDelayMS
	s.VideoMaxVolume = dto.VideoMaxVolume
	s.VideoVolumeStep = dto.VideoVolumeStep
	s.VideoFrameAspect = dto.VideoFrameAspect
	s.SpeedWindowSeconds = dto.SpeedWindowSeconds
	s.ViewerBackdrop = dto.ViewerBackdrop
	s.ToastSeconds = dto.ToastSeconds
	if strings.TrimSpace(dto.TdlNamespace) != "" {
		s.TdlNamespace = strings.TrimSpace(dto.TdlNamespace)
	}
	f.a.Settings = s
	if err := f.a.saveSettings(); err != nil {
		return f.GetSettings(), err
	}
	return f.GetSettings(), nil
}

type DownloadConfigDTO struct {
	Concurrent          int    `json:"concurrent"`
	Threads             int    `json:"threads"`
	StallTimeoutSeconds int    `json:"stallTimeoutSeconds"`
	StalledFileRetries  int    `json:"stalledFileRetries"`
	NetworkRetryMinutes int    `json:"networkRetryMinutes"`
	UnknownRetryCount   int    `json:"unknownRetryCount"`
	MaxRepairPasses     int    `json:"maxRepairPasses"`
	TransferAdjustment  string `json:"transferAdjustment"`
	ReconnectTimeout    string `json:"reconnectTimeout"`
}

// SetDownloadConfig applies transfer settings immediately. tdl receives these
// values only when its process starts, so an active run is paused and resumed
// as an incremental attempt on the same task.
func (f *Facade) SetDownloadConfig(dto DownloadConfigDTO) (string, error) {
	if dto.Concurrent < 1 || dto.Concurrent > 8 {
		return "", errors.New("并发文件任务需在 1–8 之间")
	}
	if dto.Threads < 1 || dto.Threads > 16 {
		return "", errors.New("单文件线程需在 1–16 之间")
	}
	if dto.StallTimeoutSeconds < 30 || dto.StallTimeoutSeconds > 600 {
		return "", errors.New("卡住判定需在 30–600 秒之间")
	}
	if dto.StalledFileRetries < 1 || dto.StalledFileRetries > 10 {
		return "", errors.New("疑难文件重试需在 1–10 次之间")
	}
	if dto.NetworkRetryMinutes < 1 || dto.NetworkRetryMinutes > 180 {
		return "", errors.New("网络恢复窗口需在 1–180 分钟之间")
	}
	if dto.UnknownRetryCount < 0 || dto.UnknownRetryCount > 10 {
		return "", errors.New("未知错误重试需在 0–10 次之间")
	}
	if dto.MaxRepairPasses < 1 || dto.MaxRepairPasses > 10 {
		return "", errors.New("最大修复轮数需在 1–10 之间")
	}
	switch dto.TransferAdjustment {
	case "increase", "increase-both", "decrease", "keep":
	default:
		return "", errors.New("未知的重试传输策略")
	}
	dto.ReconnectTimeout = strings.TrimSpace(dto.ReconnectTimeout)
	f.mu.Lock()
	s := f.a.Settings
	if s.Concurrent == dto.Concurrent && s.Threads == dto.Threads &&
		s.StallTimeoutSeconds == dto.StallTimeoutSeconds && s.StalledFileRetries == dto.StalledFileRetries &&
		s.NetworkRetryMinutes == dto.NetworkRetryMinutes && s.UnknownRetryCount == dto.UnknownRetryCount &&
		s.MaxRepairPasses == dto.MaxRepairPasses && s.TransferAdjustment == dto.TransferAdjustment &&
		(dto.ReconnectTimeout == "" || s.ReconnectTimeout == dto.ReconnectTimeout) {
		op := f.op
		f.mu.Unlock()
		if op != nil && op.task != nil {
			return op.task.snapshot().ID, nil
		}
		return "", nil
	}
	f.a.Settings.Concurrent = dto.Concurrent
	f.a.Settings.Threads = dto.Threads
	f.a.Settings.StallTimeoutSeconds = dto.StallTimeoutSeconds
	f.a.Settings.StalledFileRetries = dto.StalledFileRetries
	f.a.Settings.NetworkRetryMinutes = dto.NetworkRetryMinutes
	f.a.Settings.UnknownRetryCount = dto.UnknownRetryCount
	f.a.Settings.MaxRepairPasses = dto.MaxRepairPasses
	f.a.Settings.TransferAdjustment = dto.TransferAdjustment
	if dto.ReconnectTimeout != "" {
		f.a.Settings.ReconnectTimeout = dto.ReconnectTimeout
	}
	if err := f.a.saveSettings(); err != nil {
		f.mu.Unlock()
		return "", err
	}
	op := f.op
	if op == nil {
		f.mu.Unlock()
		return "", nil
	}
	slug := op.slug
	op.paused = true
	op.cancel()
	f.mu.Unlock()

	deadline := time.Now().Add(20 * time.Second)
	for {
		f.mu.Lock()
		running := f.op != nil
		f.mu.Unlock()
		if !running {
			break
		}
		if time.Now().After(deadline) {
			return "", errors.New("等待当前下载停下超时，请稍后重试")
		}
		time.Sleep(80 * time.Millisecond)
	}
	taskID, err := f.StartOneClick(slug)
	if err != nil {
		return "", fmt.Errorf("新配置已保存，但重新开始下载失败：%w", err)
	}
	return taskID, nil
}

func (f *Facade) Diagnostics() []DiagRow {
	list := f.a.listWorkspaces()
	mediaTotal, missingTotal := 0, 0
	for _, m := range list {
		mediaTotal += m.MediaCount
		missingTotal += m.MissingCount
	}
	missingState := "ok"
	if missingTotal > 0 {
		missingState = "warn"
	}
	rows := []DiagRow{
		{Label: "版本", Value: version, State: "ok"},
		{Label: "程序目录", Value: f.a.ExeDir, State: "ok"},
		{Label: "配置文件", Value: f.a.ConfigPath, State: "ok"},
		{Label: "档案库", Value: f.a.Settings.LibraryRoot, State: "ok"},
		{Label: "聊天数量", Value: fmt.Sprint(len(list)), State: "ok"},
		{Label: "媒体总数", Value: fmt.Sprint(mediaTotal), State: "ok"},
		{Label: "缺失媒体", Value: fmt.Sprint(missingTotal), State: missingState},
	}
	if p := f.a.resolveTdl(); p != "" {
		rows = append(rows, DiagRow{Label: "tdl", Value: p, State: "ok"})
	} else {
		rows = append(rows, DiagRow{Label: "tdl", Value: "未安装", State: "warn"})
	}
	rows = append(rows, DiagRow{Label: "tdl 版本", Value: fallback(f.a.tdlVersion(), "未知"), State: "ok"})
	rows = append(rows, DiagRow{Label: "tdl 会话目录", Value: tdlDataDir(), State: "ok"})
	if hasTdlSessionData() {
		rows = append(rows, DiagRow{Label: "会话文件", Value: "已发现", State: "ok"})
	} else {
		rows = append(rows, DiagRow{Label: "会话文件", Value: "未发现", State: "warn"})
	}
	rows = append(rows, DiagRow{Label: "Namespace", Value: f.a.Settings.TdlNamespace, State: "ok"})
	if p := media.FindFFmpeg(); p != "" {
		rows = append(rows, DiagRow{Label: "FFmpeg", Value: p, State: "ok"})
	} else {
		rows = append(rows, DiagRow{Label: "FFmpeg", Value: "未安装", State: "warn"})
	}
	if free := platform.FreeSpaceBytes(f.a.Settings.LibraryRoot); free > 0 {
		rows = append(rows, DiagRow{Label: "磁盘剩余", Value: fmt.Sprintf("%.1f GB", float64(free)/(1024*1024*1024)), State: "ok"})
	}
	if remote, kind := platform.NetworkPathKind(f.a.Settings.LibraryRoot); remote {
		st := f.RemoteStatus()
		state := "ok"
		status := "连接正常"
		if !st.Reachable {
			state, status = "warn", "不可访问"
		} else if !st.Writable {
			state, status = "warn", "只读"
		}
		label := "SMB / UNC"
		if kind == "mapped" {
			label = "映射网络盘"
		}
		rows = append(rows,
			DiagRow{Label: "远程库", Value: fmt.Sprintf("%s · %s · %d ms", label, status, st.LatencyMs), State: state},
		)
		if st.CacheBytes > 0 {
			rows = append(rows, DiagRow{Label: "远程缓存", Value: fmt.Sprintf("%.1f MB", float64(st.CacheBytes)/(1024*1024)), State: "ok"})
		}
	}
	return rows
}

func (f *Facade) ListLogs() []LogInfo {
	dir := f.a.logsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []LogInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".log") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, LogInfo{Name: e.Name(), Size: info.Size(), ModTime: info.ModTime().Format("2006-01-02 15:04:05")})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ModTime > out[j].ModTime })
	if len(out) > 100 {
		out = out[:100]
	}
	return out
}

func (f *Facade) ReadLog(name string) (string, error) {
	base := filepath.Base(strings.TrimSpace(name))
	if base == "" || base != name {
		return "", errors.New("日志名称无效")
	}
	b, err := os.ReadFile(filepath.Join(f.a.logsDir(), base))
	if err != nil {
		return "", err
	}
	const max = 256 * 1024
	if len(b) > max {
		b = b[len(b)-max:]
	}
	return string(b), nil
}

func (f *Facade) LogsDir() string { return f.a.logsDir() }

func (f *Facade) OpenFolderPath(path string) error {
	clean := filepath.Clean(strings.TrimSpace(path))
	if clean == "" || clean == "." {
		return errors.New("路径无效")
	}
	if _, err := os.Stat(clean); err != nil {
		return err
	}
	return openFolder(clean)
}
