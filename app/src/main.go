package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

type menuItem struct {
	Key   string
	Icon  string
	Label string
	Desc  string
}

func main() {
	enablePerMonitorDPI()
	terminalInit()
	defer showCursor()
	defer func() {
		if r := recover(); r != nil {
			showCursor()
			fatalScreen(fmt.Errorf("程序发生未处理异常: %v", r))
		}
	}()

	app, err := newApp()
	if err != nil {
		fatalScreen(err)
		return
	}
	if len(os.Args) > 1 {
		if handled := app.handleCLI(os.Args[1:]); handled {
			return
		}
	}
	// Interactive mode uses the alternate screen buffer. Menus and live progress
	// repaint one viewport instead of flooding Windows Terminal scrollback.
	enterAltScreen()
	defer leaveAltScreen()
	if err := app.ensureLibraryConfiguredInteractive(); err != nil {
		fatalScreen(err)
		return
	}
	app.normalizeWorkspaceSlugs()
	if len(os.Args) > 1 {
		paths := collectJSONArgs(os.Args[1:])
		if len(paths) > 0 {
			app.handleDroppedJSON(paths)
		}
		for _, dir := range collectOfficialExportArgs(os.Args[1:]) {
			app.actionImportOfficialExportPath(dir)
		}
	}
	app.runMainLoop()
}

func (a *App) handleCLI(args []string) bool {
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "version", "--version", "-v":
		fmt.Println("TelegramArchiveKit", version)
		return true
	case "selftest":
		if err := runSelfTest(a); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("selftest: ok")
		return true
	case "build":
		if len(args) < 4 {
			fmt.Fprintln(os.Stderr, "usage: build <result.json> <media-dir> <out-dir>")
			os.Exit(2)
		}
		if err := buildStandalone(args[1], args[2], args[3]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return true
	case "verify":
		if len(args) < 3 {
			fmt.Fprintln(os.Stderr, "usage: verify <result.json> <media-dir>")
			os.Exit(2)
		}
		arc, err := buildArchive(args[1], args[2])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("messages=%d media=%d missing=%d\n", arc.Stats.Messages, arc.Stats.MediaFiles, arc.Stats.MissingMedia)
		if arc.Stats.MissingMedia > 0 {
			os.Exit(1)
		}
		return true
	}
	return false
}

func collectJSONArgs(args []string) []string {
	var out []string
	for _, p := range args {
		p = strings.Trim(p, `"`)
		if strings.EqualFold(filepath.Ext(p), ".json") && fileExists(p) {
			out = append(out, p)
		}
	}
	return out
}

func collectOfficialExportArgs(args []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, raw := range args {
		p := strings.Trim(strings.TrimSpace(raw), `"`)
		st, err := os.Stat(p)
		if err != nil || !st.IsDir() {
			continue
		}
		if !fileExists(filepath.Join(p, "messages.html")) {
			continue
		}
		abs, _ := filepath.Abs(p)
		key := strings.ToLower(filepath.Clean(abs))
		if !seen[key] {
			seen[key] = true
			out = append(out, abs)
		}
	}
	return out
}

func (a *App) libraryLivesInsideLegacyProgramDir() bool {
	root := filepath.Clean(strings.TrimSpace(a.Settings.LibraryRoot))
	if root == "." || root == "" {
		return false
	}
	parent := filepath.Dir(root)
	if strings.EqualFold(parent, filepath.Clean(a.ExeDir)) {
		return false
	}
	name := strings.ToLower(filepath.Base(parent))
	return strings.EqualFold(filepath.Base(root), "Library") && strings.HasPrefix(name, "telegramarchivekit_v")
}

func (a *App) ensureLibraryConfiguredInteractive() error {
	if strings.TrimSpace(a.Settings.LibraryRoot) != "" {
		if err := a.ensureLibraryDirs(); err == nil {
			if a.libraryLivesInsideLegacyProgramDir() && !strings.EqualFold(filepath.Clean(a.Settings.ConfirmedLegacyLibrary), filepath.Clean(a.Settings.LibraryRoot)) {
				for {
					status := []string{
						yellow("!  当前档案库仍位于旧版 TelegramArchiveKit 程序目录"),
						"当前路径   " + a.Settings.LibraryRoot,
						"风险       升级新版本后仍会继续读写旧版本目录，容易误以为数据去了错误的位置",
					}
					items := []menuItem{
						{Key: "choose", Icon: "▣", Label: "切换到独立档案库目录（推荐）", Desc: "选择 D:/E:/Documents 等长期目录；不会删除旧库"},
						{Key: "keep", Icon: "→", Label: "继续使用这个旧目录", Desc: "本次确认后不再重复提醒；以后可在「档案库与存储」迁移"},
						{Key: "folder", Icon: "◎", Label: "打开当前目录确认", Desc: "先看看旧库里有什么，再决定"},
					}
					c := runMenu("档案库位置提醒", "数据应该独立于程序版本；这是 v7 专门修复的升级路径问题", status, items, false)
					switch c {
					case "choose":
						root, er := selectFolder("选择独立的 Telegram Archive Library", filepath.Dir(a.Settings.LibraryRoot))
						if er != nil {
							showErrorAndWait(er)
							continue
						}
						if strings.TrimSpace(root) == "" {
							continue
						}
						a.rememberLibrary(a.Settings.LibraryRoot)
						a.Settings.LibraryRoot = root
						a.Settings.ConfirmedLegacyLibrary = ""
						if er := a.ensureLibraryDirs(); er != nil {
							showErrorAndWait(er)
							continue
						}
						_ = a.saveSettings()
						_ = a.buildLibrary()
						return nil
					case "keep":
						a.Settings.ConfirmedLegacyLibrary = a.Settings.LibraryRoot
						_ = a.saveSettings()
						return nil
					case "folder":
						_ = openFolder(a.Settings.LibraryRoot)
					}
				}
			}
			return nil
		}
	}
	items := []menuItem{
		{Key: "recommended", Icon: "◆", Label: "使用推荐位置", Desc: recommendedLibraryRoot()},
		{Key: "browse", Icon: "▣", Label: "选择档案库目录", Desc: "媒体和网页都存这里；以后可在设置中修改"},
		{Key: "portable", Icon: "◇", Label: "便携模式", Desc: filepath.Join(a.ExeDir, "Library")},
		{Key: "exit", Icon: "🚪", Label: "退出", Desc: "不创建任何文件"},
	}
	for {
		choice := runMenu("首次设置", "选择 Telegram 档案库的位置", nil, items, true)
		var root string
		switch choice {
		case "recommended":
			root = recommendedLibraryRoot()
		case "browse":
			p, err := selectFolder("选择 Telegram Archive Library 目录", recommendedLibraryRoot())
			if err != nil {
				return err
			}
			root = p
		case "portable":
			root = filepath.Join(a.ExeDir, "Library")
		default:
			return errors.New("用户取消")
		}
		if strings.TrimSpace(root) == "" {
			continue
		}
		a.Settings.LibraryRoot = root
		if err := a.ensureLibraryDirs(); err != nil {
			showErrorAndWait(err)
			continue
		}
		if err := a.saveSettings(); err != nil {
			return err
		}
		_ = a.buildLibrary()
		return nil
	}
}

func (a *App) runMainLoop() {
	for {
		workspaces := a.listWorkspaces()
		selected := a.selectedWorkspace(workspaces)
		status := a.mainStatus(workspaces, selected)
		items := []menuItem{
			{Key: "one", Icon: "🚀", Label: "一键完成", Desc: "导入/选择聊天 → 环境预检 → 补齐媒体 → 构建网页 → 校验 → 打开"},
			{Key: "add", Icon: "➕", Label: "添加 / 更新聊天", Desc: "选择 result.json → 增量合并 → 自动补齐媒体 → 刷新网页"},
			{Key: "official", Icon: "📥", Label: "继承 Telegram 官方 ChatExport", Desc: "导入旧 messages.html + photos/video_files/files；复用历史媒体，不重复下载"},
			{Key: "chats", Icon: "🗂️", Label: "聊天管理", Desc: "切换聊天、单独同步、继承官方导出、导入媒体、删除归档"},
			{Key: "open", Icon: "🌐", Label: "打开归档库", Desc: "一个网页里切换所有聊天，查看时间线 / 图片 / 视频 / 日期导航"},
			{Key: "syncall", Icon: "🔄", Label: "同步全部聊天", Desc: "逐个补齐缺失媒体并刷新整个归档库"},
			{Key: "storage", Icon: "💾", Label: "档案库与存储", Desc: "切换磁盘、合并档案库、管理多盘聊天"},
			{Key: "account", Icon: "🔐", Label: "Telegram 账号与会话", Desc: "全局登录状态、二维码/验证码登录、会话位置"},
			{Key: "settings", Icon: "⚙️", Label: "设置与诊断", Desc: "下载参数、tdl、日志、环境检查"},
			{Key: "exit", Icon: "🚪", Label: "退出", Desc: ""},
		}
		choice := runMenu("主菜单", "离线 Telegram 档案工作台", status, items, false)
		switch choice {
		case "one":
			a.actionOneClick(selected)
		case "add":
			a.actionAddChats(true)
		case "official":
			a.actionImportOfficialExport()
		case "chats":
			a.chatManager()
		case "open":
			a.actionOpenLibrary(selectedSlug(selected))
		case "syncall":
			a.actionSyncAll()
		case "storage":
			a.storageMenu()
		case "account":
			a.accountMenu()
		case "settings":
			a.settingsMenu()
		default:
			return
		}
	}
}

