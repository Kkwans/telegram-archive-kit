package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"html"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// builtinThemeVersion identifies the built-in Beautifier theme edition bundled
// with this build; it is recorded in each library's SOURCE.txt so diagnostics
// can spot a stale materialized theme from an older TAK build.
const builtinThemeVersion = "1"

//go:embed ui/beautifier-theme.css ui/beautifier-theme.js
var beautifierThemeFS embed.FS

func (a *App) beautifierDir() string {
	return filepath.Join(a.Settings.LibraryRoot, "assets", "beautifier")
}
func (a *App) beautifierStyle() string  { return filepath.Join(a.beautifierDir(), "style.css") }
func (a *App) beautifierScript() string { return filepath.Join(a.beautifierDir(), "script.js") }

func (a *App) beautifierAssetStatus() (exact bool, source string) {
	b, _ := os.ReadFile(filepath.Join(a.beautifierDir(), "SOURCE.txt"))
	source = strings.TrimSpace(string(b))
	exact = strings.Contains(source, "TelegramArchiveKit built-in theme") &&
		strings.Contains(source, "themeVersion="+builtinThemeVersion) &&
		fileSizeAtLeast(a.beautifierStyle(), 1) && fileSizeAtLeast(a.beautifierScript(), 1)
	if source == "" {
		source = "未记录"
	}
	return exact, source
}

func fileSizeAtLeast(path string, n int64) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir() && st.Size() >= n
}

// ensureBeautifierAssets materializes the built-in Beautifier theme into the
// library. The theme is a self-contained optimized edition of
// Kkwans/telegram-export-beautifier bundled with the binary: fully offline,
// no runtime downloads. Files are always rewritten so a theme shipped in a
// newer TAK build replaces whatever an older build left behind.
func (a *App) ensureBeautifierAssets(progress func(string)) error {
	if progress != nil {
		progress("正在写入内置 Beautifier 主题")
	}
	if err := os.MkdirAll(a.beautifierDir(), 0755); err != nil {
		return err
	}
	css, err := beautifierThemeFS.ReadFile("ui/beautifier-theme.css")
	if err != nil {
		return err
	}
	js, err := beautifierThemeFS.ReadFile("ui/beautifier-theme.js")
	if err != nil {
		return err
	}
	if err := os.WriteFile(a.beautifierStyle(), css, 0644); err != nil {
		return err
	}
	if err := os.WriteFile(a.beautifierScript(), js, 0644); err != nil {
		return err
	}
	source := "TelegramArchiveKit built-in theme\nedition=optimized (based on Kkwans/telegram-export-beautifier)\nthemeVersion=" + builtinThemeVersion + "\n"
	return os.WriteFile(filepath.Join(a.beautifierDir(), "SOURCE.txt"), []byte(source), 0644)
}

const messagesPerPage = 1000

// groupMediaAlbums preserves Telegram albums recorded with grouped_id. When the
// Desktop JSON omitted grouping metadata for a sequential batch of *documents*,
// apply a deliberately narrow visual fallback so a native file bundle does not
// degenerate into a separate giant message bubble per video. It is an inference,
// not an assertion that the original client grouping can be recovered exactly.
func groupMediaAlbums(messages []Message) []Message {
	out := make([]Message, 0, len(messages))
	for _, m := range messages {
		m.SourceIDs = []string{m.ID}
		if n := len(out); n > 0 {
			base := &out[n-1]
			explicit := m.GroupedID != "" && m.Type != "service" && base.GroupedID == m.GroupedID && base.From == m.From && (m.TS == 0 || base.TS == 0 || abs64(m.TS-base.TS) <= 600)
			inferred := looksLikeDocumentBatch(*base, m)
			if explicit || inferred {
				base.SourceIDs = append(base.SourceIDs, m.ID)
				base.Media = append(base.Media, m.Media...)
				base.ExpectedMedia = base.ExpectedMedia || m.ExpectedMedia
				if strings.TrimSpace(m.Text) != "" {
					if base.Text != "" {
						base.Text += "\n"
					}
					base.Text += m.Text
					base.Entities = nil
				}
				continue
			}
		}
		out = append(out, m)
	}
	return out
}

