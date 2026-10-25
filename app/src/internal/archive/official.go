package archive

import (
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

var (
	officialMessageIDRE = regexp.MustCompile(`(?i)id=["']message(\d+)["']`)
	officialHrefRE      = regexp.MustCompile(`(?i)href\s*=\s*["']([^"']+)["']`)
	officialTitleRE     = regexp.MustCompile(`(?is)<div[^>]*class=["'][^"']*\btext\s+bold\b[^"']*["'][^>]*>(.*?)</div>`)
	htmlTagRE           = regexp.MustCompile(`(?s)<[^>]+>`)
)

func OfficialPageNumber(name string) int {
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

func ListOfficialHTMLPages(root string) ([]string, error) {
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
		n := OfficialPageNumber(e.Name())
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

func CleanHTMLText(s string) string {
	s = htmlTagRE.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	return strings.Join(strings.Fields(s), " ")
}

func PathToFileURL(path string) string {
	abs, _ := filepath.Abs(path)
	slash := filepath.ToSlash(abs)
	if len(slash) >= 2 && slash[1] == ':' {
		slash = "/" + slash
	}
	return (&url.URL{Scheme: "file", Path: slash}).String()
}

func ResolveOfficialHref(root, raw string) (string, bool) {
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

func AnalyzeOfficialExport(root, workspaceRoot, mode string) (OfficialExportMeta, map[string][]Media, error) {
	pages, err := ListOfficialHTMLPages(root)
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
				chatName = CleanHTMLText(m[1])
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
				abs, ok := ResolveOfficialHref(root, hm[1])
				if !ok || seen[abs] {
					continue
				}
				seen[abs] = true
				st, _ := os.Stat(abs)
				renderPath := ""
				if mode == "referenced" {
					renderPath = PathToFileURL(abs)
				} else {
					rel, er := filepath.Rel(workspaceRoot, abs)
					if er != nil {
						continue
					}
					renderPath = filepath.ToSlash(rel)
				}
				med := Media{Path: renderPath, Name: filepath.Base(abs), Kind: MediaKind(abs), Ext: strings.TrimPrefix(strings.ToLower(filepath.Ext(abs)), ".")}
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

func DedupeMedia(xs []Media) []Media {
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
