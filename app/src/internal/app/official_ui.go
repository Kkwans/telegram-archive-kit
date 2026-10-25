package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"telegramarchivekit/internal/archive"
	"telegramarchivekit/internal/transfer"
)

func (a *App) analyzeOfficialExportInteractive(folder, workspaceRoot, mode string) (OfficialExportMeta, map[string][]Media, error) {
	var meta OfficialExportMeta
	var media map[string][]Media
	err := runOperation("扫描官方 ChatExport", "正在识别 messages*.html 与历史媒体", "读取导出结构", func(ctx context.Context, update func(OperationProgress)) error {
		update(OperationProgress{Stage: "正在解析 Telegram 官方 HTML", Detail: folder})
		var er error
		meta, media, er = archive.AnalyzeOfficialExport(folder, workspaceRoot, mode)
		if er == nil {
			update(OperationProgress{Stage: "扫描完成", Detail: fmt.Sprintf("%d 条消息 · %d 个媒体文件", meta.MessageCount, meta.MediaFiles)})
		}
		return er
	})
	return meta, media, err
}

func (a *App) registerOfficialExportInteractive(slug, root, mode string) (OfficialExportMeta, error) {
	var out OfficialExportMeta
	err := runOperation("建立官方归档索引", "把历史媒体映射到 Message ID，后续不会重复下载", "正在建立索引", func(ctx context.Context, update func(OperationProgress)) error {
		update(OperationProgress{Stage: "正在索引历史消息和媒体", Detail: root})
		var er error
		out, er = a.registerOfficialExport(slug, root, mode)
		if er == nil {
			update(OperationProgress{Stage: "索引完成", Detail: fmt.Sprintf("%d 条历史消息 · %d 个可复用媒体", out.MessageCount, out.MediaFiles)})
		}
		return er
	})
	return out, err
}

func (a *App) ensureProvisionalWorkspace(name string) (WorkspaceMeta, error) {
	chat := Chat{Name: strings.TrimSpace(name)}
	if chat.Name == "" {
		chat.Name = "Telegram Archive"
	}
	slug, existed := a.findWorkspaceByChat(chat)
	if existed {
		return a.readWorkspaceMeta(slug)
	}
	ws := a.workspaceDir(slug)
	for _, p := range []string{filepath.Join(ws, "source"), filepath.Join(ws, "source", "history"), a.mediaDir(slug), a.dataDir(slug)} {
		if err := os.MkdirAll(p, 0755); err != nil {
			return WorkspaceMeta{}, err
		}
	}
	now := time.Now()
	meta := WorkspaceMeta{Slug: slug, Chat: chat, ImportedAt: now, UpdatedAt: now, SourceVersion: version}
	if err := writeJSON(a.workspaceMetaPath(slug), meta); err != nil {
		return WorkspaceMeta{}, err
	}
	a.Settings.LastWorkspaceSlug = slug
	_ = a.saveSettings()
	return meta, nil
}

func chooseCrossVolumeManagementMode(src, dst string) string {
	if transfer.SameVolume(src, dst) {
		return "move"
	}
	status := []string{
		yellow("! 来源和档案库不在同一磁盘 / 卷"),
		"来源   " + src,
		"目标   " + dst,
		"说明   Windows 不能对目录执行跨卷瞬移；纳管会变成“完整复制 → 校验 → 删除源目录”。",
		"体验   v9 会实时显示容量、速度、预计剩余时间，并使用后台 I/O 优先级避免拖慢系统。",
	}
	items := []menuItem{
		{Key: "move", Icon: "⇢", Label: "继续跨盘纳管", Desc: "数据最终完全进入 Library；耗时取决于磁盘/接口速度"},
		{Key: "reference", Icon: "↗", Label: "改为引用原目录（推荐给大体积跨盘归档）", Desc: "零复制、立即完成；但之后不要移动/改名原 ChatExport"},
		{Key: "back", Icon: "←", Label: "取消", Desc: "返回后可重新选择导入方式"},
	}
	return runMenu("跨磁盘纳管", "先说明真实成本，再由你决定是否复制几十 GB 数据", status, items, true)
}

func (a *App) actionImportOfficialExport() {
	start := a.Settings.LibraryRoot
	folder, err := selectFolder("选择 Telegram Desktop 官方 ChatExport 文件夹（需要包含 messages.html）", start)
	if err != nil {
		showErrorAndWait(err)
		return
	}
	if strings.TrimSpace(folder) == "" {
		return
	}
	a.actionImportOfficialExportPath(folder)
}