func selectedSlug(m *WorkspaceMeta) string {
	if m == nil {
		return ""
	}
	return m.Slug
}

func (a *App) selectedWorkspace(list []WorkspaceMeta) *WorkspaceMeta {
	if len(list) == 0 {
		return nil
	}
	for i := range list {
		if list[i].Slug == a.Settings.LastWorkspaceSlug {
			return &list[i]
		}
	}
	return &list[0]
}

func (a *App) mainStatus(list []WorkspaceMeta, selected *WorkspaceMeta) []string {
	lib := a.Settings.LibraryRoot
	if len(lib) > 66 {
		lib = "…" + lib[len(lib)-65:]
	}
	tdl := "未安装"
	if p := a.resolveTdl(); p != "" {
		tdl = "已就绪"
		if isTdlRunning() {
			tdl += "（运行中）"
		}
	}
	session := "未发现"
	if hasTdlSessionData() {
		session = "发现本地会话数据"
	}
	chatLine := fmt.Sprintf("%d 个聊天", len(list))
	if selected != nil {
		chatLine += "  ·  当前：" + selected.Chat.Name
	}
	return []string{
		"档案库   " + lib,
		"工具     tdl " + tdl + "  ·  Telegram " + session,
		"聊天     " + chatLine,
	}
}

// menuEmoji is the single icon catalogue used by *every* menu, not just the
// home screen. Consistent colorful symbols prevent tiny ASCII glyphs from
// mixing with Emoji in secondary pages.
func menuEmoji(icon, label string) string {
	lower := strings.ToLower(label)
	switch {
	case strings.Contains(label, "删除"), strings.Contains(label, "结束") && strings.Contains(label, "强制"):
		return "🗑️"
	case strings.Contains(label, "返回"), strings.Contains(label, "取消"):
		return "↩️"
	case strings.Contains(label, "重新"), strings.Contains(label, "同步"), strings.Contains(label, "再试"):
		return "🔄"
	case strings.Contains(label, "生成"), strings.Contains(label, "构建"):
		return "🛠️"
	case strings.Contains(label, "网页"), strings.Contains(label, "打开归档"):
		return "🌐"
	case strings.Contains(label, "登录"), strings.Contains(label, "账户"), strings.Contains(label, "会话"):
		return "🔐"
	case strings.Contains(label, "设置"), strings.Contains(label, "参数"):
		return "⚙️"
	case strings.Contains(label, "诊断"), strings.Contains(label, "检查"):
		return "🩺"
	case strings.Contains(label, "下载"), strings.Contains(label, "安装"):
		return "📥"
	case strings.Contains(label, "导入"), strings.Contains(label, "添加"):
		return "➕"
	case strings.Contains(label, "图片"), strings.Contains(label, "缩略图"):
		return "🖼️"
	case strings.Contains(label, "目录"), strings.Contains(label, "档案库"):
		return "📁"
	case strings.Contains(label, "媒体"):
		return "🎞️"
	case strings.Contains(label, "日志"):
		return "📋"
	case strings.Contains(label, "帮助"):
		return "💡"
	case strings.Contains(label, "确认"), strings.Contains(label, "继续"):
		return "✅"
	case strings.Contains(label, "退出"):
		return "🚪"
	case strings.Contains(label, "搜索"):
		return "🔎"
	case strings.Contains(label, "复制"):
		return "📋"
	case strings.Contains(label, "空间"), strings.Contains(label, "磁盘"):
		return "💾"
	case strings.Contains(label, "选择"), strings.Contains(label, "切换"):
		return "🔀"
	case strings.Contains(lower, "tdl"):
		return "🔧"
	}
	switch icon {
	case "↻", "→", "⇢":
		return "🔄"
	case "↓":
		return "📥"
	case "↑":
		return "⬆️"
	case "＋", "+":
		return "➕"
	case "△", "◇":
		return "🛠️"
	case "←":
		return "↩️"
	case "◎", "🌐":
		return "🌐"
	case "▣", "▤":
		return "📁"
	case "!":
		return "⚠️"
	case "i":
		return "ℹ️"
	case "◆", "✦", "★":
		return "✨"
	case "●", "◉":
		return "💬"
	case "≡":
		return "📋"
	case "◫", "⧉":
		return "📦"
	case "▧":
		return "🖼️"
	case "↗", "⇈", "↘":
		return "📈"
	case "◀", "▶":
		return "🎬"
	case "×", "x":
		return "🚪"
	}
	// Never leak tiny monochrome legacy glyphs into secondary menus.
	if icon == "" || visibleWidth(icon) <= 1 {
		return "📌"
	}
	return icon
}

func runMenu(title, subtitle string, status []string, items []menuItem, allowEsc bool) string {
	if len(items) == 0 {
		return ""
	}
	for i := range items {
		items[i].Icon = menuEmoji(items[i].Icon, items[i].Label)
	}
	sel := 0
	legacyFrameActive = false
	hideCursor()
	defer hideCursor()
	for {
		inner := uiInnerWidth()
		lead := uiLeadFor(inner)
		var b strings.Builder
		b.WriteString(topFrame(title, subtitle))

		if len(status) > 0 {
			b.WriteString(lead + ansiBold + ansiWhite + "状态概览" + ansiReset + "\n")
			for _, line := range status {
				b.WriteString(lead + "  " + muted(truncatePlain(line, inner-4)) + "\n")
			}
			b.WriteString("\n\n")
		}

		labelIndent := "         "
		for i, it := range items {
			num := fmt.Sprintf("%02d", i+1)
			if i == sel {
				b.WriteString(lead + cyan("›") + " " + cyan(num) + "  " + cyan(bold(padVisible(it.Icon, 3))) + "  " + ansiBold + ansiWhite + it.Label + ansiReset + "\n")
				if it.Desc != "" {
					b.WriteString(lead + labelIndent + ansiGray + truncatePlain(it.Desc, inner-visibleWidth(labelIndent)) + ansiReset + "\n")
				}
			} else {
				b.WriteString(lead + "  " + muted(num) + "  " + blue(padVisible(it.Icon, 3)) + "  " + ansiGray + it.Label + ansiReset + "\n")
				if it.Desc != "" {
					b.WriteString(lead + labelIndent + muted(truncatePlain(it.Desc, inner-visibleWidth(labelIndent))) + "\n")
				}
			}
			if i != len(items)-1 {
				b.WriteString("\n")
			}
		}

		b.WriteString("\n")
		b.WriteString(lead + cyan("↑↓") + " 选择   " + cyan("Enter") + " 确认   " + cyan("Esc") + " 返回   " + muted("1–9 快捷键  ·  ? 帮助") + "\n")
		renderFrame(b.String())
		k := readKey()
		switch k.Code {
		case keyUp:
			sel = (sel - 1 + len(items)) % len(items)
		case keyDown:
			sel = (sel + 1) % len(items)
		case keyHome:
			sel = 0
		case keyEnd:
			sel = len(items) - 1
		case keyEnter:
			return items[sel].Key
		case keyEsc:
			if allowEsc {
				return ""
			}
		default:
			r := k.Rune
			if r == 'q' || r == 'Q' {
				return "exit"
			}
			if r >= '1' && r <= '9' {
				idx := int(r - '1')
				if idx < len(items) {
					return items[idx].Key
				}
			}
			if r == '?' {
				showHelpScreen()
			}
		}
	}
}

// Static intermediate screens share the same rounded frame compositor as menus.
// The old drawTop/uiPrintln path printed outside the frame and leaked characters
// from earlier screens. All result/preflight/help screens now use in-place output.
func drawTop(title, subtitle string) {
	legacyFrameActive = true
	legacyFrameBuffer.Reset()
	legacyFrameBuffer.WriteString(topFrame(title, subtitle))
	renderFrame(legacyFrameBuffer.String())
}