// groupStrictAlbums never invents a group. The optional original view only
// groups messages when Telegram supplied a shared grouped_id.
func groupStrictAlbums(messages []Message) []Message {
	out := make([]Message, 0, len(messages))
	for _, original := range messages {
		m := original
		m.SourceIDs = []string{m.ID}
		if len(out) > 0 {
			base := &out[len(out)-1]
			if m.GroupedID != "" && base.GroupedID == m.GroupedID &&
				base.From == m.From && base.Type != "service" && m.Type != "service" &&
				(m.TS == 0 || base.TS == 0 || abs64(m.TS-base.TS) <= 600) {
				base.SourceIDs = append(base.SourceIDs, m.ID)
				base.Media = append(base.Media, m.Media...)
				base.ExpectedMedia = base.ExpectedMedia || m.ExpectedMedia
				if strings.TrimSpace(m.Text) != "" {
					if base.Text != "" {
						base.Text += "\n"
					}
					base.Text += m.Text
					base.Entities = nil
				}
				continue
			}
		}
		out = append(out, m)
	}
	return out
}

func isDocumentMedia(m Message) bool {
	if len(m.Media) == 0 {
		return false
	}
	mt := strings.ToLower(m.MediaType)
	if strings.Contains(mt, "file") || strings.Contains(mt, "document") {
		return true
	}
	for _, media := range m.Media {
		name := strings.ToLower(media.Name)
		if !strings.Contains(name, "document_") && media.Kind != "file" {
			return false
		}
	}
	return true
}
func looksLikeDocumentBatch(base, m Message) bool {
	if base.GroupedID != "" || m.GroupedID != "" || base.Type == "service" || m.Type == "service" {
		return false
	}
	if base.From != m.From || base.From == "" || base.TS <= 0 || m.TS <= 0 || m.TS < base.TS || m.TS-base.TS > 90 {
		return false
	}
	if len(base.Media) >= 10 || len(m.Media) != 1 || !isDocumentMedia(base) || !isDocumentMedia(m) {
		return false
	}
	if strings.TrimSpace(base.Text) != "" || strings.TrimSpace(m.Text) != "" || base.ReplyTo != "" || m.ReplyTo != "" || base.ForwardedFrom != "" || m.ForwardedFrom != "" {
		return false
	}
	if len(base.SourceIDs) == 0 {
		return false
	}
	prev, e1 := strconv.ParseInt(base.SourceIDs[len(base.SourceIDs)-1], 10, 64)
	now, e2 := strconv.ParseInt(m.ID, 10, 64)
	return e1 == nil && e2 == nil && now == prev+1
}
func abs64(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}
func visualPages(messages []Message) [][]Message {
	visual := groupMediaAlbums(messages)
	if len(visual) == 0 {
		return [][]Message{{}}
	}
	var pages [][]Message
	for start := 0; start < len(visual); start += messagesPerPage {
		end := min(start+messagesPerPage, len(visual))
		pages = append(pages, visual[start:end])
	}
	return pages
}
func visualPageIDs(messages []Message) map[string]int {
	pages := visualPages(messages)
	ids := make(map[string]int, len(messages))
	for pi, pg := range pages {
		for _, m := range pg {
			for _, id := range m.SourceIDs {
				ids[id] = pi + 1
			}
		}
	}
	return ids
}

