package app

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// MediaItemDTO is one locally stored media/document file for the desktop
// viewer. Files are streamed back through /api/media with Range support.
type MediaItemDTO struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"` // image|video|audio|file
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"`
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

// ChatMedia lists downloaded media and documents for one chat, newest first.
func (f *Facade) ChatMedia(slug string) ([]MediaItemDTO, error) {
	if slug == "" || slug != filepath.Base(slug) {
		return nil, errors.New("无效的聊天标识")
	}
	if _, err := f.a.readWorkspaceMeta(slug); err != nil {
		return nil, err
	}
	items := make([]MediaItemDTO, 0, 128)
	for _, dir := range []string{f.a.mediaDir(slug), f.a.filesDir(slug)} {
		entries, err := os.ReadDir(dir)
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
			items = append(items, MediaItemDTO{
				ID:      mediaMessageID(e.Name()),
				Name:    e.Name(),
				Kind:    mediaKindFromExt(filepath.Ext(e.Name())),
				Size:    info.Size(),
				ModTime: info.ModTime().UnixMilli(),
			})
		}
	}
	sort.Slice(items, func(i, j int) bool {
		ai, _ := strconv.ParseInt(items[i].ID, 10, 64)
		aj, _ := strconv.ParseInt(items[j].ID, 10, 64)
		if ai != aj {
			return ai > aj
		}
		return items[i].Name < items[j].Name
	})
	return items, nil
}

// MediaFilePath resolves a viewer file to a path inside the chat workspace.
func (f *Facade) MediaFilePath(slug, name string) (string, error) {
	if slug == "" || slug != filepath.Base(slug) || name == "" || name != filepath.Base(name) {
		return "", errors.New("无效的媒体路径")
	}
	for _, dir := range []string{f.a.mediaDir(slug), f.a.filesDir(slug)} {
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	return "", os.ErrNotExist
}

func (f *Facade) MediaRoot(slug string) string {
	return f.a.workspaceDir(slug)
}