func showHelpScreen() {
	clearScreen()
	drawTop("快捷键", "终端交互")
	uiPrintln("  " + cyan("↑ / ↓") + "   移动选择")
	uiPrintln("  " + cyan("Enter") + "   确认")
	uiPrintln("  " + cyan("Esc") + "     返回")
	uiPrintln("  " + cyan("Q") + "       退出")
	uiPrintln("  " + cyan("1-9") + "     快速选择")
	uiPrintln("")
	uiPrintln("  " + dim("网页 Viewer 内还有 Ctrl+K、/、T、G、?、方向键等快捷键。"))
	waitAnyKey("返回")
}

func (a *App) importJSONInteractive(path string, buildNow bool) (WorkspaceMeta, bool, error) {
	var meta WorkspaceMeta
	var existed bool
	err := runOperation("导入聊天", "解析并增量合并 result.json", "正在读取源数据", func(ctx context.Context, update func(OperationProgress)) error {
		update(OperationProgress{Stage: "正在解析 result.json", Detail: path})
		var er error
		meta, existed, er = a.importResultJSONMode(path, buildNow)
		if er == nil {
			update(OperationProgress{Stage: "源数据已合并", Detail: fmt.Sprintf("%s · %d 条消息", meta.Chat.Name, meta.MessageCount)})
		}
		return er
	})
	return meta, existed, err
}

func (a *App) handleDroppedJSON(paths []string) {
	clearScreen()
	drawTop("检测到拖拽文件", "自动识别 result.json")
	var imported []WorkspaceMeta
	for _, p := range paths {
		uiPrintln("  " + dim("读取 ") + p)
		m, existed, err := a.importJSONInteractive(p, false)
		if err != nil {
			uiPrintln("  " + red("× ") + err.Error())
			continue
		}
		word := "新增"
		if existed {
			word = "更新/合并"
		}
		uiPrintln("  " + green("✓ ") + word + "：" + m.Chat.Name + fmt.Sprintf(" · %d 条消息", m.MessageCount))
		imported = append(imported, m)
	}
	_ = a.buildLibrary()
	if len(imported) == 0 {
		waitAnyKey("没有成功导入任何聊天，按任意键返回")
		return
	}
	if len(imported) == 1 {
		items := []menuItem{{Key: "sync", Icon: "✦", Label: "立即一键完成（推荐）", Desc: "补齐媒体、生成网页并打开"}, {Key: "back", Icon: "←", Label: "只登记源数据", Desc: "不下载媒体；稍后可在聊天管理中同步"}}
		if runMenu("导入完成", imported[0].Chat.Name, nil, items, true) == "sync" {
			a.actionOneClick(&imported[0])
		}
	} else {
		items := []menuItem{{Key: "sync", Icon: "✦", Label: "同步刚导入的全部聊天（推荐）", Desc: fmt.Sprintf("依次补齐 %d 个聊天的媒体并刷新归档库", len(imported))}, {Key: "back", Icon: "←", Label: "只登记源数据", Desc: "暂不下载媒体"}}
		if runMenu("批量导入完成", fmt.Sprintf("%d 个聊天已登记", len(imported)), nil, items, true) == "sync" {
			for i := range imported {
				if err := a.preflight(imported[i].Slug); err != nil {
					showErrorAndWait(err)
					continue
				}
				if err := a.smartSync(imported[i].Slug); err != nil {
					showErrorAndWait(err)
				}
				_, _ = a.buildWorkspaceMode(imported[i].Slug, false)
			}
			_ = a.buildLibrary()
			a.actionOpenLibrary(imported[len(imported)-1].Slug)
		}
	}
}

func (a *App) actionAddChats(autoSync bool) []WorkspaceMeta {
	var choice string
	for {
		items := []menuItem{
			{Key: "browse", Icon: "▣", Label: "选择 result.json", Desc: "支持一次选择多个 JSON；导入后默认继续补齐媒体"},
			{Key: "official", Icon: "⇢", Label: "继承官方 ChatExport 文件夹", Desc: "旧版 Telegram Desktop HTML 可直接纳管；已有媒体会被识别并跳过下载"},
			{Key: "paste", Icon: "⌁", Label: "粘贴 / 输入文件路径", Desc: "也可以把 result.json 直接拖到 TelegramArchiveKit.exe 上"},
			{Key: "library", Icon: "◫", Label: "更换保存位置", Desc: "当前：" + a.Settings.LibraryRoot},
			{Key: "back", Icon: "←", Label: "返回", Desc: ""},
		}
		status := []string{"目标档案库   " + a.Settings.LibraryRoot, "规则         每个 Chat ID 独立保存；同一聊天再次导入会按 Message ID 增量合并"}
		choice = runMenu("添加 / 更新聊天", "result.json 只是入口；媒体、网页和源数据统一由档案库管理", status, items, true)
		if choice == "library" {
			a.switchLibraryInteractive()
			continue
		}
		if choice == "official" {
			a.actionImportOfficialExport()
			return nil
		}
		break
	}
	var paths []string
	if choice == "browse" {
		p, err := selectJSONFiles()
		if err != nil {
			showErrorAndWait(err)
			return nil
		}
		paths = p
	}
	if choice == "paste" {
		clearScreen()
		drawTop("输入路径", "支持带引号的 Windows 路径")
		showCursor()
		p := readLinePrompt("result.json")
		hideCursor()
		if p != "" {
			paths = []string{strings.Trim(p, `"`)}
		}
	}
	if len(paths) == 0 {
		return nil
	}
	clearScreen()
	drawTop("导入聊天", "同一聊天会按 Message ID 增量合并，不会与其他聊天冲突")
	var imported []WorkspaceMeta
	for _, p := range paths {
		m, existed, err := a.importJSONInteractive(p, !autoSync)
		if err != nil {
			uiPrintln("  " + red("× ") + filepath.Base(p) + " · " + err.Error())
			continue
		}
		verb := "新增"
		if existed {
			verb = "更新/合并"
		}
		uiPrintln("  " + green("✓ ") + verb + " · " + m.Chat.Name + fmt.Sprintf(" · %d 条消息", m.MessageCount))
		imported = append(imported, m)
	}
	_ = a.buildLibrary()
	if len(imported) == 0 {
		waitAnyKey("没有成功导入聊天，按任意键返回")
		return imported
	}
	if autoSync {
		if len(imported) == 1 {
			a.actionOneClick(&imported[0])
		} else {
			// Multiple JSON files are a batch import: sync only the newly imported chats.
			for i := range imported {
				if err := a.preflight(imported[i].Slug); err != nil {
					showErrorAndWait(err)
					continue
				}
				if err := a.smartSync(imported[i].Slug); err != nil {
					showErrorAndWait(err)
				}
				_, _ = a.buildWorkspaceMode(imported[i].Slug, false)
			}
			_ = a.buildLibrary()
			a.actionOpenLibrary(imported[len(imported)-1].Slug)
		}
	} else {
		waitAnyKey("JSON 已登记（未下载媒体）。按任意键返回")
	}
	return imported
}

func (a *App) actionOneClick(selected *WorkspaceMeta) {
	if selected == nil {
		a.actionAddChats(true)
		return
	}
	if !fileExists(a.sourcePath(selected.Slug)) {
		items := []menuItem{
			{Key: "json", Icon: "▣", Label: "导入全量 result.json 并继续", Desc: "官方 HTML 已经纳管；全量 JSON 用来识别最新消息和精准补齐缺失媒体"},
			{Key: "open", Icon: "◎", Label: "先打开现有官方归档", Desc: "当前只有旧 ChatExport，还没有可自动更新的 JSON 数据源"},
			{Key: "back", Icon: "←", Label: "返回", Desc: ""},
		}
		c := runMenu("缺少 result.json", selected.Chat.Name, []string{"已继承官方 ChatExport，但要继续补齐到最新消息，需要导入一次全量 result.json。"}, items, true)
		if c == "json" {
			a.actionAddChats(true)
		} else if c == "open" {
			a.actionOpenLibrary(selected.Slug)
		}
		return
	}
	if err := a.preflight(selected.Slug); err != nil {
		showErrorAndWait(err)
		return
	}

	allowPartial := false
	for {
		syncErr := a.smartSync(selected.Slug)
		if syncErr == nil {
			break
		}
		choice := a.syncFailureMenu(selected.Slug, syncErr)
		switch choice {
		case "retry":
			continue
		case "login":
			if err := a.loginInteractive("qr"); err != nil {
				showErrorAndWait(err)
				continue
			}
			continue
		case "partial":
			allowPartial = true
		default:
			return
		}
		break
	}

	arc, err := a.buildWorkspaceInteractive(selected.Slug, selected.Chat.Name)
	if err != nil {
		showErrorAndWait(err)
		return
	}
	_ = allowPartial
	_ = arc
	if a.Settings.OpenAfterBuild {
		time.Sleep(220 * time.Millisecond)
		a.actionOpenLibrary(selected.Slug)
		return
	}
	waitAnyKey("完成")
}