func (a *App) buildBeautifierPages(slug string, arc *Archive) error {
	if arc == nil {
		return fmt.Errorf("archive is nil")
	}
	if err := a.ensureBeautifierAssets(nil); err != nil {
		return err
	}
	ws := a.workspaceDir(slug)
	// Remove stale extra pages from previous builds.
	entries, _ := os.ReadDir(ws)
	for _, e := range entries {
		n := strings.ToLower(e.Name())
		if n == "messages.html" || (strings.HasPrefix(n, "messages") && strings.HasSuffix(n, ".html")) || (strings.HasPrefix(n, "strict-messages") && strings.HasSuffix(n, ".html")) {
			_ = os.Remove(filepath.Join(ws, e.Name()))
		}
	}
	pages := visualPages(arc.Messages)
	totalPages := len(pages)
	for page, msgs := range pages {
		name := "messages.html"
		if page > 0 {
			name = fmt.Sprintf("messages%d.html", page+1)
		}
		content := renderBeautifierPage(arc.Chat, msgs, page+1, totalPages)
		if err := os.WriteFile(filepath.Join(ws, name), []byte(content), 0644); err != nil {
			return err
		}
		// Keep the same page boundaries as the default inferred view, so
		// search IDs and global date links resolve to the same page number.
		// Only the true Telegram grouped_id is allowed in the strict view.
		allowed := make(map[string]bool)
		for _, visual := range msgs {
			for _, id := range visual.SourceIDs {
				allowed[id] = true
			}
		}
		raw := make([]Message, 0, len(allowed))
		for _, msg := range arc.Messages {
			if allowed[msg.ID] {
				raw = append(raw, msg)
			}
		}
		strict := groupStrictAlbums(raw)
		strictHTML := renderBeautifierPage(arc.Chat, strict, page+1, totalPages)
		// The strict pages are siblings of default pages; preserve all asset
		// relative paths and rewrite only HTML page navigation links.
		strictHTML = regexp.MustCompile(`href="messages(\d*)\.html`).ReplaceAllString(strictHTML, `href="strict-messages${1}.html`)
		strictName := "strict-" + name
		if err := os.WriteFile(filepath.Join(ws, strictName), []byte(strictHTML), 0644); err != nil {
			return err
		}
	}
	return nil
}