// actionImportOfficialExportPath is also used when a ChatExport folder is dragged
// directly onto TelegramArchiveKit.exe/BAT. The actual data model is identical to
// choosing the folder from the menu.
func (a *App) actionImportOfficialExportPath(folder string) {
	folder, _ = filepath.Abs(strings.TrimSpace(strings.Trim(folder, `"`)))
	if folder == "" {
		return
	}
	probe, _, err := a.analyzeOfficialExportInteractive(folder, folder, "referenced")
	if err != nil {
		showErrorAndWait(err)
		return
	}

	workspaces := a.listWorkspaces()
	targetSlug := ""
	// Prefer exact-name workspace; this is common when result.json was imported first.
	for _, w := range workspaces {
		if strings.EqualFold(strings.TrimSpace(w.Chat.Name), strings.TrimSpace(probe.Name)) {
			targetSlug = w.Slug
			break
		}
	}
	if targetSlug == "" && len(workspaces) > 0 {
		items := []menuItem{{Key: "new", Icon: "＋", Label: "创建为新的官方归档聊天", Desc: "稍后导入全量 result.json 时会按聊天名称自动继承"}}
		for _, w := range workspaces {
			items = append(items, menuItem{Key: w.Slug, Icon: "▤", Label: "合并到：" + w.Chat.Name, Desc: fmt.Sprintf("%d 条消息 · 当前目录 %s", w.MessageCount, w.Slug)})
		}
		items = append(items, menuItem{Key: "back", Icon: "←", Label: "取消", Desc: ""})
		status := []string{
			"检测到官方导出   " + probe.Name,
			fmt.Sprintf("消息 %d · 媒体消息 %d · 媒体文件 %d", probe.MessageCount, probe.MediaMessages, probe.MediaFiles),
			"源目录           " + folder,
		}
		c := runMenu("导入 Telegram 官方 HTML", "选择它应该归属到哪个聊天；同一聊天后续可与 result.json 无缝合并", status, items, true)
		if c == "" || c == "back" {
			return
		}
		if c != "new" {
			targetSlug = c
		}
	}
	if targetSlug == "" {
		m, er := a.ensureProvisionalWorkspace(probe.Name)
		if er != nil {
			showErrorAndWait(er)
			return
		}
		targetSlug = m.Slug
	}

	targetMeta, _ := a.readWorkspaceMeta(targetSlug)
	status := []string{
		"官方导出     " + probe.Name,
		fmt.Sprintf("识别到       %d 条消息 · %d 个媒体文件", probe.MessageCount, probe.MediaFiles),
		"目标聊天     " + targetMeta.Chat.Name,
		"来源目录     " + folder,
	}
	modes := []menuItem{
		{Key: "move", Icon: "⇢", Label: "纳管到档案库（推荐）", Desc: "同盘瞬间移动；跨盘会增量复制后删除源目录，并显示文件/容量/速度/预计剩余时间"},
		{Key: "reference", Icon: "↗", Label: "引用原目录（零额外空间）", Desc: "不移动也不复制；网页直接引用原目录，原目录以后不能随意改名/移动"},
		{Key: "copy", Icon: "⧉", Label: "复制到档案库", Desc: "最安全但会额外占用一份空间"},
		{Key: "back", Icon: "←", Label: "取消", Desc: ""},
	}
	mode := runMenu("导入方式", "官方 HTML 只作为历史来源与媒体复用；最终时间线由统一 Viewer 维护", status, modes, true)
	if mode == "" || mode == "back" {
		return
	}

	finalRoot := folder
	finalMode := mode
	if mode == "move" || mode == "copy" {
		dst := a.managedOfficialRoot(targetSlug, filepath.Base(folder))
		if filepath.Clean(folder) != filepath.Clean(dst) {
			var opErr error
			if mode == "move" {
				decision := chooseCrossVolumeManagementMode(folder, dst)
				if decision == "" || decision == "back" {
					return
				}
				if decision == "reference" {
					finalRoot, finalMode = folder, "referenced"
				} else {
					_, opErr = runDirectoryTransferUI("纳管官方 ChatExport", "同盘瞬移；跨盘使用后台 I/O 复制并实时显示进度", folder, dst, true)
					finalMode = "managed"
				}
			} else {
				_, opErr = runDirectoryTransferUI("复制官方 ChatExport", "增量复制 · 可取消 · 已完成文件可继续复用", folder, dst, false)
				finalMode = "copied"
			}
			if opErr != nil {
				showErrorAndWait(opErr)
				return
			}
		} else {
			finalMode = "managed"
		}
		if finalMode != "referenced" {
			finalRoot = dst
		}
	} else {
		finalMode = "referenced"
	}

	imported, err := a.registerOfficialExportInteractive(targetSlug, finalRoot, finalMode)
	if err != nil {
		showErrorAndWait(err)
		return
	}

	// If a full result.json already exists, immediately rebuild with inherited media.
	if fileExists(a.sourcePath(targetSlug)) {
		if _, err := a.buildWorkspaceInteractive(targetSlug, targetMeta.Chat.Name); err != nil {
			showErrorAndWait(err)
			return
		}
	} else {
		meta, _ := a.readWorkspaceMeta(targetSlug)
		meta.MessageCount = imported.MessageCount
		meta.MediaCount = imported.MediaFiles
		meta.MissingCount = 0
		meta.UpdatedAt = time.Now()
		_ = writeJSON(a.workspaceMetaPath(targetSlug), meta)
		_ = a.buildLibrary()
	}

	status = []string{
		green("✓ 官方 ChatExport 已纳入管理"),
		"聊天         " + targetMeta.Chat.Name,
		fmt.Sprintf("历史消息     %d", imported.MessageCount),
		fmt.Sprintf("已复用媒体   %d 个文件 / %d 条媒体消息", imported.MediaFiles, imported.MediaMessages),
	}
	if fileExists(a.sourcePath(targetSlug)) {
		arc, _ := a.verifyWorkspace(targetSlug)
		if arc != nil {
			status = append(status, fmt.Sprintf("全量 JSON     %d 条消息 · 仍缺 %d 条媒体", arc.Stats.Messages, arc.Stats.MissingMedia))
		}
	} else {
		status = append(status, yellow("! 尚未导入全量 result.json；当前可浏览官方 HTML，导入 JSON 后才能自动补齐到最新消息"))
	}
	runMenu("官方归档导入完成", "已有媒体会直接复用，不会重复下载", status, []menuItem{{Key: "back", Icon: "←", Label: "返回主菜单", Desc: ""}}, true)
}