func (a *App) syncFailureMenu(slug string, syncErr error) string {
	var tf *TdlFailure
	_ = errors.As(syncErr, &tf)
	meta, _ := a.readWorkspaceMeta(slug)
	missing, _, _, _ := a.estimateMissingMedia(slug)
	totalExpected := meta.MediaCount + missing
	if totalExpected < missing {
		totalExpected = missing
	}
	downloaded := max(0, totalExpected-missing)
	kind := "同步未完成"
	reason := syncErr.Error()
	logPath := ""
	if tf != nil {
		reason = tf.Summary
		logPath = tf.LogPath
		if tf.Kind == tdlFailureAuth {
			kind = "Telegram 授权不可用"
		}
		if tf.Kind == tdlFailureNetwork {
			kind = "网络重试窗口已结束"
		}
	}
	for {
		status := []string{
			red("× ") + kind,
			"原因       " + reason,
			fmt.Sprintf("本地进度   %d / %d 媒体项已保留 · 缺失 %d", downloaded, max(totalExpected, missing), missing),
			"数据安全   已完成文件不会删除；重试会按实际文件重新计算",
		}
		if logPath != "" {
			status = append(status, "日志       "+logPath)
		}
		items := []menuItem{{Key: "retry", Icon: "↻", Label: "重新同步（推荐）", Desc: "从当前实际文件继续，不会从零开始"}}
		if tf != nil && tf.Kind == tdlFailureAuth {
			items = append(items, menuItem{Key: "login", Icon: "◉", Label: "重新登录 Telegram 后继续", Desc: "只在授权明确失效时需要"})
		}
		if logPath != "" {
			items = append(items, menuItem{Key: "log", Icon: "≡", Label: "打开完整 tdl 日志", Desc: "查看原始错误堆栈和网络信息"})
		}
		items = append(items,
			menuItem{Key: "partial", Icon: "△", Label: "生成当前可用网页", Desc: "允许浏览文字和已下载媒体；缺失媒体会明确标注"},
			menuItem{Key: "back", Icon: "←", Label: "返回主菜单", Desc: "稍后可再次一键完成"},
		)
		c := runMenu("同步暂停", meta.Chat.Name, status, items, true)
		if c == "log" {
			_ = systemOpen(logPath)
			continue
		}
		if c == "" {
			return "back"
		}
		return c
	}
}

func (a *App) preflight(slug string) error {
	if !fileExists(a.sourcePath(slug)) {
		return fmt.Errorf("聊天源数据不存在")
	}
	meta, _ := a.readWorkspaceMeta(slug)
	chatName := meta.Chat.Name
	if strings.TrimSpace(chatName) == "" {
		chatName = "当前聊天"
	}

	var (
		beautifierErr       error
		ffmpegErr           error
		ffmpegPath          string
		beautifierExact     bool
		missing, knownCount int
		knownBytes          int64
		estimateErr         error
		tdl                 string
		tdlErr              error
	)

	// Preflight can touch GitHub, scan thousands of media files and install tdl.
	// None of those operations should ever look like the program froze, so they run
	// behind the same in-place operation UI used by other long-running work.
	err := runOperation("环境预检", chatName, "正在检查依赖、磁盘与媒体状态", func(ctx context.Context, update func(OperationProgress)) error {
		update(OperationProgress{Stage: "正在检查 Beautifier 主题资源", Detail: "写入内置优化主题，消息 Viewer 完全离线可用"})
		beautifierErr = a.ensureBeautifierAssets(func(msg string) {
			update(OperationProgress{Stage: "正在检查 Beautifier 主题资源", Detail: msg})
		})
		beautifierExact, _ = a.beautifierAssetStatus()
		if a.Settings.GenerateThumbnails {
			update(OperationProgress{Stage: "正在检查 FFmpeg 视频缩略图依赖", Detail: "优先复用系统/用户级 FFmpeg；如不存在，自动下载经过 SHA-256 验证的 Windows 版本"})
			ffmpegPath, ffmpegErr = ensureFFmpegInstalled(ctx, func(done, total int64, phase string) {
				update(OperationProgress{Stage: phase, Detail: fmt.Sprintf("%s / %s · 来源：FFmpeg 官网推荐的 gyan.dev Windows 构建", humanBytes(done), humanBytes(total)), Current: done, Total: total, Unit: "字节"})
			})
			if ffmpegErr != nil {
				return fmt.Errorf("FFmpeg 视频预览依赖未就绪：%w。请检查网络/代理、磁盘空间，或将 ffmpeg.exe 放到系统 PATH", ffmpegErr)
			}
		}

		update(OperationProgress{Stage: "正在核对已有媒体", Detail: "比对 result.json、TAK 媒体目录和继承的官方 ChatExport"})
		missing, knownCount, knownBytes, estimateErr = a.estimateMissingMedia(slug)
		if estimateErr != nil {
			return estimateErr
		}
		if missing == 0 {
			update(OperationProgress{Stage: "媒体已完整", Detail: "无需连接 Telegram"})
			return nil
		}

		update(OperationProgress{Stage: "正在检查 tdl", Detail: "优先复用系统已安装版本；只有不存在时才安装"})
		tdl, tdlErr = a.ensureTdlInstalled(func(msg string) {
			update(OperationProgress{Stage: "正在准备 tdl", Detail: msg})
		})
		return tdlErr
	})
	if err != nil {
		return err
	}

	clearScreen()
	drawTop("环境预检", "检查完成 · 只有确实需要下载时才要求 Telegram 会话")
	uiPrintln("  " + green("✓") + "  result.json        " + a.sourcePath(slug))
	if beautifierErr != nil {
		uiPrintln("  " + yellow("!") + "  Beautifier         同步失败，继续使用本地/内置兼容资源：" + shortLine(beautifierErr.Error(), 58))
	} else if beautifierExact {
		uiPrintln("  " + green("✓") + "  Beautifier         已加载 Kkwans/telegram-export-beautifier 固定版本")
	} else {
		uiPrintln("  " + yellow("!") + "  Beautifier         当前使用本地兼容主题；不影响媒体下载和数据完整性")
	}

	if a.Settings.GenerateThumbnails && ffmpegErr == nil {
		uiPrintln("  " + green("✓") + "  FFmpeg 视频引擎     " + ffmpegPath)
	}
	free := freeSpaceBytes(a.workspaceDir(slug))
	if free > 0 {
		uiPrintln("  " + green("✓") + fmt.Sprintf("  磁盘剩余           %.1f GB", float64(free)/(1024*1024*1024)))
	}
	if missing == 0 {
		uiPrintln("  " + green("✓") + "  媒体               当前没有缺失项，无需连接 Telegram")
		time.Sleep(220 * time.Millisecond)
		return nil
	}

	detail := fmt.Sprintf("缺失 %d 项", missing)
	if knownBytes > 0 {
		detail += fmt.Sprintf(" · 已知大小 %s（%d/%d 项）", humanBytes(knownBytes), knownCount, missing)
	}
	if free > 0 && knownBytes > int64(free) {
		uiPrintln("  " + red("×") + "  空间预估           " + detail)
		return fmt.Errorf("当前磁盘剩余空间小于已知缺失媒体大小；请切换到更大磁盘，或分库下载后再合并")
	}
	uiPrintln("  " + cyan("•") + "  待补齐媒体         " + detail)
	uiPrintln("  " + green("✓") + "  tdl                " + tdl)

	if isTdlRunning() {
		items := []menuItem{
			{Key: "cancel", Icon: "←", Label: "返回主菜单", Desc: "保留现有 tdl 任务；最安全"},
			{Key: "kill", Icon: "×", Label: "结束现有 tdl.exe 后继续", Desc: "仅在确认旧任务已经卡死时使用"},
		}
		if runMenu("检测到正在运行的 tdl", "不会自动结束其它下载", nil, items, true) != "kill" {
			return errors.New("检测到另一个 tdl.exe 正在运行；已安全取消")
		}
		if err := killAllTdl(); err != nil {
			return err
		}
		time.Sleep(250 * time.Millisecond)
	}

	if hasTdlSessionData() {
		uiPrintln("  " + green("✓") + "  tdl 本地数据       已发现 " + tdlDataDir())
		uiPrintln("  " + cyan("•") + "  Telegram 授权      真正下载时直接验证；临时断网/切节点会自动重试")
		time.Sleep(220 * time.Millisecond)
		return nil
	}
	uiPrintln("  " + yellow("!") + "  Telegram 会话      未发现本地会话，需要登录一次")
	return a.loginInteractive("qr")
}

