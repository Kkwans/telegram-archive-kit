package main

import (
	"encoding/json"
	"fmt"
	"html"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type officialIndexedExport struct {
	Meta  OfficialExportMeta `json:"meta"`
	Media map[string][]Media `json:"media"`
}

type officialIndexFile struct {
	Version   int                     `json:"version"`
	UpdatedAt string                  `json:"updated_at"`
	Exports   []officialIndexedExport `json:"exports"`
}

var (
	officialMessageIDRE = regexp.MustCompile(`(?i)id=["']message(\d+)["']`)
	officialHrefRE      = regexp.MustCompile(`(?i)href\s*=\s*["']([^"']+)["']`)
	officialTitleRE     = regexp.MustCompile(`(?is)<div[^>]*class=["'][^"']*\btext\s+bold\b[^"']*["'][^>]*>(.*?)</div>`)
	htmlTagRE           = regexp.MustCompile(`(?s)<[^>]+>`)
)

func (a *App) officialIndexPath(slug string) string {
	return filepath.Join(a.workspaceDir(slug), "official-media-index.json")
}

func officialPageNumber(name string) int {
	low := strings.ToLower(name)
	if low == "messages.html" {
		return 1
	}
	if !strings.HasPrefix(low, "messages") || !strings.HasSuffix(low, ".html") {
		return 0
	}
	n := strings.TrimSuffix(strings.TrimPrefix(low, "messages"), ".html")
	v, _ := strconv.Atoi(n)
	return v
}

func listOfficialHTMLPages(root string) ([]string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	type page struct {
		n    int
		path string
	}
	var pages []page
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := officialPageNumber(e.Name())
		if n > 0 {
			pages = append(pages, page{n, filepath.Join(root, e.Name())})
		}
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].n < pages[j].n })
	out := make([]string, 0, len(pages))
	for _, p := range pages {
		out = append(out, p.path)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("目录中没有 messages.html / messages2.html 等 Telegram 官方导出页面")
	}
	return out, nil
}

func cleanHTMLText(s string) string {
	s = htmlTagRE.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	return strings.Join(strings.Fields(s), " ")
}

func pathToFileURL(path string) string {
	abs, _ := filepath.Abs(path)
	slash := filepath.ToSlash(abs)
	if len(slash) >= 2 && slash[1] == ':' {
		slash = "/" + slash
	}
	return (&url.URL{Scheme: "file", Path: slash}).String()
}

func resolveOfficialHref(root, raw string) (string, bool) {
	raw = html.UnescapeString(strings.TrimSpace(raw))
	if raw == "" || strings.HasPrefix(raw, "#") || strings.HasPrefix(strings.ToLower(raw), "http://") || strings.HasPrefix(strings.ToLower(raw), "https://") || strings.HasPrefix(strings.ToLower(raw), "mailto:") || strings.HasPrefix(strings.ToLower(raw), "tg:") {
		return "", false
	}
	if u, err := url.Parse(raw); err == nil {
		if u.Scheme != "" && u.Scheme != "file" {
			return "", false
		}
		raw = u.Path
	}
	if dec, err := url.PathUnescape(raw); err == nil {
		raw = dec
	}
	raw = filepath.FromSlash(strings.TrimLeft(raw, "/"))
	low := strings.ToLower(filepath.Ext(raw))
	if low == ".html" || low == ".htm" || low == ".css" || low == ".js" {
		return "", false
	}
	abs := filepath.Clean(filepath.Join(root, raw))
	rootAbs, _ := filepath.Abs(root)
	absFull, _ := filepath.Abs(abs)
	rel, err := filepath.Rel(rootAbs, absFull)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", false
	}
	st, err := os.Stat(absFull)
	if err != nil || st.IsDir() || st.Size() <= 0 {
		return "", false
	}
	return absFull, true
}

