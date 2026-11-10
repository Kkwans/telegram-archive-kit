package app

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
)

// MediaItemDTO refers only to a real, regular workspace file. ThumbSize and
// ThumbModTime describe the checked thumbnail, not the media it represents.
type MediaItemDTO struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	Size         int64  `json:"size"`
	ModTime      int64  `json:"modTime"`
	Rel          string `json:"rel"`
	Thumb        string `json:"thumb,omitempty"`
	ThumbSize    int64  `json:"thumbSize,omitempty"`
	ThumbModTime int64  `json:"thumbModTime,omitempty"`
	Width        int    `json:"width,omitempty"`
	Height       int    `json:"height,omitempty"`
}

type MediaSummary struct {
	Total      int   `json:"total"`
	Images     int   `json:"images"`
	Videos     int   `json:"videos"`
	Audio      int   `json:"audio"`
	Files      int   `json:"files"`
	Bytes      int64 `json:"bytes"`
	ImageBytes int64 `json:"imageBytes"`
	VideoBytes int64 `json:"videoBytes"`
	AudioBytes int64 `json:"audioBytes"`
	FileBytes  int64 `json:"fileBytes"`
}

type MediaQuery struct {
	LibraryKey string `json:"libraryKey"`
	Slug       string `json:"slug"`
	Kind       string `json:"kind"`
	Sort       string `json:"sort"`
	Query      string `json:"query"`
	Version    string `json:"version"`
	Page       int    `json:"page"`
	PageSize   int    `json:"pageSize"`
	Refresh    bool   `json:"refresh"`
}

type MediaPageDTO struct {
	Items    []MediaItemDTO `json:"items"`
	Total    int            `json:"total"`
	Page     int            `json:"page"`
	PageSize int            `json:"pageSize"`
	Version  string         `json:"version"`
	Summary  MediaSummary   `json:"summary"`
	Stale    bool           `json:"stale"`
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

func hasParentSegment(rel string) bool {
	for _, part := range strings.Split(rel, "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

func (f *Facade) mediaRelAbs(slug, rel string) (string, string, error) {
	return mediaRelAbsAt(f.libraryRoot(), slug, rel)
}

func mediaRelAbsAt(libraryRoot, slug, rel string) (string, string, error) {
	root, err := checkedWorkspaceDir(libraryRoot, slug)
	if err != nil {
		return "", "", err
	}
	return checkedWorkspaceFile(root, rel, nil)
}

// ChatMedia returns a page from one immutable catalog version. An explicit
// refresh waits for a complete scan; a matching cached first page needs no NAS
// access and can be shown while an overdue catalog is checked in the background.
func (f *Facade) ChatMedia(ctx context.Context, q MediaQuery) (MediaPageDTO, error) {
	root := f.libraryRoot()
	if root == "" || !validWorkspaceSlug(q.Slug) {
		return MediaPageDTO{}, errors.New("无效的聊天标识")
	}
	if q.LibraryKey != "" && q.LibraryKey != libraryFingerprint(root) {
		return MediaPageDTO{}, errors.New("档案库已切换，请重新加载")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return f.queryMediaCatalog(ctx, root, q)
}

func (f *Facade) MediaFilePath(slug, rel string) (string, error) {
	abs, _, err := f.mediaRelAbs(slug, rel)
	return abs, err
}

func (f *Facade) OpenMedia(slug, rel, libraryKey string) error {
	root, _, ok := f.MediaLibrary(libraryKey)
	if !ok {
		return errors.New("档案库已切换，请重新加载")
	}
	abs, _, err := mediaRelAbsAt(root, slug, rel)
	if err != nil {
		return err
	}
	return openInBrowser(abs)
}

func (f *Facade) RevealMedia(slug, rel, libraryKey string) error {
	root, _, ok := f.MediaLibrary(libraryKey)
	if !ok {
		return errors.New("档案库已切换，请重新加载")
	}
	abs, _, err := mediaRelAbsAt(root, slug, rel)
	if err != nil {
		return err
	}
	return revealFileInExplorer(abs)
}

func (f *Facade) MediaRoot(slug string) string {
	return filepath.Join(f.libraryRoot(), "chats", slug)
}