func (a *App) smartSync(slug string) error {
	globalEngineRestarts := 0
	_ = a.removeZeroByteMedia(slug)
	meta, _ := a.readWorkspaceMeta(slug)
	for pass := 1; pass <= a.Settings.MaxRepairPasses; pass++ {
		var missing int
		var path string
		err := runOperation("核对媒体完整性", meta.Chat.Name, "正在比对 result.json、已有媒体和官方 ChatExport", func(ctx context.Context, update func(OperationProgress)) error {
			update(OperationProgress{Stage: fmt.Sprintf("第 %d 轮 · 正在重新计算真正缺失项", pass), Detail: "按 Message ID 与实际文件大小核对；不会相信旧 Resume 状态"})
			var er error
			missing, path, er = a.generateMissingJSON(slug)
			if er == nil {
				update(OperationProgress{Stage: "核对完成", Detail: fmt.Sprintf("仍需补齐 %d 条媒体消息", missing)})
			}
			return er
		})
		if err != nil {
			return err
		}
		if missing == 0 {
			return nil
		}
		if err := a.downloadMissing(slug, path, pass, &globalEngineRestarts); err != nil {
			return err
		}
		_ = a.removeZeroByteMedia(slug)
	}
	arc, err := a.verifyWorkspace(slug)
	if err != nil {
		return err
	}
	if arc.Stats.MissingMedia > 0 {
		return fmt.Errorf("仍有 %d 条媒体未匹配；可稍后再次一键同步", arc.Stats.MissingMedia)
	}
	return nil
}

func (a *App) actionSyncAll() {
	list := a.listWorkspaces()
	if len(list) == 0 {
		showMessage("没有聊天", "请先添加 result.json")
		return
	}
	clearScreen()
	drawTop("同步全部聊天", fmt.Sprintf("共 %d 个", len(list)))
	for i, m := range list {
		uiPrintln(fmt.Sprintf("  %s  [%d/%d] %s", cyan("◆"), i+1, len(list), m.Chat.Name))
		if err := a.preflightSilent(m.Slug); err != nil {
			uiPrintln("  " + red("× ") + err.Error())
			continue
		}
		if err := a.smartSync(m.Slug); err != nil {
			uiPrintln("  " + yellow("! ") + err.Error())
		}
		if _, err := a.buildWorkspaceMode(m.Slug, false); err != nil {
			uiPrintln("  " + red("× build: ") + err.Error())
		}
	}
	_ = a.buildLibrary()
	waitAnyKey("全部处理完成，按任意键返回")
}

func (a *App) preflightSilent(slug string) error {
	if !fileExists(a.sourcePath(slug)) {
		return fmt.Errorf("缺少 result.json")
	}
	missing, _, _, _ := a.estimateMissingMedia(slug)
	if missing == 0 {
		return nil
	}
	if _, err := a.ensureTdlInstalled(nil); err != nil {
		return err
	}
	if !hasTdlSessionData() {
		return fmt.Errorf("Telegram 未登录")
	}
	return nil
}

func (a *App) actionOpenLibrary(slug string) {
	if !fileExists(a.libraryIndex()) {
		if err := a.buildLibrary(); err != nil {
			showErrorAndWait(err)
			return
		}
	}
	target := localFileURL(a.libraryIndex(), slug)
	if err := openInBrowser(target); err != nil {
		showErrorAndWait(err)
		return
	}
	showMessage("已打开归档库", a.Settings.LibraryRoot)
}

func localFileURL(path, chatSlug string) string {
	abs, _ := filepath.Abs(path)
	slash := filepath.ToSlash(abs)
	if runtime.GOOS == "windows" && len(slash) >= 2 && slash[1] == ':' {
		slash = "/" + slash
	}
	u := url.URL{Scheme: "file", Path: slash}
	if chatSlug != "" {
		u.Fragment = "chat=" + chatSlug
	}
	return u.String()
}

func openInBrowser(target string) error {
	return systemOpen(target)
}

func (a *App) chatManager() {
	for {
		list := a.listWorkspaces()
		if len(list) == 0 {
			showMessage("没有聊天", "请先添加 result.json")
			return
		}
		items := make([]menuItem, 0, len(list)+2)
		for _, m := range list {
			badge := fmt.Sprintf("%d 条消息 · %d 媒体", m.MessageCount, m.MediaCount)
			if m.MissingCount > 0 {
				badge += fmt.Sprintf(" · 缺失 %d", m.MissingCount)
			}
			items = append(items, menuItem{Key: m.Slug, Icon: "●", Label: m.Chat.Name, Desc: badge})
		}
		items = append(items, menuItem{Key: "add", Icon: "＋", Label: "添加聊天", Desc: "导入新的 result.json"}, menuItem{Key: "back", Icon: "←", Label: "返回", Desc: ""})
		c := runMenu("聊天管理", "每个聊天拥有独立 source / media / data，不会互相冲突", nil, items, true)
		if c == "" || c == "back" {
			return
		}
		if c == "add" {
			a.actionAddChats(true)
			continue
		}
		a.workspaceActions(c)
	}
}

func (a *App) workspaceActions(slug string) {
	for {
		m, err := a.readWorkspaceMeta(slug)
		if err != nil {
			return
		}
		status := []string{fmt.Sprintf("%d 条消息 · %d 个媒体 · 缺失 %d", m.MessageCount, m.MediaCount, m.MissingCount), a.workspaceDir(slug)}
		items := []menuItem{{Key: "select", Icon: "★", Label: "设为当前聊天", Desc: "主菜单状态和一键完成默认使用它"}, {Key: "one", Icon: "✦", Label: "一键同步并打开", Desc: "补齐媒体、构建、校验"}, {Key: "official", Icon: "📥", Label: "继承 Telegram 官方 ChatExport", Desc: "扫描旧 messages.html；复用 photos / video_files / files 等现有媒体"}, {Key: "build", Icon: "◇", Label: "只重新生成网页", Desc: "不下载媒体"}, {Key: "open", Icon: "◎", Label: "在归档库中打开", Desc: "直接跳转到这个聊天"}, {Key: "media", Icon: "⧉", Label: "导入已有 tdl 媒体目录", Desc: "把旧版 media / media-test2 增量合并进当前聊天"}, {Key: "export", Icon: "◫", Label: "复制 / 抽取到另一档案库", Desc: "把这个聊天完整复制到另一个磁盘或档案库；源数据保持不变"}, {Key: "folder", Icon: "▣", Label: "打开聊天数据目录", Desc: "查看 source / media / report"}, {Key: "delete", Icon: "!", Label: "删除这个本地归档", Desc: "只删除档案库副本，不影响 Telegram"}, {Key: "back", Icon: "←", Label: "返回", Desc: ""}}
		c := runMenu("聊天 · "+m.Chat.Name, "独立工作区", status, items, true)
		switch c {
		case "select":
			a.Settings.LastWorkspaceSlug = slug
			_ = a.saveSettings()
			showMessage("已设为当前聊天", m.Chat.Name)
		case "one":
			a.actionOneClick(&m)
		case "official":
			a.actionImportOfficialExportInto(slug)
		case "build":
			clearScreen()
			drawTop("重新生成", m.Chat.Name)
			arc, er := a.buildWorkspaceInteractive(slug, m.Chat.Name)
			if er != nil {
				showErrorAndWait(er)
			} else {
				showMessage("生成完成", fmt.Sprintf("%d 条消息 · %d 媒体", arc.Stats.Messages, arc.Stats.MediaFiles))
			}
		case "open":
			a.actionOpenLibrary(slug)
		case "media":
			a.importMediaInteractive(slug)
		case "export":
			a.exportChatInteractive(slug)
		case "folder":
			_ = openFolder(a.workspaceDir(slug))
		case "delete":
			if confirmDanger("删除本地聊天归档？", "将删除 source、media 和生成数据；Telegram 云端不会受影响。") {
				if er := a.deleteWorkspace(slug); er != nil {
					showErrorAndWait(er)
				} else {
					showMessage("已删除", m.Chat.Name)
					return
				}
			}
		default:
			return
		}
	}
}

func openFolder(path string) error {
	if runtime.GOOS == "windows" {
		return exec.Command("explorer.exe", path).Start()
	}
	return openInBrowser(path)
}

func (a *App) importMediaInteractive(slug string) {
	p, err := selectFolder("选择已有媒体目录", a.mediaDir(slug))
	if err != nil {
		showErrorAndWait(err)
		return
	}
	if p == "" {
		return
	}
	res, err := runDirectoryTransferUI("导入已有媒体", "增量复制 · 同名同大小自动跳过 · 可安全取消", p, a.mediaDir(slug), false)
	if err != nil {
		showErrorAndWait(err)
		return
	}
	m, _ := a.readWorkspaceMeta(slug)
	_, _ = a.buildWorkspaceInteractive(slug, m.Chat.Name)
	showMessage("媒体导入完成", fmt.Sprintf("新增 %d · 跳过 %d", res.Copied, res.Skipped))
}

