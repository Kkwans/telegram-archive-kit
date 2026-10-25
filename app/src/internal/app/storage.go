package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"telegramarchivekit/internal/transfer"
)

func (a *App) rememberLibrary(path string) {
	path = filepath.Clean(strings.TrimSpace(path))
	if path == "." || path == "" {
		return
	}
	var next []string
	next = append(next, path)
	for _, p := range a.Settings.LibraryHistory {
		if !strings.EqualFold(filepath.Clean(p), path) {
			next = append(next, p)
		}
		if len(next) >= 8 {
			break
		}
	}
	a.Settings.LibraryHistory = next
	_ = a.saveSettings()
}

func appAtLibrary(base *App, root string) *App {
	cp := *base
	cp.Settings = base.Settings
	cp.Settings.LibraryRoot = filepath.Clean(root)
	cp.Settings.LastWorkspaceSlug = ""
	return &cp
}

func looksLikeLibrary(root string) bool {
	if root == "" {
		return false
	}
	if fileExists(filepath.Join(root, "library.json")) {
		return true
	}
	st, err := os.Stat(filepath.Join(root, "chats"))
	return err == nil && st.IsDir()
}

func librarySourceChats(root string) []string {
	chats := filepath.Join(root, "chats")
	entries, _ := os.ReadDir(chats)
	var out []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		// A workspace may be JSON-backed, official-HTML-only, or both. workspace.json
		// is the canonical registration marker for managed libraries.
		if fileExists(filepath.Join(chats, e.Name(), "workspace.json")) ||
			fileExists(filepath.Join(chats, e.Name(), "source", "result.json")) ||
			fileExists(filepath.Join(chats, e.Name(), "official-media-index.json")) {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

// copyChatFromLibrary merges one chat into the destination library. It never deletes source data.
func (dst *App) copyChatFromLibrary(srcRoot, srcSlug string) (WorkspaceMeta, error) {
	src := appAtLibrary(dst, srcRoot)
	srcMeta, err := src.readWorkspaceMeta(srcSlug)
	if err != nil {
		return WorkspaceMeta{}, err
	}
	srcWS := src.workspaceDir(srcSlug)
	srcJSON := src.sourcePath(srcSlug)

	// Preserve the source library's exact Beautifier assets when available.
	srcTheme := filepath.Join(srcRoot, "assets", "beautifier")
	if st, er := os.Stat(srcTheme); er == nil && st.IsDir() {
		_, _, _ = transfer.CopyDirIncremental(srcTheme, dst.beautifierDir())
	}

	var target WorkspaceMeta
	if fileExists(srcJSON) {
		target, _, err = dst.importResultJSONMode(srcJSON, false)
		if err != nil {
			return WorkspaceMeta{}, err
		}
	} else {
		// Official-HTML-only workspace: create a provisional chat that can later be
		// joined to a full result.json by exact name, then by Chat ID once known.
		target, err = dst.ensureProvisionalWorkspace(srcMeta.Chat.Name)
		if err != nil {
			return WorkspaceMeta{}, err
		}
		if target.Chat.Type == "" {
			target.Chat.Type = srcMeta.Chat.Type
		}
		_ = writeJSON(dst.workspaceMetaPath(target.Slug), target)
	}
	targetSlug := target.Slug

	// Native tdl media and source history are copied incrementally.
	if st, er := os.Stat(src.mediaDir(srcSlug)); er == nil && st.IsDir() {
		if _, _, er = transfer.CopyDirIncremental(src.mediaDir(srcSlug), dst.mediaDir(targetSlug)); er != nil {
			return WorkspaceMeta{}, er
		}
	}
	srcHist := filepath.Join(srcWS, "source", "history")
	dstHist := filepath.Join(dst.workspaceDir(targetSlug), "source", "history")
	if st, er := os.Stat(srcHist); er == nil && st.IsDir() {
		_, _, _ = transfer.CopyDirIncremental(srcHist, dstHist)
	}

	// Copy every inherited official ChatExport as a self-contained managed source.
	// Even a source library that merely referenced an external ChatExport becomes
	// portable after extraction/merge into the destination library.
	if idx, er := src.loadOfficialIndex(srcSlug); er == nil {
		for i, ex := range idx.Exports {
			root := filepath.FromSlash(ex.Meta.Root)
			if !filepath.IsAbs(root) {
				root = filepath.Join(srcWS, root)
			}
			if st, e := os.Stat(root); e != nil || !st.IsDir() {
				continue
			}
			name := filepath.Base(filepath.Clean(root))
			if name == "." || name == string(filepath.Separator) || name == "" {
				name = fmt.Sprintf("TelegramExport_%02d", i+1)
			}
			dstRoot := dst.managedOfficialRoot(targetSlug, name)
			if filepath.Clean(root) != filepath.Clean(dstRoot) {
				if _, _, copyErr := transfer.CopyDirIncremental(root, dstRoot); copyErr != nil {
					return WorkspaceMeta{}, copyErr
				}
			}
			if _, regErr := dst.registerOfficialExport(targetSlug, dstRoot, "managed"); regErr != nil {
				return WorkspaceMeta{}, regErr
			}
		}
	}

	if fileExists(dst.sourcePath(targetSlug)) {
		if _, err = dst.buildWorkspace(targetSlug); err != nil {
			return WorkspaceMeta{}, err
		}
	} else {
		m, _ := dst.readWorkspaceMeta(targetSlug)
		m.UpdatedAt = time.Now()
		_ = writeJSON(dst.workspaceMetaPath(targetSlug), m)
		_ = dst.buildLibrary()
	}
	return dst.readWorkspaceMeta(targetSlug)
}

func (a *App) storageMenu() {
	for {
		status := []string{"当前档案库   " + a.Settings.LibraryRoot, fmt.Sprintf("聊天         %d 个", len(a.listWorkspaces()))}
		items := []menuItem{
			{Key: "switch", Icon: "⇄", Label: "切换 / 新建档案库", Desc: "可放 C / D / E / NAS 映射盘；原档案库保持不动"},
			{Key: "merge", Icon: "⊕", Label: "合并另一个档案库到当前库", Desc: "按 Chat ID + Message ID 合并；媒体增量复制，不会覆盖同名聊天"},
			{Key: "history", Icon: "◫", Label: "最近使用的档案库", Desc: "快速在多个磁盘的档案库之间切换"},
			{Key: "folder", Icon: "▣", Label: "打开当前档案库目录", Desc: "查看 chats / assets / library.json"},
			{Key: "back", Icon: "←", Label: "返回", Desc: ""},
		}
		c := runMenu("档案库与存储", "多磁盘、多聊天、可拆可合；数据与程序版本完全分离", status, items, true)
		switch c {
		case "switch":
			a.switchLibraryInteractive()
		case "merge":
			a.mergeLibraryInteractive()
		case "history":
			a.libraryHistoryMenu()
		case "folder":
			_ = openFolder(a.Settings.LibraryRoot)
		default:
			return
		}
	}
}

func (a *App) switchLibraryInteractive() {
	root, err := selectFolder("选择或新建 Telegram Archive Library", filepath.Dir(a.Settings.LibraryRoot))
	if err != nil {
		showErrorAndWait(err)
		return
	}
	if root == "" {
		return
	}
	old := a.Settings.LibraryRoot
	a.rememberLibrary(old)
	a.Settings.LibraryRoot = root
	a.rememberLibrary(root)
	if err := a.ensureLibraryDirs(); err != nil {
		a.Settings.LibraryRoot = old
		_ = a.saveSettings()
		showErrorAndWait(err)
		return
	}
	_ = a.buildLibrary()
	showMessage("已切换档案库", root)
}

func (a *App) libraryHistoryMenu() {
	if len(a.Settings.LibraryHistory) == 0 {
		showMessage("暂无历史", "切换过的档案库会出现在这里")
		return
	}
	var items []menuItem
	for i, p := range a.Settings.LibraryHistory {
		label := filepath.Base(p)
		if label == "." || label == string(filepath.Separator) || label == "" {
			label = p
		}
		mark := ""
		if strings.EqualFold(filepath.Clean(p), filepath.Clean(a.Settings.LibraryRoot)) {
			mark = " · 当前"
		}
		items = append(items, menuItem{Key: fmt.Sprintf("p%d", i), Icon: "◫", Label: label + mark, Desc: p})
	}
	items = append(items, menuItem{Key: "back", Icon: "←", Label: "返回"})
	c := runMenu("最近档案库", "选择后立即切换；不会移动任何文件", nil, items, true)
	if !strings.HasPrefix(c, "p") {
		return
	}
	var idx int
	_, _ = fmt.Sscanf(c, "p%d", &idx)
	if idx < 0 || idx >= len(a.Settings.LibraryHistory) {
		return
	}
	root := a.Settings.LibraryHistory[idx]
	a.Settings.LibraryRoot = root
	a.rememberLibrary(root)
	_ = a.ensureLibraryDirs()
	_ = a.buildLibrary()
}

func (a *App) mergeLibraryInteractive() {
	src, err := selectFolder("选择要合并进来的 Telegram Archive Library", filepath.Dir(a.Settings.LibraryRoot))
	if err != nil {
		showErrorAndWait(err)
		return
	}
	if src == "" {
		return
	}
	if strings.EqualFold(filepath.Clean(src), filepath.Clean(a.Settings.LibraryRoot)) {
		showErrorAndWait(fmt.Errorf("不能把档案库与自身合并"))
		return
	}
	if !looksLikeLibrary(src) {
		showErrorAndWait(fmt.Errorf("所选目录不是 TelegramArchiveKit 档案库：缺少 chats/ 或 library.json"))
		return
	}
	slugs := librarySourceChats(src)
	if len(slugs) == 0 {
		showErrorAndWait(fmt.Errorf("源档案库没有可合并的聊天"))
		return
	}
	okCount := 0
	for i, slug := range slugs {
		var merged WorkspaceMeta
		er := runOperation("合并档案库", fmt.Sprintf("聊天 %d / %d", i+1, len(slugs)), "正在合并聊天数据", func(ctx context.Context, update func(OperationProgress)) error {
			update(OperationProgress{Stage: "正在复制 / 合并聊天", Detail: slug})
			var copyErr error
			merged, copyErr = a.copyChatFromLibrary(src, slug)
			if copyErr == nil {
				update(OperationProgress{Stage: "聊天合并完成", Detail: merged.Chat.Name})
			}
			return copyErr
		})
		if er != nil {
			showErrorAndWait(er)
			continue
		}
		okCount++
	}
	_ = a.buildLibrary()
	a.rememberLibrary(src)
	waitAnyKey(fmt.Sprintf("合并完成：%d/%d 个聊天成功。按任意键返回", okCount, len(slugs)))
}

func (a *App) exportChatInteractive(slug string) {
	m, err := a.readWorkspaceMeta(slug)
	if err != nil {
		showErrorAndWait(err)
		return
	}
	root, err := selectFolder("选择目标 Telegram Archive Library（可新建空目录）", filepath.Dir(a.Settings.LibraryRoot))
	if err != nil {
		showErrorAndWait(err)
		return
	}
	if root == "" {
		return
	}
	if strings.EqualFold(filepath.Clean(root), filepath.Clean(a.Settings.LibraryRoot)) {
		showErrorAndWait(fmt.Errorf("目标与当前档案库相同"))
		return
	}
	dst := appAtLibrary(a, root)
	if er := dst.ensureLibraryDirs(); er != nil {
		showErrorAndWait(er)
		return
	}
	var out WorkspaceMeta
	er := runOperation("抽取 / 复制聊天", m.Chat.Name, "正在复制聊天到目标档案库", func(ctx context.Context, update func(OperationProgress)) error {
		update(OperationProgress{Stage: "正在复制聊天数据", Detail: root})
		var copyErr error
		out, copyErr = dst.copyChatFromLibrary(a.Settings.LibraryRoot, slug)
		return copyErr
	})
	if er != nil {
		showErrorAndWait(er)
		return
	}
	a.rememberLibrary(root)
	waitAnyKey(fmt.Sprintf("✓ 已复制到目标档案库 · %d 条消息 · %d 媒体。源聊天保持不变。", out.MessageCount, out.MediaCount))
}
