package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	static "telegramarchivekit/assets"
	"telegramarchivekit/internal/render"
)

// builtinThemeVersion identifies the built-in Beautifier theme edition bundled
// with this build; it is recorded in each library's SOURCE.txt so diagnostics
// can spot a stale materialized theme from an older TAK build.
const builtinThemeVersion = "2"

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
		fileSizeAtLeast(a.beautifierStyle(), 50_000) && fileSizeAtLeast(a.beautifierScript(), 50_000)
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
// library. The theme is the complete Kkwans/telegram-export-beautifier edition
// (upstream commit 608ac73) bundled with the binary: fully offline, no runtime
// downloads. Files are always rewritten so a theme shipped in a newer TAK build
// replaces whatever an older build left behind.
func (a *App) ensureBeautifierAssets(progress func(string)) error {
	if progress != nil {
		progress("正在写入内置 Beautifier 主题")
	}
	if err := os.MkdirAll(a.beautifierDir(), 0755); err != nil {
		return err
	}
	css, err := static.BeautifierTheme.ReadFile("ui/beautifier-theme.css")
	if err != nil {
		return err
	}
	js, err := static.BeautifierTheme.ReadFile("ui/beautifier-theme.js")
	if err != nil {
		return err
	}
	if err := os.WriteFile(a.beautifierStyle(), css, 0644); err != nil {
		return err
	}
	if err := os.WriteFile(a.beautifierScript(), js, 0644); err != nil {
		return err
	}
	source := "TelegramArchiveKit built-in theme\nedition=full (Kkwans/telegram-export-beautifier 608ac73a4b4cf6a02811d28d224f1285d90ba03d)\nthemeVersion=" + builtinThemeVersion + "\n"
	return os.WriteFile(filepath.Join(a.beautifierDir(), "SOURCE.txt"), []byte(source), 0644)
}

func (a *App) buildBeautifierPages(slug string, arc *Archive) error {
	if arc == nil {
		return fmt.Errorf("archive is nil")
	}
	if err := a.ensureBeautifierAssets(nil); err != nil {
		return err
	}
	return a.renderWorkspacePages(slug, arc)
}

func (a *App) renderWorkspacePages(slug string, arc *Archive) error {
	ws := a.workspaceDir(slug)
	// Remove stale extra pages from previous builds.
	entries, _ := os.ReadDir(ws)
	for _, e := range entries {
		n := strings.ToLower(e.Name())
		if n == "messages.html" || (strings.HasPrefix(n, "messages") && strings.HasSuffix(n, ".html")) || (strings.HasPrefix(n, "strict-messages") && strings.HasSuffix(n, ".html")) {
			_ = os.Remove(filepath.Join(ws, e.Name()))
		}
	}
	pages := render.VisualPages(arc.Messages)
	totalPages := len(pages)
	for page, msgs := range pages {
		name := "messages.html"
		if page > 0 {
			name = fmt.Sprintf("messages%d.html", page+1)
		}
		content := render.RenderPage(arc.Chat, msgs, page+1, totalPages)
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
		strict := render.GroupStrictAlbums(raw)
		strictHTML := render.RenderPage(arc.Chat, strict, page+1, totalPages)
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

const archiveDataScriptPrefix = "window.__TAK_CHAT_DATA__ = "

// readBuiltArchive loads the data already serialized for the viewer. Refreshing
// UI therefore never reads result.json, scans media or recomputes completeness.
func (a *App) readBuiltArchive(slug string) (*Archive, error) {
	b, err := os.ReadFile(filepath.Join(a.dataDir(slug), "archive-data.js"))
	if err != nil {
		return nil, fmt.Errorf("找不到已归档数据：%w", err)
	}
	return decodeBuiltArchive(b)
}

func decodeBuiltArchive(b []byte) (*Archive, error) {
	s := strings.TrimSpace(string(b))
	if !strings.HasPrefix(s, archiveDataScriptPrefix) {
		return nil, fmt.Errorf("已归档数据格式无法识别")
	}
	s = strings.TrimSpace(strings.TrimPrefix(s, archiveDataScriptPrefix))
	s = strings.TrimSuffix(s, ";")
	var arc Archive
	if err := json.Unmarshal([]byte(s), &arc); err != nil {
		return nil, fmt.Errorf("已归档数据解析失败：%w", err)
	}
	return &arc, nil
}

func (a *App) refreshWorkspaceWeb(slug string) error {
	arc, err := a.readBuiltArchive(slug)
	if err != nil {
		return err
	}
	if err := a.renderWorkspacePages(slug, arc); err != nil {
		return err
	}
	if err := a.writeSearchIndex(slug, arc); err != nil {
		return err
	}
	return a.writeDateIndex(slug, arc)
}

func (a *App) firstMessagePage(slug string) string {
	return filepath.Join(a.workspaceDir(slug), "messages.html")
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
	pageOf := render.VisualPageIDs(arc.Messages)
	for _, m := range arc.Messages {
		r := srow{ID: m.ID, From: m.From, Text: render.CompactWhitespace(m.Text), TS: m.TS, Page: pageOf[m.ID]}
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
	pageOf := render.VisualPageIDs(arc.Messages)
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