func (a *App) accountMenu() {
	for {
		local := "未发现"
		if hasTdlSessionData() {
			local = "已发现 tdl 本地会话数据"
		}
		status := []string{
			"会话目录   " + tdlDataDir(),
			"Namespace  " + a.Settings.TdlNamespace,
			"本地状态   " + local,
			"联网状态   未主动检查（避免 chat ls 的误判和无意义等待）",
		}
		items := []menuItem{
			{Key: "check", Icon: "↻", Label: "连接 / 授权测试", Desc: "显式执行 tdl chat ls；结果只作为诊断，不会自动清除登录"},
			{Key: "qr", Icon: "▣", Label: "二维码登录 / 切换账号", Desc: "仅在首次使用、授权明确失效或切换账号时使用"},
			{Key: "code", Icon: "#", Label: "手机号验证码登录", Desc: "二维码不方便时使用"},
			{Key: "folder", Icon: "▤", Label: "打开 tdl 全局会话目录", Desc: "所有 TelegramArchiveKit 版本共享"},
			{Key: "back", Icon: "←", Label: "返回", Desc: ""},
		}
		c := runMenu("Telegram 账号与会话", "本地会话和网络连通性是两个不同状态", status, items, true)
		switch c {
		case "check":
			a.sessionCheckInteractive()
		case "qr":
			if err := a.loginInteractive("qr"); err != nil {
				showErrorAndWait(err)
			}
		case "code":
			if err := a.loginInteractive("code"); err != nil {
				showErrorAndWait(err)
			}
		case "folder":
			_ = openFolder(tdlDataDir())
		default:
			return
		}
	}
}

func (a *App) sessionCheckInteractive() {
	for {
		result := make(chan SessionStatus, 1)
		go func() { result <- a.testTdlSession(45 * time.Second) }()
		spinner := []string{"◐", "◓", "◑", "◒"}
		idx := 0
		started := time.Now()
		var st SessionStatus
		waiting := true
		for waiting {
			select {
			case st = <-result:
				waiting = false
			case <-time.After(180 * time.Millisecond):
				var b strings.Builder
				b.WriteString(topFrame("Telegram 连接测试", "正在执行 tdl chat ls"))
				b.WriteString("  " + cyan(spinner[idx%len(spinner)]) + "  正在连接 Telegram…  " + muted("已等待 "+formatDuration(time.Since(started))) + "\n\n")
				b.WriteString("  " + muted("此测试会枚举聊天；个别失效/解散聊天也可能让旧版 tdl 返回非 0，因此失败不自动等于登录失效。") + "\n")
				renderFrame(b.String())
				idx++
			}
		}
		icon := green("✓")
		label := "连接正常"
		explain := st.Message
		if st.State == "unauthorized" {
			icon = red("×")
			label = "授权不可用"
		}
		if st.State == "network" || st.State == "timeout" {
			icon = yellow("!")
			label = "网络检查失败"
		}
		if st.State == "check-failed" {
			icon = yellow("!")
			label = "chat ls 检查失败"
		}
		status := []string{icon + "  " + label, "结果       " + explain, fmt.Sprintf("退出码     %d", st.Code)}
		if hasTdlSessionData() {
			status = append(status, "本地会话   已保留 · "+tdlDataDir())
		}
		items := []menuItem{{Key: "retry", Icon: "↻", Label: "再试一次", Desc: "适合刚切换网络/节点后重试"}}
		if st.State == "unauthorized" {
			items = append(items, menuItem{Key: "login", Icon: "◉", Label: "重新登录", Desc: "授权明确失效时使用"})
		}
		items = append(items, menuItem{Key: "back", Icon: "←", Label: "返回", Desc: ""})
		c := runMenu("会话检查结果", a.Settings.TdlNamespace, status, items, true)
		if c == "retry" {
			continue
		}
		if c == "login" {
			if err := a.loginInteractive("qr"); err != nil {
				showErrorAndWait(err)
			}
		}
		return
	}
}

func (a *App) loginInteractive(kind string) error {
	if isTdlRunning() {
		items := []menuItem{
			{Key: "back", Icon: "←", Label: "返回", Desc: "保留当前 tdl 任务"},
			{Key: "kill", Icon: "×", Label: "结束现有 tdl.exe 后登录", Desc: "仅当旧任务已经卡死时使用"},
		}
		if runMenu("tdl 正在运行", "登录前需要避免多个 tdl 同时操作全局会话", nil, items, true) != "kill" {
			return errors.New("已取消登录")
		}
		if err := killAllTdl(); err != nil {
			return err
		}
		time.Sleep(300 * time.Millisecond)
	}
	clearScreen()
	name := "二维码登录"
	if kind == "code" {
		name = "手机号验证码登录"
	}
	drawTop("Telegram "+name, "全局会话 · "+a.Settings.TdlNamespace)
	uiPrintln("  " + cyan("•") + "  tdl          " + fallback(a.resolveTdl(), "准备安装"))
	uiPrintln("  " + cyan("•") + "  会话目录     " + tdlDataDir())
	uiPrintln("  " + cyan("•") + "  重连超时     " + a.Settings.ReconnectTimeout)
	uiPrintln("")
	if kind == "qr" {
		uiPrintln("  " + bold("手机操作") + "  Telegram → 设置 → 设备 → 连接桌面设备")
		uiPrintln("  " + dim("二维码出现后直接扫码，不需要按 Enter。若网络无法连接，tdl 会返回明确错误。"))
	}
	uiPrintln("")
	showCursor()
	err := a.loginTdl(kind)
	hideCursor()
	if err != nil {
		return fmt.Errorf("tdl 登录失败: %w", err)
	}
	if !hasTdlSessionData() {
		return fmt.Errorf("tdl 登录命令已结束，但没有发现本地会话数据")
	}
	uiPrintln("  " + green("✓ 登录成功") + " · 会话已保存到 " + tdlDataDir())
	uiPrintln("  " + muted("不再强制用 chat ls 二次验证；首次实际下载会直接验证授权。"))
	waitAnyKey("登录完成")
	return nil
}

func (a *App) settingsMenu() {
	for {
		thumbState := "关闭"
		if a.Settings.GenerateThumbnails {
			thumbState = "开启（默认）"
		}
		items := []menuItem{{Key: "library", Icon: "▣", Label: "档案库位置", Desc: a.Settings.LibraryRoot}, {Key: "download", Icon: "↓", Label: "下载设置", Desc: fmt.Sprintf("并发 %d · 线程 %d · 超时 %s · Takeout 永久关闭", a.Settings.Concurrent, a.Settings.Threads, a.Settings.ReconnectTimeout)}, {Key: "thumbs", Icon: "▧", Label: "本地缩略图预生成", Desc: thumbState + " · 图片和视频；视频需要 FFmpeg，首次生成显示进度"}, {Key: "ffmpeg", Icon: "▶", Label: "视频预览引擎检查", Desc: "FFmpeg：" + func() string {
			if findFFmpeg() != "" {
				return "已检测到 · 支持为视频提取本地封面"
			}
			return "未安装 · 将提示安装方法，图片缩略图仍正常"
		}()}, {Key: "theme", Icon: "✦", Label: "Beautifier 主题资源", Desc: "使用内置优化版主题，完全离线；可重新写入档案库"}, {Key: "tdl", Icon: "◆", Label: "tdl 工具", Desc: fallback(a.resolveTdl(), "未安装")}, {Key: "diag", Icon: "i", Label: "环境诊断", Desc: "检查配置、目录、tdl、会话、磁盘和聊天状态"}, {Key: "logs", Icon: "≡", Label: "打开日志 / 配置目录", Desc: a.ConfigDir}, {Key: "back", Icon: "←", Label: "返回", Desc: ""}}
		c := runMenu("设置与诊断", "程序设置保存在用户配置目录；档案库可放任意磁盘", nil, items, true)
		switch c {
		case "library":
			a.changeLibraryMenu()
		case "download":
			a.downloadSettingsMenu()
		case "thumbs":
			a.Settings.GenerateThumbnails = !a.Settings.GenerateThumbnails
			_ = a.saveSettings()
		case "ffmpeg":
			if path := findFFmpeg(); path != "" {
				showMessage("FFmpeg 已就绪", path+"\n视频将生成独立 JPEG 预览；请重新构建聊天以补齐封面。")
			} else {
				err := runOperation("准备 FFmpeg", "自动安装视频预览解码器", "正在检查下载来源与 SHA-256", func(ctx context.Context, update func(OperationProgress)) error {
					_, e := ensureFFmpegInstalled(ctx, func(done, total int64, phase string) {
						update(OperationProgress{Stage: phase, Detail: fmt.Sprintf("%s / %s", humanBytes(done), humanBytes(total)), Current: done, Total: total, Unit: "字节"})
					})
					return e
				})
				if err != nil {
					showErrorAndWait(fmt.Errorf("FFmpeg 自动安装失败：%w", err))
				} else {
					showMessage("FFmpeg 安装完成", "现在可重新生成 Viewer，为视频自动补齐预览图")
				}

			}
		case "theme":
			a.refreshBeautifierInteractive()
		case "tdl":
			a.tdlToolsMenu()
		case "diag":
			a.diagnose()
		case "logs":
			_ = openFolder(a.ConfigDir)
		default:
			return
		}
	}
}

