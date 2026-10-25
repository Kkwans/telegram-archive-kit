package render

import (
	"bytes"
	"fmt"
	"html"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"telegramarchivekit/internal/model"
)

type Entity = model.Entity
type Media = model.Media
type Message = model.Message
type Chat = model.Chat
type Archive = model.Archive

const MessagesPerPage = 1000

// GroupMediaAlbums preserves Telegram albums recorded with grouped_id. When the
// Desktop JSON omitted grouping metadata for a sequential batch of *documents*,
// apply a deliberately narrow visual fallback so a native file bundle does not
// degenerate into a separate giant message bubble per video. It is an inference,
// not an assertion that the original client grouping can be recovered exactly.
func GroupMediaAlbums(messages []Message) []Message {
	out := make([]Message, 0, len(messages))
	for _, m := range messages {
		m.SourceIDs = []string{m.ID}
		if n := len(out); n > 0 {
			base := &out[n-1]
			explicit := m.GroupedID != "" && m.Type != "service" && base.GroupedID == m.GroupedID && base.From == m.From && (m.TS == 0 || base.TS == 0 || Abs64(m.TS-base.TS) <= 600)
			inferred := LooksLikeDocumentBatch(*base, m)
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

// GroupStrictAlbums never invents a group. The optional original view only
// groups messages when Telegram supplied a shared grouped_id.
func GroupStrictAlbums(messages []Message) []Message {
	out := make([]Message, 0, len(messages))
	for _, original := range messages {
		m := original
		m.SourceIDs = []string{m.ID}
		if len(out) > 0 {
			base := &out[len(out)-1]
			if m.GroupedID != "" && base.GroupedID == m.GroupedID &&
				base.From == m.From && base.Type != "service" && m.Type != "service" &&
				(m.TS == 0 || base.TS == 0 || Abs64(m.TS-base.TS) <= 600) {
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

func IsDocumentMedia(m Message) bool {
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
func LooksLikeDocumentBatch(base, m Message) bool {
	if base.GroupedID != "" || m.GroupedID != "" || base.Type == "service" || m.Type == "service" {
		return false
	}
	if base.From != m.From || base.From == "" || base.TS <= 0 || m.TS <= 0 || m.TS < base.TS || m.TS-base.TS > 90 {
		return false
	}
	if len(base.Media) >= 10 || len(m.Media) != 1 || !IsDocumentMedia(base) || !IsDocumentMedia(m) {
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
func Abs64(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}
func VisualPages(messages []Message) [][]Message {
	visual := GroupMediaAlbums(messages)
	if len(visual) == 0 {
		return [][]Message{{}}
	}
	var pages [][]Message
	for start := 0; start < len(visual); start += MessagesPerPage {
		end := min(start+MessagesPerPage, len(visual))
		pages = append(pages, visual[start:end])
	}
	return pages
}
func VisualPageIDs(messages []Message) map[string]int {
	pages := VisualPages(messages)
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
func RenderPage(chat Chat, msgs []Message, page, totalPages int) string {
	var b strings.Builder
	b.Grow(len(msgs) * 700)
	b.WriteString(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>`)
	b.WriteString(html.EscapeString(chat.Name))
	b.WriteString(`</title><link rel="icon" href="../../favicon.ico" type="image/x-icon"><script>try{if(new URLSearchParams(location.search).get('embed')==='1')document.documentElement.classList.add('tak-embed-root')}catch(e){}</script><link href="../../assets/beautifier/style.css" rel="stylesheet"><link href="../../assets/tak-bridge.css" rel="stylesheet"></head><body><div class="page_wrap"><div class="page_header"><div class="content"><div class="text bold">`)
	b.WriteString(html.EscapeString(chat.Name))
	b.WriteString(`</div></div></div><div class="page_body chat_page">`)
	if totalPages > 1 {
		b.WriteString(RenderPager(page, totalPages, len(msgs), "top", PageMediaCounts(msgs)...))
	}
	b.WriteString(`<div class="history">`)
	lastDay := ""
	lastSender := ""
	var lastTS int64
	for _, m := range msgs {
		if m.Type == "service" && (strings.TrimSpace(m.Text) == "" || strings.EqualFold(strings.TrimSpace(m.Text), "Telegram service message")) {
			continue
		}
		day := DayKey(m.TS, m.Date)
		if day != "" && day != lastDay {
			b.WriteString(RenderDateService(day))
			lastDay = day
			lastSender, lastTS = "", 0
		}
		if m.Type == "service" {
			b.WriteString(RenderServiceMessage(m))
			lastSender, lastTS = "", 0
			continue
		}
		sender := strings.TrimSpace(m.From)
		if sender == "" {
			sender = chat.Name
		}
		joined := sender == lastSender && m.TS > 0 && lastTS > 0 && m.TS-lastTS >= 0 && m.TS-lastTS <= 900 && JoinSafeMedia(m)
		b.WriteString(RenderClassicMessage(m, sender, joined))
		lastSender, lastTS = sender, m.TS
	}
	if totalPages > 1 {
		b.WriteString(RenderPager(page, totalPages, len(msgs), "bottom", PageMediaCounts(msgs)...))
	}

	b.WriteString(`</div></div></div><script src="data/search-index.js"></script><script src="data/date-index.js"></script><script src="../../assets/tak-prelude.js"></script><script src="../../assets/beautifier/script.js"></script><script src="../../assets/tak-bridge.js"></script></body></html>`)
	return b.String()
}

// RenderPager provides two visually distinct, keyboard-accessible pagers.
// The same page link structure is used at top and bottom; JS preserves the
// current view mode when navigating via a normal link or the custom picker.
// PageMediaCounts includes grouped album members, not just message bubbles.
func PageMediaCounts(messages []Message) []int {
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
func RenderPager(page, total, shown int, placement string, counts ...int) string {
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

func DayKey(ts int64, fallback string) string {
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

func RenderDateService(day string) string {
	attr := ""
	if t, err := time.Parse("2 January 2006", day); err == nil {
		attr = ` data-date="` + t.Format("2006-01-02") + `"`
	}
	return `<div class="message service"><div class="body details"` + attr + `>` + html.EscapeString(day) + `</div></div>`
}

func JoinSafeMedia(m Message) bool {
	for _, med := range m.Media {
		if med.Kind != "image" && med.Kind != "video" {
			return false
		}
	}
	return true
}

func RenderServiceMessage(m Message) string {
	text := strings.TrimSpace(m.Text)
	// Telegram JSON exports often contain structural service rows without human-readable text.
	// Rendering a synthetic "Telegram service message" pill adds no information and clutters
	// the timeline, so only preserve meaningful service text.
	if text == "" || strings.EqualFold(text, "Telegram service message") {
		return ""
	}
	return `<div class="message service" id="message` + html.EscapeString(m.ID) + `"><div class="body details">` + RenderEntities(m.Entities, text) + `</div></div>`
}

func RenderClassicMessage(m Message, sender string, joined bool) string {
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
	b.WriteString(`<div class="pull_left userpic_wrap"><div class="userpic userpic` + strconv.Itoa(AvatarClass(sender)) + `" style="width:42px;height:42px"><div class="Initials">` + html.EscapeString(Initials(sender)) + `</div></div></div>`)
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
		b.WriteString(RenderClassicMedia(med))
	}
	b.WriteString(`</div>`)
	if len(m.Media) == 0 && m.ExpectedMedia {
		b.WriteString(`<div class="tak-media-missing">媒体尚未同步 · Message #` + html.EscapeString(m.ID) + `</div>`)
	}
	if strings.TrimSpace(m.Text) != "" {
		b.WriteString(`<div class="text">` + RenderEntities(m.Entities, m.Text) + `</div>`)
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

func RenderClassicMedia(m Media) string {
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
		return `<a class="tak-file-card tak-audio-card" href="` + html.EscapeString(href) + `" target="_blank"><span class="tak-file-icon">♫</span><span><strong>` + html.EscapeString(m.Name) + `</strong><small>` + FormatBytes(m.Size) + `</small></span></a>`
	default:
		return `<a class="tak-file-card" href="` + html.EscapeString(href) + `" target="_blank"><span class="tak-file-icon">▤</span><span><strong>` + html.EscapeString(m.Name) + `</strong><small>` + FormatBytes(m.Size) + `</small></span></a>`
	}
}

func RenderEntities(entities []Entity, fallback string) string {
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

func Initials(s string) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) == 0 {
		return "TG"
	}
	if len(r) == 1 {
		return string(r[0])
	}
	return string(r[0:2])
}
func AvatarClass(s string) int {
	h := 0
	for _, r := range s {
		h = (h*31 + int(r)) & 0x7fffffff
	}
	return h%8 + 1
}
func FormatBytes(n int64) string {
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
func SortedMessageIDs(a *Archive) []string {
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

func CompactWhitespace(s string) string {
	return string(bytes.Join(bytes.Fields([]byte(s)), []byte(" ")))
}