func (a *App) actionImportOfficialExportInto(targetSlug string) {
	targetMeta, err := a.readWorkspaceMeta(targetSlug)
	if err != nil {
		showErrorAndWait(err)
		return
	}
	folder, err := selectFolder("选择要继承的 Telegram Desktop 官方 ChatExport 文件夹", a.Settings.LibraryRoot)
	if err != nil {
		showErrorAndWait(err)
		return
	}
	if strings.TrimSpace(folder) == "" {
		return
	}
	probe, _, err := a.analyzeOfficialExportInteractive(folder, folder, "referenced")
	if err != nil {
		showErrorAndWait(err)
		return
	}
	status := []string{
		"官方导出     " + probe.Name,
		fmt.Sprintf("识别到       %d 条消息 · %d 个媒体文件", probe.MessageCount, probe.MediaFiles),
		"目标聊天     " + targetMeta.Chat.Name,
		"来源目录     " + folder,
	}
	if !strings.EqualFold(strings.TrimSpace(probe.Name), strings.TrimSpace(targetMeta.Chat.Name)) {
		status = append(status, yellow("! 官方 HTML 标题与目标聊天名称不同，请确认确实属于同一聊天"))
	}
	modes := []menuItem{
		{Key: "move", Icon: "⇢", Label: "纳管到当前聊天（推荐）", Desc: "同盘瞬间移动；跨盘会增量复制后删除源目录，并显示实时进度"},
		{Key: "reference", Icon: "↗", Label: "引用原目录（零额外空间）", Desc: "不移动；原 ChatExport 以后不能随意改名或移动"},
		{Key: "copy", Icon: "⧉", Label: "复制到当前聊天", Desc: "保留原目录，但需要额外磁盘空间"},
		{Key: "back", Icon: "←", Label: "取消", Desc: ""},
	}
	mode := runMenu("继承官方 ChatExport", "已有消息和媒体会参与完整性判断；全量 result.json 只补真正缺失/新增的部分", status, modes, true)
	if mode == "" || mode == "back" {
		return
	}
	finalRoot, finalMode := folder, mode
	if mode == "move" || mode == "copy" {
		dst := a.managedOfficialRoot(targetSlug, filepath.Base(folder))
		if filepath.Clean(folder) != filepath.Clean(dst) {
			if mode == "move" {
				decision := chooseCrossVolumeManagementMode(folder, dst)
				if decision == "" || decision == "back" {
					return
				}
				if decision == "reference" {
					finalRoot, finalMode = folder, "referenced"
				} else {
					_, err = runDirectoryTransferUI("纳管官方 ChatExport", "同盘瞬移；跨盘使用后台 I/O 复制并实时显示进度", folder, dst, true)
					finalMode = "managed"
				}
			} else {
				_, err = runDirectoryTransferUI("复制官方 ChatExport", "增量复制 · 可取消 · 已完成文件可继续复用", folder, dst, false)
				finalMode = "copied"
			}
			if err != nil {
				showErrorAndWait(err)
				return
			}
		} else {
			finalMode = "managed"
		}
		if finalMode != "referenced" {
			finalRoot = dst
		}
	} else {
		finalMode = "referenced"
	}
	imported, err := a.registerOfficialExportInteractive(targetSlug, finalRoot, finalMode)
	if err != nil {
		showErrorAndWait(err)
		return
	}
	if fileExists(a.sourcePath(targetSlug)) {
		if _, err := a.buildWorkspaceInteractive(targetSlug, targetMeta.Chat.Name); err != nil {
			showErrorAndWait(err)
			return
		}
	}
	status = []string{
		green("✓ 官方 ChatExport 已继承"),
		fmt.Sprintf("历史消息     %d", imported.MessageCount),
		fmt.Sprintf("可直接复用   %d 个媒体文件", imported.MediaFiles),
	}
	if arc, er := a.verifyWorkspace(targetSlug); er == nil {
		status = append(status, fmt.Sprintf("全量结果     %d 条消息 · 仍需补齐 %d 条媒体", arc.Stats.Messages, arc.Stats.MissingMedia))
	}
	runMenu("继承完成", "下一次一键完成会只下载仍然缺失的媒体", status, []menuItem{{Key: "back", Icon: "←", Label: "返回", Desc: ""}}, true)
}