func analyzeOfficialExport(root, workspaceRoot, mode string) (OfficialExportMeta, map[string][]Media, error) {
	pages, err := listOfficialHTMLPages(root)
	if err != nil {
		return OfficialExportMeta{}, nil, err
	}
	meta := OfficialExportMeta{Name: filepath.Base(filepath.Clean(root)), Root: root, Mode: mode, ImportedAt: time.Now()}
	media := map[string][]Media{}
	ids := map[string]bool{}
	firstID, lastID := int64(0), int64(0)
	chatName := ""
	mediaMessages := map[string]bool{}
	totalFiles := 0
	for _, page := range pages {
		b, er := os.ReadFile(page)
		if er != nil {
			return meta, nil, er
		}
		text := string(b)
		if chatName == "" {
			if m := officialTitleRE.FindStringSubmatch(text); len(m) == 2 {
				chatName = cleanHTMLText(m[1])
			}
		}
		locs := officialMessageIDRE.FindAllStringSubmatchIndex(text, -1)
		for i, loc := range locs {
			id := text[loc[2]:loc[3]]
			ids[id] = true
			n, _ := strconv.ParseInt(id, 10, 64)
			if firstID == 0 || (n > 0 && n < firstID) {
				firstID = n
			}
			if n > lastID {
				lastID = n
			}
			start := loc[0]
			end := len(text)
			if i+1 < len(locs) {
				end = locs[i+1][0]
			}
			chunk := text[start:end]
			hrefs := officialHrefRE.FindAllStringSubmatch(chunk, -1)
			seen := map[string]bool{}
			for _, hm := range hrefs {
				abs, ok := resolveOfficialHref(root, hm[1])
				if !ok || seen[abs] {
					continue
				}
				seen[abs] = true
				st, _ := os.Stat(abs)
				renderPath := ""
				if mode == "referenced" {
					renderPath = pathToFileURL(abs)
				} else {
					rel, er := filepath.Rel(workspaceRoot, abs)
					if er != nil {
						continue
					}
					renderPath = filepath.ToSlash(rel)
				}
				med := Media{Path: renderPath, Name: filepath.Base(abs), Kind: mediaKind(abs), Ext: strings.TrimPrefix(strings.ToLower(filepath.Ext(abs)), ".")}
				if st != nil {
					med.Size = st.Size()
				}
				media[id] = append(media[id], med)
				totalFiles++
				mediaMessages[id] = true
			}
		}
	}
	if chatName != "" {
		meta.Name = chatName
	}
	if mode != "referenced" {
		if rel, er := filepath.Rel(workspaceRoot, root); er == nil {
			meta.Root = filepath.ToSlash(rel)
		}
	}
	meta.MessageCount = len(ids)
	meta.MediaMessages = len(mediaMessages)
	meta.MediaFiles = totalFiles
	if firstID > 0 {
		meta.FirstMessageID = strconv.FormatInt(firstID, 10)
	}
	if lastID > 0 {
		meta.LastMessageID = strconv.FormatInt(lastID, 10)
	}
	return meta, media, nil
}

func dedupeMedia(xs []Media) []Media {
	seen := map[string]bool{}
	out := make([]Media, 0, len(xs))
	for _, m := range xs {
		key := strings.ToLower(m.Path)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, m)
	}
	return out
}

func (a *App) loadOfficialIndex(slug string) (officialIndexFile, error) {
	var idx officialIndexFile
	b, err := os.ReadFile(a.officialIndexPath(slug))
	if err != nil {
		if os.IsNotExist(err) {
			return idx, nil
		}
		return idx, err
	}
	err = json.Unmarshal(b, &idx)
	return idx, err
}

func (a *App) saveOfficialIndex(slug string, idx officialIndexFile) error {
	idx.Version = 1
	idx.UpdatedAt = time.Now().Format(time.RFC3339)
	return writeJSON(a.officialIndexPath(slug), idx)
}

func (a *App) officialMediaByID(slug string) map[string][]Media {
	idx, err := a.loadOfficialIndex(slug)
	if err != nil {
		return nil
	}
	out := map[string][]Media{}
	for _, ex := range idx.Exports {
		for id, files := range ex.Media {
			out[id] = dedupeMedia(append(out[id], files...))
		}
	}
	return out
}

func (a *App) registerOfficialExport(slug, root, mode string) (OfficialExportMeta, error) {
	meta, media, err := analyzeOfficialExport(root, a.workspaceDir(slug), mode)
	if err != nil {
		return OfficialExportMeta{}, err
	}
	idx, _ := a.loadOfficialIndex(slug)
	// Replace an existing record pointing to the same root, otherwise append.
	replaced := false
	for i := range idx.Exports {
		if strings.EqualFold(filepath.Clean(idx.Exports[i].Meta.Root), filepath.Clean(meta.Root)) {
			idx.Exports[i] = officialIndexedExport{Meta: meta, Media: media}
			replaced = true
			break
		}
	}
	if !replaced {
		idx.Exports = append(idx.Exports, officialIndexedExport{Meta: meta, Media: media})
	}
	if err := a.saveOfficialIndex(slug, idx); err != nil {
		return OfficialExportMeta{}, err
	}
	wm, _ := a.readWorkspaceMeta(slug)
	wm.OfficialExports = nil
	for _, x := range idx.Exports {
		wm.OfficialExports = append(wm.OfficialExports, x.Meta)
	}
	if wm.Slug == "" {
		wm.Slug = slug
	}
	if wm.Chat.Name == "" {
		wm.Chat.Name = meta.Name
	}
	wm.UpdatedAt = time.Now()
	_ = writeJSON(a.workspaceMetaPath(slug), wm)
	return meta, nil
}

func (a *App) managedOfficialRoot(slug, sourceName string) string {
	name := sanitizePathComponent(sourceName)
	if name == "" {
		name = "TelegramExport"
	}
	return filepath.Join(a.workspaceDir(slug), "official_exports", name)
}

func (a *App) primaryOfficialMessagesRel(slug string) string {
	idx, err := a.loadOfficialIndex(slug)
	if err != nil || len(idx.Exports) == 0 {
		return ""
	}
	ex := idx.Exports[0].Meta
	if ex.Mode == "referenced" {
		return pathToFileURL(filepath.Join(ex.Root, "messages.html"))
	}
	// Root is stored relative to the workspace for managed/copied imports.
	root := filepath.FromSlash(ex.Root)
	if filepath.IsAbs(root) {
		rel, er := filepath.Rel(a.Settings.LibraryRoot, filepath.Join(root, "messages.html"))
		if er == nil {
			return filepath.ToSlash(rel)
		}
		return pathToFileURL(filepath.Join(root, "messages.html"))
	}
	return filepath.ToSlash(filepath.Join("chats", slug, root, "messages.html"))
}