func renderBeautifierPage(chat Chat, msgs []Message, page, totalPages int) string {
	var b strings.Builder
	b.Grow(len(msgs) * 700)
	b.WriteString(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>`)
	b.WriteString(html.EscapeString(chat.Name))
	b.WriteString(`</title><link rel="icon" href="../../favicon.ico" type="image/x-icon"><script>try{if(new URLSearchParams(location.search).get('embed')==='1')document.documentElement.classList.add('tak-embed-root')}catch(e){}</script><link href="../../assets/beautifier/style.css" rel="stylesheet"><link href="../../assets/tak-bridge.css" rel="stylesheet"></head><body><div class="page_wrap"><div class="page_header"><div class="content"><div class="text bold">`)
	b.WriteString(html.EscapeString(chat.Name))
	b.WriteString(`</div></div></div><div class="page_body chat_page">`)
	if totalPages > 1 {
		b.WriteString(renderPager(page, totalPages, len(msgs), "top", pageMediaCounts(msgs)...))
	}
	b.WriteString(`<div class="history">`)
	lastDay := ""
	lastSender := ""
	var lastTS int64
	for _, m := range msgs {
		if m.Type == "service" && (strings.TrimSpace(m.Text) == "" || strings.EqualFold(strings.TrimSpace(m.Text), "Telegram service message")) {
			continue
		}
		day := dayKey(m.TS, m.Date)
		if day != "" && day != lastDay {
			b.WriteString(renderDateService(day))
			lastDay = day
			lastSender, lastTS = "", 0
		}
		if m.Type == "service" {
			b.WriteString(renderServiceMessage(m))
			lastSender, lastTS = "", 0
			continue
		}
		sender := strings.TrimSpace(m.From)
		if sender == "" {
			sender = chat.Name
		}
		joined := sender == lastSender && m.TS > 0 && lastTS > 0 && m.TS-lastTS >= 0 && m.TS-lastTS <= 900 && joinSafeMedia(m)
		b.WriteString(renderClassicMessage(m, sender, joined))
		lastSender, lastTS = sender, m.TS
	}
	if totalPages > 1 {
		b.WriteString(renderPager(page, totalPages, len(msgs), "bottom", pageMediaCounts(msgs)...))
	}

	b.WriteString(`</div></div></div><script src="data/search-index.js"></script><script src="data/date-index.js"></script><script src="../../assets/tak-prelude.js"></script><script src="../../assets/beautifier/script.js"></script><script src="../../assets/tak-bridge.js"></script></body></html>`)
	return b.String()
}

// renderPager provides two visually distinct, keyboard-accessible pagers.
// The same page link structure is used at top and bottom; JS preserves the
// current view mode when navigating via a normal link or the custom picker.
// pageMediaCounts includes grouped album members, not just message bubbles.
func pageMediaCounts(messages []Message) []int {
	images, videos := 0, 0
	for _, m := range messages {
		for _, media := range m.Media {
			switch media.Kind {
			case "image":
				images++
			case "video":
				videos++
			}
		}
	}
	return []int{images, videos}
}
func renderPager(page, total, shown int, placement string, counts ...int) string {
	images, videos := 0, 0
	if len(counts) > 1 {
		images, videos = counts[0], counts[1]
	}
	name := func(n int) string {
		if n == 1 {
			return "messages.html"
		}
		return fmt.Sprintf("messages%d.html", n)
	}
	var b strings.Builder
	b.WriteString(`<nav class="tak-pagination tak-pagination-` + placement + `" aria-label="聊天` + map[string]string{"top": "顶部", "bottom": "底部"}[placement] + `分页导航"><div class="tak-pager-summary"><span class="tak-page-title">第 ` + strconv.Itoa(page) + ` / ` + strconv.Itoa(total) + ` 页</span><span class="tak-page-count">本页 ` + strconv.Itoa(images) + ` 图片 · ` + strconv.Itoa(videos) + ` 视频</span><span class="tak-page-count-mobile">` + strconv.Itoa(images) + ` 图 · ` + strconv.Itoa(videos) + ` 视频</span></div><div class="pagination-wrap">`)
	if page > 1 {
		b.WriteString(`<a class="pagination block_link" href="` + name(page-1) + `" aria-label="上一页">← 上一页</a>`)
	} else {
		b.WriteString(`<span class="tak-page-disabled" aria-disabled="true">← 上一页</span>`)
	}
	if page < total {
		b.WriteString(`<a class="pagination block_link" href="` + name(page+1) + `" aria-label="下一页">下一页 →</a>`)
	} else {
		b.WriteString(`<span class="tak-page-disabled" aria-disabled="true">下一页 →</span>`)
	}
	b.WriteString(`</div><div class="tak-page-jump"><button type="button" class="tak-page-picker" aria-haspopup="listbox" aria-expanded="false" aria-label="选择聊天分页"><span>第 ` + strconv.Itoa(page) + ` 页</span><span class="tak-page-picker-mobile">第 ` + strconv.Itoa(page) + ` / ` + strconv.Itoa(total) + ` 页</span><svg class="tak-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="tak-page-options" role="listbox" aria-label="聊天分页列表" hidden>`)
	for i := 1; i <= total; i++ {
		sel := ""
		if i == page {
			sel = ` aria-selected="true"`
		}
		b.WriteString(`<a role="option"` + sel + ` href="` + name(i) + `">第 ` + strconv.Itoa(i) + ` 页</a>`)
	}
	b.WriteString(`</div></div></nav>`)
	return b.String()
}

func dayKey(ts int64, fallback string) string {
	if ts > 0 {
		return time.Unix(ts, 0).Local().Format("2 January 2006")
	}
	if len(fallback) >= 10 {
		if t, err := time.Parse("2006-01-02", fallback[:10]); err == nil {
			return t.Format("2 January 2006")
		}
	}
	return ""
}

func renderDateService(day string) string {
	attr := ""
	if t, err := time.Parse("2 January 2006", day); err == nil {
		attr = ` data-date="` + t.Format("2006-01-02") + `"`
	}
	return `<div class="message service"><div class="body details"` + attr + `>` + html.EscapeString(day) + `</div></div>`
}

func joinSafeMedia(m Message) bool {
	for _, med := range m.Media {
		if med.Kind != "image" && med.Kind != "video" {
			return false
		}
	}
	return true
}

func renderServiceMessage(m Message) string {
	text := strings.TrimSpace(m.Text)
	// Telegram JSON exports often contain structural service rows without human-readable text.
	// Rendering a synthetic "Telegram service message" pill adds no information and clutters
	// the timeline, so only preserve meaningful service text.
	if text == "" || strings.EqualFold(text, "Telegram service message") {
		return ""
	}
	return `<div class="message service" id="message` + html.EscapeString(m.ID) + `"><div class="body details">` + renderEntities(m.Entities, text) + `</div></div>`
}

func renderClassicMessage(m Message, sender string, joined bool) string {
	var b strings.Builder
	class := "message default clearfix"
	if joined {
		class += " joined"
	}
	b.WriteString(`<div class="` + class + `" id="message` + html.EscapeString(m.ID) + `" data-tak-from="` + html.EscapeString(sender) + `" data-tak-ts="` + strconv.FormatInt(m.TS, 10) + `" data-tak-group="` + html.EscapeString(m.GroupedID) + `" data-tak-kind="` + html.EscapeString(m.MediaType) + `">`)
	// Deep links for every message of a Telegram grouped-media album.
	for _, alias := range m.SourceIDs {
		if alias != m.ID {
			b.WriteString(`<span class="tak-album-anchor" id="message` + html.EscapeString(alias) + `"></span>`)
		}
	}
	b.WriteString(`<div class="pull_left userpic_wrap"><div class="userpic userpic` + strconv.Itoa(avatarClass(sender)) + `" style="width:42px;height:42px"><div class="initials">` + html.EscapeString(initials(sender)) + `</div></div></div>`)
	b.WriteString(`<div class="body">`)
	if m.TS > 0 {
		b.WriteString(`<div class="pull_right date details" title="` + html.EscapeString(time.Unix(m.TS, 0).Local().Format(time.RFC3339)) + `">` + html.EscapeString(time.Unix(m.TS, 0).Local().Format("15:04")) + `</div>`)
	}
	b.WriteString(`<div class="from_name">` + html.EscapeString(sender) + `</div>`)
	if m.ForwardedFrom != "" {
		b.WriteString(`<div class="forwarded body"><div class="from_name">转发自 ` + html.EscapeString(m.ForwardedFrom) + `</div></div>`)
	}
	if m.ReplyTo != "" {
		b.WriteString(`<div class="reply_to details">回复 <a href="#message` + html.EscapeString(m.ReplyTo) + `">#` + html.EscapeString(m.ReplyTo) + `</a></div>`)
	}
	// Keep an empty media_wrap on every message. Your Beautifier's reorganizeMessages()
	// can then append media from .joined messages even when the first message had no media.
	b.WriteString(`<div class="media_wrap clearfix">`)
	for _, med := range m.Media {
		b.WriteString(renderClassicMedia(med))
	}
	b.WriteString(`</div>`)
	if len(m.Media) == 0 && m.ExpectedMedia {
		b.WriteString(`<div class="tak-media-missing">媒体尚未同步 · Message #` + html.EscapeString(m.ID) + `</div>`)
	}
	if strings.TrimSpace(m.Text) != "" {
		b.WriteString(`<div class="text">` + renderEntities(m.Entities, m.Text) + `</div>`)
	}
	if m.Edited != "" {
		b.WriteString(`<div class="tak-meta">已编辑</div>`)
	}
	if m.Views > 0 {
		b.WriteString(`<div class="tak-meta">` + strconv.FormatInt(m.Views, 10) + ` 次查看</div>`)
	}
	if len(m.Reactions) > 0 {
		b.WriteString(`<div class="tak-reactions">`)
		for _, r := range m.Reactions {
			b.WriteString(`<span>` + html.EscapeString(r.Emoji) + ` ` + strconv.Itoa(r.Count) + `</span>`)
		}
		b.WriteString(`</div>`)
	}
	b.WriteString(`</div></div>`)
	return b.String()
}

func renderClassicMedia(m Media) string {
	href := filepath.ToSlash(m.Path)
	preview := href
	if m.Thumb != "" {
		preview = filepath.ToSlash(m.Thumb)
	}
	switch m.Kind {
	case "image":
		return `<a class="photo_wrap clearfix pull_left" href="` + html.EscapeString(href) + `"><img class="photo" loading="lazy" src="` + html.EscapeString(preview) + `" alt="` + html.EscapeString(m.Name) + `"></a>`
	case "video":
		return `<a class="video_file_wrap clearfix pull_left tak-video" href="` + html.EscapeString(href) + `"><div class="tak-video-poster">` + func() string {
			if m.Thumb != "" {
				return `<img class="video_file tak-video-thumbnail" loading="lazy" alt="视频预览" src="` + html.EscapeString(filepath.ToSlash(m.Thumb)) + `">`
			}
			return ""
		}() + `<div class="tak-play-overlay" aria-hidden="true"><span>▶</span></div><div class="tak-video-name">` + html.EscapeString(m.Name) + `</div></div></a>`
	case "audio":
		return `<a class="tak-file-card tak-audio-card" href="` + html.EscapeString(href) + `" target="_blank"><span class="tak-file-icon">♫</span><span><strong>` + html.EscapeString(m.Name) + `</strong><small>` + formatBytes(m.Size) + `</small></span></a>`
	default:
		return `<a class="tak-file-card" href="` + html.EscapeString(href) + `" target="_blank"><span class="tak-file-icon">▤</span><span><strong>` + html.EscapeString(m.Name) + `</strong><small>` + formatBytes(m.Size) + `</small></span></a>`
	}
}

func renderEntities(entities []Entity, fallback string) string {
	if len(entities) == 0 {
		return strings.ReplaceAll(html.EscapeString(fallback), "\n", "<br>")
	}
	var b strings.Builder
	for _, e := range entities {
		t := strings.ReplaceAll(html.EscapeString(e.Text), "\n", "<br>")
		typ := strings.ToLower(e.Type)
		switch typ {
		case "bold":
			b.WriteString("<strong>" + t + "</strong>")
		case "italic":
			b.WriteString("<em>" + t + "</em>")
		case "underline":
			b.WriteString("<u>" + t + "</u>")
		case "strikethrough":
			b.WriteString("<s>" + t + "</s>")
		case "code":
			b.WriteString("<code>" + t + "</code>")
		case "pre", "pre_code":
			b.WriteString("<pre>" + t + "</pre>")
		case "blockquote":
			b.WriteString("<blockquote>" + t + "</blockquote>")
		case "spoiler":
			b.WriteString(`<span class="spoiler">` + t + `</span>`)
		case "link", "url", "text_link", "email", "mention", "phone":
			href := strings.TrimSpace(e.Href)
			if href == "" {
				href = e.Text
				if typ == "email" && !strings.HasPrefix(href, "mailto:") {
					href = "mailto:" + href
				}
				if typ == "phone" && !strings.HasPrefix(href, "tel:") {
					href = "tel:" + href
				}
			}
			b.WriteString(`<a href="` + html.EscapeString(href) + `" target="_blank" rel="noopener">` + t + `</a>`)
		default:
			b.WriteString(t)
		}
	}
	return b.String()
}

func initials(s string) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) == 0 {
		return "TG"
	}
	if len(r) == 1 {
		return string(r[0])
	}
	return string(r[0:2])
}
func avatarClass(s string) int {
	h := 0
	for _, r := range s {
		h = (h*31 + int(r)) & 0x7fffffff
	}
	return h%8 + 1
}
func formatBytes(n int64) string {
	if n <= 0 {
		return ""
	}
	u := []string{"B", "KB", "MB", "GB", "TB"}
	f := float64(n)
	i := 0
	for f >= 1024 && i < len(u)-1 {
		f /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d %s", n, u[i])
	}
	return fmt.Sprintf("%.1f %s", f, u[i])
}