func (a *App) changeLibraryMenu() {
	items := []menuItem{{Key: "browse", Icon: "▣", Label: "切换到另一个档案库", Desc: "旧目录保持不动"}, {Key: "migrate", Icon: "⇢", Label: "复制当前档案库到新位置并切换", Desc: "适合迁移到大容量磁盘"}, {Key: "folder", Icon: "◎", Label: "打开当前档案库目录", Desc: a.Settings.LibraryRoot}, {Key: "back", Icon: "←", Label: "返回", Desc: ""}}
	c := runMenu("档案库位置", "默认不放在程序目录，避免升级版本时复制海量媒体", nil, items, true)
	if c == "folder" {
		_ = openFolder(a.Settings.LibraryRoot)
		return
	}
	if c == "" || c == "back" {
		return
	}
	newRoot, err := selectFolder("选择新的 Telegram Archive Library 目录", filepath.Dir(a.Settings.LibraryRoot))
	if err != nil {
		showErrorAndWait(err)
		return
	}
	if newRoot == "" {
		return
	}
	if c == "migrate" {
		res, er := runDirectoryTransferUI("迁移档案库", "复制后保留原目录作为安全备份 · 低优先级 I/O 保持系统响应", a.Settings.LibraryRoot, newRoot, false)
		if er != nil {
			showErrorAndWait(er)
			return
		}
		_ = res
	}
	a.Settings.LibraryRoot = newRoot
	_ = a.saveSettings()
	_ = a.ensureLibraryDirs()
	_ = a.buildLibrary()
	showMessage("档案库位置已更新", newRoot)
}

func (a *App) refreshBeautifierInteractive() {
	clearScreen()
	drawTop("Beautifier 主题", "写入内置优化版主题（基于 telegram-export-beautifier）")
	uiPrintln("  " + muted("主题来源：TelegramArchiveKit 内置 · themeVersion " + builtinThemeVersion + " · 完全离线"))
	uiPrintln("")
	_ = os.Remove(a.beautifierStyle())
	_ = os.Remove(a.beautifierScript())
	_ = os.Remove(filepath.Join(a.beautifierDir(), "SOURCE.txt"))
	err := a.ensureBeautifierAssets(func(msg string) { uiPrintln("  " + cyan("• ") + msg) })
	if err != nil {
		showErrorAndWait(err)
		return
	}
	_ = a.buildLibrary()
	source := "已更新"
	if b, er := os.ReadFile(filepath.Join(a.beautifierDir(), "SOURCE.txt")); er == nil {
		source = strings.TrimSpace(string(b))
	}
	waitAnyKey("✓ 主题资源就绪 · " + source)
}

func (a *App) downloadSettingsMenu() {
	for {
		status := []string{
			fmt.Sprintf("当前方案     %d 个文件任务 × 每文件 %d 线程", a.Settings.Concurrent, a.Settings.Threads),
			"含义         并发任务 = 同时下载多少个媒体文件；单文件线程 = 一个文件内部并行分片数",
			"推荐依据     2×4 是 tdl 上游默认值；卡住个别媒体时优先处理其他文件",
			fmt.Sprintf("卡死保护     %d 秒无进展：暂缓问题文件→先完成其他资源→队尾重试", a.Settings.StallTimeoutSeconds),
		}
		items := []menuItem{
			{Key: "recommended", Icon: "★", Label: "推荐稳定方案：2 × 4", Desc: "默认 · Telegram 友好 · 已实测稳定；不是按电脑性能限制"},
			{Key: "fast", Icon: "⚡", Label: "快速试验方案：4 × 4", Desc: "同时 4 个文件；可能更快，也更容易受 Telegram/DC/网络限制影响，建议只做 A/B 测试"},
			{Key: "con", Icon: "↕", Label: fmt.Sprintf("自定义并发文件任务：%d", a.Settings.Concurrent), Desc: "TAK 允许 1–8；这只是工具侧安全范围，不代表 Telegram 官方公布了 8 的上限"},
			{Key: "thr", Icon: "≋", Label: fmt.Sprintf("自定义单文件线程：%d", a.Settings.Threads), Desc: "TAK 允许 1–16；线程越高并不必然更快"},
			{Key: "retry", Icon: "↻", Label: fmt.Sprintf("网络自动恢复窗口：%d 分钟", a.Settings.NetworkRetryMinutes), Desc: "切节点/短暂断网后自动等待并重试；已完成文件不会重下"},
			{Key: "stall", Icon: "◷", Label: fmt.Sprintf("无进展暂缓阈值：%d 秒", a.Settings.StallTimeoutSeconds), Desc: "无字节/百分比进展：先暂缓该文件，下载其他资源，队尾按用户设定次数重试"},

			{Key: "file-retry", Icon: "↻", Label: fmt.Sprintf("疑难文件重试次数：%d 次 / 轮", a.Settings.StalledFileRetries), Desc: "正常文件优先；失败文件在队尾重试。仅在全部文件重试耗尽后诊断并整体重启一次"},
			{Key: "adjust", Icon: "↗", Label: "重试传输策略：" + map[string]string{"increase": "逐步增加线程（推荐）", "increase-both": "线程和并发一起增加（试验）", "decrease": "逐步降低线程", "keep": "保持原配置"}[a.Settings.TransferAdjustment], Desc: "仅作用于疑难媒体重试；整个任务不会因为单文件卡住而无故降并发"},
			{Key: "unknown", Icon: "?", Label: fmt.Sprintf("未知错误自动重试：%d 次", a.Settings.UnknownRetryCount), Desc: "错误特征不明确时先自愈，再把完整上下文交给你"},
			{Key: "proxy", Icon: "↗", Label: "代理", Desc: fallback(a.Settings.Proxy, "自动 / 系统网络 / TUN")},
			{Key: "back", Icon: "←", Label: "返回", Desc: ""},
		}
		c := runMenu("下载设置", "默认优先可靠性；高并发是可选实验项，不把电脑性能误当成 Telegram 服务端能力", status, items, true)
		switch c {
		case "recommended":
			a.Settings.Concurrent, a.Settings.Threads = 2, 4
			_ = a.saveSettings()
		case "fast":
			if confirmSimple("4×4 会把同时下载的文件数从 2 提升到 4。若遇到 Flood Wait、网络抖动或速度反而下降，请恢复 2×4。继续？") {
				a.Settings.Concurrent, a.Settings.Threads = 4, 4
				_ = a.saveSettings()
			}
		case "con":
			a.Settings.Concurrent = chooseNumber("并发文件任务", 1, 8, a.Settings.Concurrent)
			_ = a.saveSettings()
		case "thr":
			a.Settings.Threads = chooseNumber("单文件线程", 1, 16, a.Settings.Threads)
			_ = a.saveSettings()
		case "retry":
			a.Settings.NetworkRetryMinutes = chooseNumber("网络自动恢复窗口（分钟）", 1, 180, a.Settings.NetworkRetryMinutes)
			_ = a.saveSettings()
		case "stall":
			a.Settings.StallTimeoutSeconds = chooseNumber("无进展暂缓阈值（秒）", 30, 600, a.Settings.StallTimeoutSeconds)
			_ = a.saveSettings()
		case "file-retry":
			a.Settings.StalledFileRetries = chooseNumber("每个疑难文件重试次数 / 轮", 1, 10, a.Settings.StalledFileRetries)
			_ = a.saveSettings()
		case "adjust":
			opts := []menuItem{{Key: "increase", Icon: "↗", Label: "逐步增加线程（默认）", Desc: "疑难文件重试时每次增加传输线程，上限 16"}, {Key: "increase-both", Icon: "⇈", Label: "线程和并发一起增加（试验）", Desc: "第一轮疑难重试升线程；只在唯一一次整体诊断重启后增大文件并发"}, {Key: "decrease", Icon: "↘", Label: "逐步降低线程", Desc: "适合怀疑 Telegram/DC 对高并发敏感时"}, {Key: "keep", Icon: "→", Label: "保持设置", Desc: "不在重试时更改文件或线程数"}, {Key: "back", Icon: "←", Label: "返回"}}
			if mode := runMenu("疑难文件重试策略", "只调整疑难文件；优先处理其余媒体", nil, opts, true); mode == "increase" || mode == "increase-both" || mode == "decrease" || mode == "keep" {
				a.Settings.TransferAdjustment = mode
				_ = a.saveSettings()
			}
		case "unknown":
			a.Settings.UnknownRetryCount = chooseNumber("未知错误自动重试次数", 0, 10, a.Settings.UnknownRetryCount)
			_ = a.saveSettings()
		case "proxy":
			clearScreen()
			drawTop("tdl 代理", "留空表示系统/TUN/直连；示例 socks5://127.0.0.1:7890")
			showCursor()
			a.Settings.Proxy = strings.TrimSpace(readLinePrompt("Proxy"))
			hideCursor()
			_ = a.saveSettings()
		default:
			return
		}
	}
}

