package archive

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"telegramarchivekit/internal/model"
)

type Entity = model.Entity
type Reaction = model.Reaction
type Media = model.Media
type Message = model.Message
type Chat = model.Chat
type Stats = model.Stats
type Archive = model.Archive
type Report = model.Report
type RawExport = model.RawExport
type OfficialExportMeta = model.OfficialExportMeta

func BuildArchive(jsonPath, mediaDir string) (*Archive, error) {
	return BuildArchiveWithExtra(jsonPath, mediaDir, nil)
}

func BuildArchiveWithExtra(jsonPath, mediaDir string, extra map[string][]Media) (*Archive, error) {
	b, err := os.ReadFile(jsonPath)
	if err != nil {
		return nil, fmt.Errorf("读取 result.json 失败: %w", err)
	}
	var raw RawExport
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("解析 result.json 失败: %w", err)
	}
	if len(raw.Messages) == 0 {
		return nil, errors.New("result.json 中没有 messages；请导出单个聊天，而不是完整账号数据")
	}

	mediaByID, unmatched, err := ScanMedia(mediaDir)
	if err != nil {
		return nil, err
	}
	for id, files := range extra {
		mediaByID[id] = DedupeMedia(append(mediaByID[id], files...))
	}
	arc := &Archive{
		SchemaVersion: model.SchemaVersion,
		Generator:     "TelegramArchiveKit/" + model.Version,
		GeneratedAt:   time.Now().Format(time.RFC3339),
		Chat:          Chat{Name: raw.Name, Type: raw.Type, ID: AnyString(raw.ID)},
		Messages:      make([]Message, 0, len(raw.Messages)),
	}
	if strings.TrimSpace(arc.Chat.Name) == "" {
		arc.Chat.Name = "Telegram Archive"
	}

	used := map[string]bool{}
	for _, rm := range raw.Messages {
		m := normalizeMessage(rm)
		if files := mediaByID[m.ID]; len(files) > 0 {
			m.Media = files
			for _, x := range files {
				used[x.Path] = true
			}
		}
		if m.ExpectedMedia {
			arc.Stats.ExpectedMedia++
		}
		missing := m.ExpectedMedia && len(m.Media) == 0
		if m.ExpectedMedia && m.ExpectedSize > 0 && len(m.Media) > 0 {
			matchedSize := false
			for _, x := range m.Media {
				if x.Size == m.ExpectedSize {
					matchedSize = true
					break
				}
			}
			if !matchedSize {
				missing = true
				arc.Stats.SizeMismatch++
			}
		}
		if missing {
			arc.Missing = append(arc.Missing, m.ID)
		}
		for _, x := range m.Media {
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
		arc.Messages = append(arc.Messages, m)
	}
	arc.Stats.Messages = len(arc.Messages)
	arc.Stats.MissingMedia = len(arc.Missing)

	for _, p := range unmatched {
		arc.Unmatched = append(arc.Unmatched, p)
	}
	for _, files := range mediaByID {
		for _, x := range files {
			if !used[x.Path] {
				arc.Unmatched = append(arc.Unmatched, x.Path)
			}
		}
	}
	sort.Strings(arc.Unmatched)
	arc.Stats.UnmatchedFiles = len(arc.Unmatched)
	return arc, nil
}

func normalizeMessage(r map[string]any) Message {
	id := AnyString(r["id"])
	typ := AnyString(r["type"])
	if typ == "" {
		typ = "message"
	}
	date := AnyString(r["date"])
	ts := parseTimestamp(r, date)
	text := extractText(r["text"])
	entities := extractEntities(r["text_entities"], text)
	if text == "" && len(entities) > 0 {
		var sb strings.Builder
		for _, e := range entities {
			sb.WriteString(e.Text)
		}
		text = sb.String()
	}
	mediaType := AnyString(r["media_type"])
	expected := MessageExpectsMedia(r, mediaType)
	edited := AnyString(r["edited"])
	return Message{
		ID: id, Type: typ, Date: date, TS: ts,
		Edited: edited, EditedTS: ParseAnyTimestamp(r["edited_unixtime"], edited),
		From: AnyString(r["from"]), FromID: AnyString(r["from_id"]),
		Text: text, Entities: entities,
		ReplyTo:       AnyString(r["reply_to_message_id"]),
		ForwardedFrom: FirstNonEmpty(AnyString(r["forwarded_from"]), AnyString(r["forwarded_from_name"])),
		ViaBot:        FirstNonEmpty(AnyString(r["via_bot"]), AnyString(r["via_bot_username"])),
		GroupedID:     FirstNonEmpty(AnyString(r["grouped_id"]), AnyString(r["media_group_id"]), AnyString(r["group_id"])),
		Views:         AnyInt64(r["views"]),
		Reactions:     extractReactions(r["reactions"]),
		MediaType:     mediaType,
		ExpectedMedia: expected,
		ExpectedSize:  AnyInt64(r["file_size"]),
	}
}

func ParseAnyTimestamp(v any, fallback string) int64 {
	if s := AnyString(v); s != "" {
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return n
		}
	}
	if fallback != "" {
		for _, l := range []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
			if t, err := time.Parse(l, fallback); err == nil {
				return t.Unix()
			}
		}
	}
	return 0
}