func (a *App) firstMessagePage(slug string) string {
	return filepath.Join(a.workspaceDir(slug), "messages.html")
}

func sortedMessageIDs(a *Archive) []string {
	ids := make([]string, 0, len(a.Messages))
	for _, m := range a.Messages {
		ids = append(ids, m.ID)
	}
	sort.SliceStable(ids, func(i, j int) bool {
		ai, _ := strconv.ParseInt(ids[i], 10, 64)
		aj, _ := strconv.ParseInt(ids[j], 10, 64)
		return ai < aj
	})
	return ids
}

func compactWhitespace(s string) string {
	return string(bytes.Join(bytes.Fields([]byte(s)), []byte(" ")))
}

func (a *App) writeSearchIndex(slug string, arc *Archive) error {
	if arc == nil {
		return nil
	}
	type srow struct {
		ID, From, Text string
		TS             int64
		Page           int
		Media          []string
		Preview        string `json:"Preview,omitempty"`
		PreviewKind    string `json:"PreviewKind,omitempty"`
		MediaSource    string `json:"MediaSource,omitempty"`
	}
	rows := make([]srow, 0, len(arc.Messages))
	pageOf := visualPageIDs(arc.Messages)
	for _, m := range arc.Messages {
		r := srow{ID: m.ID, From: m.From, Text: compactWhitespace(m.Text), TS: m.TS, Page: pageOf[m.ID]}
		for _, x := range m.Media {
			r.Media = append(r.Media, x.Name)
			if r.PreviewKind == "" && (x.Kind == "image" || x.Kind == "video") {
				r.PreviewKind = x.Kind
				r.MediaSource = filepath.ToSlash(x.Path)
				r.Preview = filepath.ToSlash(x.Thumb)
				if r.Preview == "" && x.Kind == "image" {
					r.Preview = filepath.ToSlash(x.Path)
				}
			}
		}
		rows = append(rows, r)
	}
	b, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	out := append([]byte("window.__TAK_SEARCH__ = "), b...)
	out = append(out, []byte(";\n")...)
	return os.WriteFile(filepath.Join(a.dataDir(slug), "search-index.js"), out, 0644)
}

