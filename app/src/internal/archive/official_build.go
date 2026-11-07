package archive

import (
	"errors"
	"html"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"telegramarchivekit/internal/model"
)

var (
	officialFromNameRE = regexp.MustCompile(`(?is)<div[^>]*class=["'][^"']*\bfrom_name\b[^"']*["'][^>]*>`)
	officialTextRE     = regexp.MustCompile(`(?is)<div[^>]*class=["'][^"']*\btext\b[^"']*["'][^>]*>`)
	officialBodyRE     = regexp.MustCompile(`(?is)<div[^>]*class=["'][^"']*\bbody\s+details\b[^"']*["'][^>]*>`)
	officialBreakRE    = regexp.MustCompile(`(?i)<br\s*/?>`)
)

func divContent(text string, open []int) string {
	if len(open) < 2 || open[1] > len(text) {
		return ""
	}
	lower := strings.ToLower(text)
	depth := 1
	for i := open[1]; i < len(text); {
		nextOpen := strings.Index(lower[i:], "<div")
		nextClose := strings.Index(lower[i:], "</div")
		if nextClose < 0 {
			return text[open[1]:]
		}
		if nextOpen >= 0 && nextOpen < nextClose {
			depth++
			i += nextOpen + 4
			continue
		}
		depth--
		if depth == 0 {
			return text[open[1] : i+nextClose]
		}
		i += nextClose + 5
	}
	return text[open[1]:]
}

func htmlBlockText(s string) string {
	s = officialBreakRE.ReplaceAllString(s, "\n")
	s = strings.ReplaceAll(s, "</p>", "\n")
	s = strings.ReplaceAll(s, "</blockquote>", "\n")
	s = htmlTagRE.ReplaceAllString(s, "")
	s = strings.TrimSpace(html.UnescapeString(s))
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	blank := false
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			if blank || len(out) == 0 {
				continue
			}
			blank = true
			out = append(out, "")
			continue
		}
		blank = false
		out = append(out, line)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func firstDivText(chunk string, re *regexp.Regexp) string {
	loc := re.FindStringIndex(chunk)
	if loc == nil {
		return ""
	}
	return htmlBlockText(divContent(chunk, loc))
}

// BuildOfficialArchive turns Telegram Desktop's HTML export into the same
// Archive shape as result.json. It lets official-only workspaces get generated
// thumbnails, search/date indexes and offline pages without a source JSON.
func BuildOfficialArchive(roots []string, extra map[string][]Media, preferredName string) (*Archive, error) {
	arc := &Archive{
		SchemaVersion: model.SchemaVersion,
		Generator:     "TelegramArchiveKit/" + model.Version,
		GeneratedAt:   time.Now().Format(time.RFC3339),
		Chat:          Chat{Name: preferredName, Type: "official"},
	}
	seen := map[string]bool{}
	type entry struct {
		msg Message
		ord int
	}
	var entries []entry
	for _, root := range roots {
		pages, err := ListOfficialHTMLPages(root)
		if err != nil {
			continue
		}
		lastFrom := ""
		for _, page := range pages {
			b, er := os.ReadFile(page)
			if er != nil {
				continue
			}
			text := string(b)
			if arc.Chat.Name == "" {
				if m := officialTitleRE.FindStringSubmatch(text); len(m) == 2 {
					arc.Chat.Name = CleanHTMLText(m[1])
				}
			}
			locs := officialMessageIDRE.FindAllStringSubmatchIndex(text, -1)
			for i, loc := range locs {
				id := text[loc[2]:loc[3]]
				if id == "" || seen[id] {
					continue
				}
				start := strings.LastIndex(text[:loc[0]], "<div")
				if start < 0 {
					start = loc[0]
				}
				end := len(text)
				if i+1 < len(locs) {
					next := strings.LastIndex(text[:locs[i+1][0]], "<div")
					if next > start {
						end = next
					} else {
						end = locs[i+1][0]
					}
				}
				chunk := text[start:end]
				from := firstDivText(chunk, officialFromNameRE)
				if from != "" {
					lastFrom = from
				} else {
					from = lastFrom
				}
				ts := int64(0)
				if dm := officialDateRE.FindStringSubmatch(chunk); len(dm) == 2 {
					if t, er := time.ParseInLocation("02.01.2006 15:04:05", dm[1], time.Local); er == nil {
						ts = t.Unix()
					}
				}
				kind := "message"
				msgText := ""
				if strings.Contains(strings.ToLower(chunk), "message service") {
					kind = "service"
					if bl := officialBodyRE.FindStringIndex(chunk); bl != nil {
						msgText = htmlBlockText(divContent(chunk, bl))
					}
				} else if tl := officialTextRE.FindStringIndex(chunk); tl != nil {
					msgText = htmlBlockText(divContent(chunk, tl))
				}
				msg := Message{ID: id, Type: kind, From: from, Text: msgText, TS: ts}
				if ts > 0 {
					msg.Date = time.Unix(ts, 0).Local().Format("2006-01-02 15:04:05")
				}
				if files := extra[id]; len(files) > 0 {
					filtered := make([]Media, 0, len(files))
					for _, f := range files {
						if IsThumbnailFile(f.Name) || IsThumbnailFile(f.Path) {
							continue
						}
						filtered = append(filtered, f)
					}
					msg.Media = DedupeMedia(filtered)
					if len(msg.Media) > 0 {
						msg.MediaType = msg.Media[0].Kind
					}
				}
				seen[id] = true
				entries = append(entries, entry{msg: msg, ord: len(entries)})
			}
		}
	}
	if len(entries) == 0 {
		return nil, errors.New("官方导出中没有可识别的消息")
	}
	sort.SliceStable(entries, func(i, j int) bool {
		a, b := entries[i].msg, entries[j].msg
		if a.TS != b.TS {
			if a.TS == 0 {
				return false
			}
			if b.TS == 0 {
				return true
			}
			return a.TS < b.TS
		}
		ai, _ := strconv.ParseInt(a.ID, 10, 64)
		bi, _ := strconv.ParseInt(b.ID, 10, 64)
		if ai != bi {
			return ai < bi
		}
		return entries[i].ord < entries[j].ord
	})
	arc.Messages = make([]Message, 0, len(entries))
	for _, e := range entries {
		arc.Messages = append(arc.Messages, e.msg)
		arc.Stats.Messages++
		for _, x := range e.msg.Media {
			arc.Stats.MediaFiles++
			switch x.Kind {
			case "image":
				arc.Stats.Images++
			case "video":
				arc.Stats.Videos++
			case "audio":
				arc.Stats.Audio++
			default:
				arc.Stats.Files++
			}
		}
	}
	if strings.TrimSpace(arc.Chat.Name) == "" && len(roots) > 0 {
		arc.Chat.Name = filepath.Base(filepath.Clean(roots[0]))
	}
	if strings.TrimSpace(arc.Chat.Name) == "" {
		arc.Chat.Name = "Telegram Archive"
	}
	arc.Stats.ExpectedMedia = 0
	arc.Stats.MissingMedia = 0
	return arc, nil
}