func extractReactions(v any) []Reaction {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]Reaction, 0, len(arr))
	for _, it := range arr {
		m, ok := it.(map[string]any)
		if !ok {
			continue
		}
		emoji := FirstNonEmpty(AnyString(m["emoji"]), AnyString(m["reaction"]), AnyString(m["emoticon"]))
		count := int(AnyInt64(m["count"]))
		if emoji != "" {
			out = append(out, Reaction{Emoji: emoji, Count: count})
		}
	}
	return out
}

func parseTimestamp(r map[string]any, date string) int64 {
	if s := AnyString(r["date_unixtime"]); s != "" {
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return n
		}
	}
	for _, l := range []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(l, date); err == nil {
			return t.Unix()
		}
	}
	return 0
}

func extractText(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []any:
		var b strings.Builder
		for _, it := range x {
			switch y := it.(type) {
			case string:
				b.WriteString(y)
			case map[string]any:
				b.WriteString(AnyString(y["text"]))
			}
		}
		return b.String()
	default:
		return ""
	}
}

func extractEntities(v any, fallback string) []Entity {
	arr, ok := v.([]any)
	if !ok || len(arr) == 0 {
		if fallback == "" {
			return nil
		}
		return []Entity{{Type: "plain", Text: fallback}}
	}
	out := make([]Entity, 0, len(arr))
	for _, it := range arr {
		m, ok := it.(map[string]any)
		if !ok {
			continue
		}
		txt := AnyString(m["text"])
		if txt == "" {
			continue
		}
		href := FirstNonEmpty(AnyString(m["href"]), AnyString(m["url"]))
		out = append(out, Entity{Type: AnyString(m["type"]), Text: txt, Href: href})
	}
	if len(out) == 0 && fallback != "" {
		out = append(out, Entity{Type: "plain", Text: fallback})
	}
	return out
}

func MessageExpectsMedia(r map[string]any, mediaType string) bool {
	if mediaType != "" {
		return true
	}
	for _, k := range []string{"photo", "file", "sticker_emoji"} {
		v, ok := r[k]
		if !ok || v == nil {
			continue
		}
		if s := strings.TrimSpace(AnyString(v)); s != "" {
			return true
		}
		if _, ok := v.(map[string]any); ok {
			return true
		}
	}
	return false
}

var reMsg = regexp.MustCompile(`(?i)^msg_(\d+)__`)
var reTdlDefault = regexp.MustCompile(`^-?\d+_(\d+)_`)

// MessageIDFromFilename extracts a Telegram message id from tdl-style media names.
func MessageIDFromFilename(base string) string {
	if m := reMsg.FindStringSubmatch(base); len(m) == 2 {
		return m[1]
	}
	if m := reTdlDefault.FindStringSubmatch(base); len(m) == 2 {
		return m[1]
	}
	return ""
}

func ScanMedia(dir string) (map[string][]Media, []string, error) {
	by := map[string][]Media{}
	var unmatched []string
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return by, unmatched, nil
	}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		base := d.Name()
		var id string
		if m := reMsg.FindStringSubmatch(base); len(m) == 2 {
			id = m[1]
		}
		if id == "" {
			if m := reTdlDefault.FindStringSubmatch(base); len(m) == 2 {
				id = m[1]
			}
		}
		rel, _ := filepath.Rel(filepath.Dir(dir), path)
		rel = filepath.ToSlash(rel)
		info, _ := d.Info()
		med := Media{Path: rel, Name: base, Kind: MediaKind(base), Ext: strings.TrimPrefix(strings.ToLower(filepath.Ext(base)), ".")}
		if info != nil {
			med.Size = info.Size()
		}
		if med.Size == 0 || id == "" {
			unmatched = append(unmatched, rel)
			return nil
		}
		by[id] = append(by[id], med)
		return nil
	})
	if err != nil {
		return nil, nil, fmt.Errorf("扫描媒体目录失败: %w", err)
	}
	for id := range by {
		sort.Slice(by[id], func(i, j int) bool { return by[id][i].Name < by[id][j].Name })
	}
	return by, unmatched, nil
}

func MediaKind(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif", ".heic":
		return "image"
	case ".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi", ".3gp":
		return "video"
	case ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".flac":
		return "audio"
	default:
		return "file"
	}
}

func AnyString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		return x.String()
	case float64:
		if x == float64(int64(x)) {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case nil:
		return ""
	default:
		b, _ := json.Marshal(x)
		if string(b) == "null" {
			return ""
		}
		return strings.Trim(string(b), `"`)
	}
}

func AnyInt64(v any) int64 {
	s := AnyString(v)
	if s == "" {
		return 0
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return int64(f)
	}
	return 0
}

func FirstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if strings.TrimSpace(x) != "" {
			return x
		}
	}
	return ""
}

func ArchiveTimeRange(a *Archive) (first, last int64) {
	for _, m := range a.Messages {
		if m.TS <= 0 {
			continue
		}
		if first == 0 || m.TS < first {
			first = m.TS
		}
		if m.TS > last {
			last = m.TS
		}
	}
	return
}

func ReportFromArchive(a *Archive) Report {
	status := "ok"
	if a.Stats.MissingMedia > 0 || a.Stats.SizeMismatch > 0 {
		status = "warning"
	}
	return Report{Version: model.Version, GeneratedAt: a.GeneratedAt, Chat: a.Chat, Stats: a.Stats, Missing: a.Missing, Unmatched: a.Unmatched, Status: status}
}
