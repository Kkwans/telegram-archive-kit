package app

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"telegramarchivekit/internal/archive"
)

// MediaItemDTO is one locally stored media/document file for the desktop
// viewer. Rel and Thumb are workspace-relative paths, so official-export
// media can be streamed and revealed exactly where it lives.
type MediaItemDTO struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"` // image|video|audio|file
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"`
	Rel     string `json:"rel"`
	Thumb   string `json:"thumb,omitempty"`
}

func mediaKindFromExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif", ".jxl", ".tif", ".tiff":
		return "image"
	case ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi":
		return "video"
	case ".mp3", ".m4a", ".ogg", ".opus", ".flac", ".wav", ".aac":
		return "audio"
	default:
		return "file"
	}
}

func mediaMessageID(name string) string {
	base := strings.TrimSuffix(name, filepath.Ext(name))
	parts := strings.Split(base, "_")
	if len(parts) < 2 {
		return ""
	}
	if _, err := strconv.ParseInt(parts[1], 10, 64); err != nil {
		return ""
	}
	return parts[1]
}

type archiveDataMessage struct {
	ID    string `json:"id"`
	Media []struct {
		Path  string `json:"path"`
		Thumb string `json:"thumb"`
		Name  string `json:"name"`
		Kind  string `json:"kind"`
		Size  int64  `json:"size"`
		Ext   string `json:"ext"`
	} `json:"media"`
}

type archiveDataFile struct {
	Messages []archiveDataMessage `json:"messages"`
}

// mediaSummary mirrors what ChatMedia can actually display. Archive metadata
// from older builds still counts *_thumb.jpg previews, so the chat list cannot
// trust meta.MediaCount alone.
type mediaSummary struct {
	Total  int
	Images int
	Videos int
	Audio  int
	Files  int
	Bytes  int64
}

type mediaCacheEntry struct {
	summary mediaSummary
	at      time.Time
}

const mediaSummaryTTL = 8 * time.Second

func (f *Facade) workspaceMediaSummary(slug string) mediaSummary {
	key := f.a.Settings.LibraryRoot + "\x00" + slug
	f.mediaMu.Lock()
	if entry, ok := f.mediaCache[key]; ok && time.Since(entry.at) < mediaSummaryTTL {
		f.mediaMu.Unlock()
		return entry.summary
	}
	f.mediaMu.Unlock()
	summary := f.scanWorkspaceMediaSummary(slug)
	f.mediaMu.Lock()
	if f.mediaCache == nil {
		f.mediaCache = map[string]mediaCacheEntry{}
	}
	f.mediaCache[key] = mediaCacheEntry{summary: summary, at: time.Now()}
	f.mediaMu.Unlock()
	return summary
}

func (f *Facade) scanWorkspaceMediaSummary(slug string) mediaSummary {
	var out mediaSummary
	root := f.a.workspaceDir(slug)
	seen := map[string]bool{}
	add := func(rel, name, kind string, size int64) {
		rel = strings.TrimSpace(strings.ReplaceAll(rel, "\\", "/"))
		if rel == "" || strings.HasPrefix(rel, "/") || hasParentSegment(rel) || strings.ContainsRune(rel, ':') {
			return
		}
		if seen[rel] || archive.IsThumbnailFile(rel) || archive.IsThumbnailFile(name) {
			return
		}
		if name == "" {
			name = filepath.Base(rel)
		}
		if kind == "" {
			kind = mediaKindFromExt(filepath.Ext(name))
		}
		seen[rel] = true
		out.Total++
		out.Bytes += size
		switch kind {
		case "image":
			out.Images++
		case "video":
			out.Videos++
		case "audio":
			out.Audio++
		default:
			out.Files++
		}
	}
	if data, err := os.ReadFile(filepath.Join(root, "data", "archive-data.js")); err == nil {
		text := string(data)
		if i := strings.IndexByte(text, '{'); i >= 0 {
			var parsed archiveDataFile
			if json.NewDecoder(strings.NewReader(text[i:])).Decode(&parsed) == nil {
				for _, m := range parsed.Messages {
					for _, x := range m.Media {
						add(x.Path, x.Name, x.Kind, x.Size)
					}
				}
			}
		}
	}
	for _, dir := range []string{"media", "files"} {
		entries, err := os.ReadDir(filepath.Join(root, dir))
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			add(dir+"/"+entry.Name(), entry.Name(), mediaKindFromExt(filepath.Ext(entry.Name())), info.Size())
		}
	}
	return out
}