func chooseNumber(title string, min, max, current int) int {
	clearScreen()
	drawTop(title, fmt.Sprintf("范围 %d-%d · 当前 %d", min, max, current))
	showCursor()
	s := readLinePrompt("输入数字")
	hideCursor()
	n, err := strconv.Atoi(s)
	if err == nil && n >= min && n <= max {
		return n
	}
	return current
}

func (a *App) tdlToolsMenu() {
	items := []menuItem{{Key: "install", Icon: "↓", Label: "安装 / 更新全局 tdl", Desc: globalTdlExe()}, {Key: "kill", Icon: "!", Label: "强制结束所有 tdl.exe", Desc: "仅在 tdl 卡死、Esc 也无法中止时使用"}, {Key: "folder", Icon: "▤", Label: "打开 tdl 程序目录", Desc: globalTdlDir()}, {Key: "back", Icon: "←", Label: "返回", Desc: ""}}
	c := runMenu("tdl 工具", "tdl.exe 全局安装；Telegram 会话保存在 %USERPROFILE%\\.tdl", nil, items, true)
	switch c {
	case "install":
		clearScreen()
		drawTop("安装 / 更新 tdl", "官方 GitHub Release + SHA-256 校验")
		if err := installLatestTdl(func(s string) { uiPrintln("  " + cyan("•") + "  " + s) }); err != nil {
			showErrorAndWait(err)
		} else {
			showMessage("tdl 已就绪", globalTdlExe())
		}
	case "kill":
		if err := killAllTdl(); err != nil {
			showMessage("tdl 进程", "没有找到运行中的 tdl.exe，或结束命令未生效")
		} else {
			showMessage("tdl 进程", "已强制结束")
		}
	case "folder":
		_ = openFolder(globalTdlDir())
	}
}

func (a *App) diagnose() {
	clearScreen()
	drawTop("环境诊断", "不会修改任何设置")
	rows := [][2]string{{"版本", version}, {"程序目录", a.ExeDir}, {"配置文件", a.ConfigPath}, {"档案库", a.Settings.LibraryRoot}, {"聊天数量", fmt.Sprint(len(a.listWorkspaces()))}, {"tdl", fallback(a.resolveTdl(), "未安装")}, {"tdl 版本", fallback(a.tdlVersion(), "未知")}, {"tdl 会话目录", tdlDataDir()}, {"会话文件", mapBool(hasTdlSessionData(), "已发现", "未发现")}, {"Namespace", a.Settings.TdlNamespace}}
	for _, r := range rows {
		uiPrintln("  " + kvText(r[0], r[1], 14))
	}
	uiPrintln("")
	uiPrintln("  Telegram 联网验证   正在检查，最长等待 12 秒…")
	s := a.testTdlSession(12 * time.Second)
	if s.State == "ready" {
		uiPrintln("  " + green("连接正常") + " · " + s.Message)
	} else {
		uiPrintln("  " + yellow("连接检查未通过") + " · " + shortLine(s.Message, 78))
	}
	if free := freeSpaceBytes(a.Settings.LibraryRoot); free > 0 {
		uiPrintln("  " + kvText("磁盘剩余", fmt.Sprintf("%.1f GB", float64(free)/(1024*1024*1024)), 14))
	}
	uiPrintln("")
	uiPrintln("  " + dim("重要：会话验证失败不等于登录失效；网络/代理/残留进程也会导致失败。"))
	waitAnyKey("按任意键返回")
}

func runSelfTest(a *App) error {
	tmp, err := os.MkdirTemp("", "tak-selftest-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	a.Settings.LibraryRoot = filepath.Join(tmp, "library")
	if err := a.ensureLibraryDirs(); err != nil {
		return err
	}
	// Keep selftest deterministic/offline: materialize the built-in theme.
	if err := a.ensureBeautifierAssets(nil); err != nil {
		return err
	}
	sample := map[string]any{"name": "Self Test", "type": "public_channel", "id": 12345, "messages": []any{map[string]any{"id": 1, "type": "message", "date": "2026-01-01T00:00:00", "date_unixtime": "1767225600", "text": "hello"}}}
	b, _ := json.Marshal(sample)
	src := filepath.Join(tmp, "result.json")
	_ = os.WriteFile(src, b, 0644)
	m, _, err := a.importResultJSON(src)
	if err != nil {
		return err
	}
	arc, err := a.buildWorkspace(m.Slug)
	if err != nil {
		return err
	}
	if arc.Stats.Messages != 1 {
		return fmt.Errorf("unexpected message count")
	}
	if !fileExists(a.libraryIndex()) {
		return fmt.Errorf("library index missing")
	}
	if !fileExists(filepath.Join(a.workspaceDir(m.Slug), "messages.html")) {
		return fmt.Errorf("beautifier-compatible messages.html missing")
	}
	return nil
}

func buildStandalone(jsonPath, mediaDir, outDir string) error {
	arc, err := buildArchive(jsonPath, mediaDir)
	if err != nil {
		return err
	}
	_ = os.MkdirAll(filepath.Join(outDir, "data"), 0755)
	payload, _ := json.Marshal(arc)
	js := append([]byte("window.__TAK_CHAT_DATA__ = "), payload...)
	js = append(js, []byte(";\n")...)
	return os.WriteFile(filepath.Join(outDir, "data", "archive-data.js"), js, 0644)
}

func fatalScreen(err error) {
	terminalInit()
	clearScreen()
	drawTop("启动失败", "TelegramArchiveKit 无法继续")
	uiPrintln("  " + red("× ") + err.Error())
	uiPrintln("")
	uiPrintln("  " + dim("如果是双击启动，此窗口会停留，方便截图错误。"))
	waitAnyKey("按任意键关闭")
}
func showErrorAndWait(err error) {
	clearScreen()
	drawTop("操作失败", "错误信息已保留在屏幕上")
	uiPrintln("  " + red("× ") + err.Error())
	uiPrintln("")
	waitAnyKey("按任意键返回")
}
func showMessage(title, msg string) {
	clearScreen()
	drawTop(title, "TelegramArchiveKit")
	uiPrintln("  " + green("✓ ") + msg)
	uiPrintln("")
	waitAnyKey("按任意键返回")
}
func waitAnyKey(msg string) {
	flushInput()
	if legacyFrameActive {
		uiPrintln("")
		uiPrintln("  " + muted(msg))
		uiPrintln("Esc / Enter / 任意键返回")
	} else {
		uiPrintln("")
		uiPrintln("  " + muted(msg))
	}
	for {
		k := readKey()
		if k.Code == keyEnter || k.Code == keyEsc || k.Rune != 0 {
			legacyFrameActive = false
			return
		}
	}
}
func confirmSimple(msg string) bool {
	return runMenu("确认", msg, nil, []menuItem{{Key: "yes", Icon: "✓", Label: "继续", Desc: ""}, {Key: "no", Icon: "←", Label: "取消", Desc: ""}}, true) == "yes"
}
func confirmDanger(title, msg string) bool {
	return runMenu(title, msg, nil, []menuItem{{Key: "no", Icon: "←", Label: "取消", Desc: "推荐"}, {Key: "yes", Icon: "!", Label: "确认删除", Desc: "此操作无法从 TelegramArchiveKit 中撤销"}}, true) == "yes"
}
func shortLine(s string, n int) string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r", " "), "\n", " ")
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
func fallback(s, d string) string {
	if strings.TrimSpace(s) == "" {
		return d
	}
	return s
}
func mapBool(v bool, a, b string) string {
	if v {
		return a
	}
	return b
}
func (a *App) logf(format string, args ...any) {
	if a.Settings.LibraryRoot == "" {
		return
	}
	_ = os.MkdirAll(a.logsDir(), 0755)
	f := filepath.Join(a.logsDir(), "tak-"+time.Now().Format("20060102")+".log")
	h, err := os.OpenFile(f, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return
	}
	defer h.Close()
	_, _ = fmt.Fprintf(h, "%s  %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, args...))
}
func sortWorkspaceByName(xs []WorkspaceMeta) {
	sort.Slice(xs, func(i, j int) bool { return xs[i].Chat.Name < xs[j].Chat.Name })
}