// Cross-page date navigation index, restricted to real visible messages.
func (a *App) writeDateIndex(slug string, arc *Archive) error {
	type dateRow struct {
		Date    string `json:"date"`
		Page    int    `json:"page"`
		ID      string `json:"id"`
		Count   int    `json:"count"`
		Preview string `json:"preview,omitempty"`
	}
	result := []dateRow{}
	positions := map[string]int{}
	pageOf := visualPageIDs(arc.Messages)
	for _, m := range arc.Messages {
		if m.Type == "service" {
			continue
		}
		if m.TS == 0 {
			continue
		}
		d := time.Unix(m.TS, 0).Local().Format("2006-01-02")
		if k, ok := positions[d]; ok {
			result[k].Count++
			if result[k].Preview == "" && len(m.Media) > 0 {
				for _, media := range m.Media {
					if media.Kind == "image" || media.Kind == "video" {
						result[k].Preview = media.Thumb
						if result[k].Preview == "" && media.Kind == "image" {
							result[k].Preview = media.Path
						}
						break
					}
				}
			}
			continue
		}
		r := dateRow{Date: d, Page: pageOf[m.ID], ID: m.ID, Count: 1}
		for _, media := range m.Media {
			if media.Kind == "image" || media.Kind == "video" {
				r.Preview = media.Thumb
				if r.Preview == "" && media.Kind == "image" {
					r.Preview = media.Path
				}
				break
			}
		}
		positions[d] = len(result)
		result = append(result, r)
	}
	b, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(a.dataDir(slug), "date-index.js"), append(append([]byte("window.__TAK_DATES__ = "), b...), []byte(";\n")...), 0644)
}