func hasParentSegment(rel string) bool {
	for _, part := range strings.Split(rel, "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

func (f *Facade) mediaRelAbs(slug, rel string) (string, string, error) {
	if slug == "" || slug != filepath.Base(slug) {
		return "", "", errors.New("无效的聊天标识")
	}
	rel = strings.TrimSpace(strings.ReplaceAll(rel, "\\", "/"))
	if rel == "" || strings.HasPrefix(rel, "/") || hasParentSegment(rel) || strings.ContainsRune(rel, ':') {
		return "", "", errors.New("无效的媒体路径")
	}
	clean := filepath.Clean(filepath.FromSlash(rel))
	root := f.a.workspaceDir(slug)
	abs := filepath.Join(root, clean)
	back, err := filepath.Rel(root, abs)
	if err != nil || back == ".." || strings.HasPrefix(back, ".."+string(filepath.Separator)) {
		return "", "", errors.New("无效的媒体路径")
	}
	st, err := os.Stat(abs)
	if err != nil || st.IsDir() {
		return "", "", os.ErrNotExist
	}
	return abs, filepath.ToSlash(clean), nil
}

// ChatMedia lists downloaded media and documents for one chat, newest first.
// It prefers the built archive data because that carries message ids and
// generated thumbnails (including videos); raw directory scans are a fallback.
func (f *Facade) ChatMedia(slug string) ([]MediaItemDTO, error) {
	if slug == "" || slug != filepath.Base(slug) {
		return nil, errors.New("无效的聊天标识")
	}
	if _, err := f.a.readWorkspaceMeta(slug); err != nil {
		return nil, err
	}
	root := f.a.workspaceDir(slug)
	items := make([]MediaItemDTO, 0, 256)
	seen := make(map[string]bool)

	add := func(id, name, kind, rel, thumb string, size int64, modTime int64) {
		rel = strings.ReplaceAll(rel, "\\", "/")
		if rel == "" || seen[rel] || archive.IsThumbnailFile(name) || archive.IsThumbnailFile(rel) {
			return
		}
		abs, clean, err := f.mediaRelAbs(slug, rel)
		if err != nil {
			return
		}
		if name == "" {
			name = filepath.Base(abs)
		}
		if kind == "" {
			kind = mediaKindFromExt(filepath.Ext(name))
		}
		if size <= 0 {
			if st, err := os.Stat(abs); err == nil {
				size = st.Size()
				if modTime == 0 {
					modTime = st.ModTime().UnixMilli()
				}
			}
		}
		thumbRel := ""
		if thumb != "" {
			if _, tClean, err := f.mediaRelAbs(slug, thumb); err == nil {
				thumbRel = tClean
			}
		}
		if id == "" {
			id = mediaMessageID(name)
		}
		seen[rel] = true
		items = append(items, MediaItemDTO{
			ID: id, Name: name, Kind: kind, Size: size, ModTime: modTime, Rel: clean, Thumb: thumbRel,
		})
	}

	if data, err := os.ReadFile(filepath.Join(root, "data", "archive-data.js")); err == nil {
		text := string(data)
		if i := strings.IndexByte(text, '{'); i >= 0 {
			var parsed archiveDataFile
			dec := json.NewDecoder(strings.NewReader(text[i:]))
			if dec.Decode(&parsed) == nil {
				for _, m := range parsed.Messages {
					for _, x := range m.Media {
						add(m.ID, x.Name, x.Kind, x.Path, x.Thumb, x.Size, 0)
					}
				}
			}
		}
	}

	for _, dir := range []string{"media", "files"} {
		entries, err := os.ReadDir(filepath.Join(root, dir))
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			add(mediaMessageID(e.Name()), e.Name(), mediaKindFromExt(filepath.Ext(e.Name())), dir+"/"+e.Name(), "", info.Size(), info.ModTime().UnixMilli())
		}
	}

	// Newest message first by default; the desktop gallery offers explicit
	// oldest-first and size sorting on top of this.
	sort.SliceStable(items, func(i, j int) bool {
		ai, _ := strconv.ParseInt(items[i].ID, 10, 64)
		aj, _ := strconv.ParseInt(items[j].ID, 10, 64)
		if ai != aj {
			return ai > aj
		}
		if items[i].ModTime != items[j].ModTime {
			return items[i].ModTime > items[j].ModTime
		}
		return items[i].Name > items[j].Name
	})
	return items, nil
}

// MediaFilePath resolves a workspace-relative media path for streaming.
func (f *Facade) MediaFilePath(slug, rel string) (string, error) {
	abs, _, err := f.mediaRelAbs(slug, rel)
	return abs, err
}

// OpenMedia opens the file with the system default application.
func (f *Facade) OpenMedia(slug, rel string) error {
	abs, _, err := f.mediaRelAbs(slug, rel)
	if err != nil {
		return err
	}
	return openInBrowser(abs)
}

// RevealMedia opens Explorer with the exact file selected.
func (f *Facade) RevealMedia(slug, rel string) error {
	abs, _, err := f.mediaRelAbs(slug, rel)
	if err != nil {
		return err
	}
	return revealFileInExplorer(abs)
}

func (f *Facade) MediaRoot(slug string) string {
	return f.a.workspaceDir(slug)
}
