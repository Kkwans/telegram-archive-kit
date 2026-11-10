package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"telegramarchivekit/internal/archive"
)

type catalogReference struct{ id, name, kind, rel, thumb string }
type catalogFile struct {
	rel           string
	size, modTime int64
}

// Windows resolves relative path components without regard to case. Use the
// same identity for all references, while preserving the actual entry spelling.
func catalogRelKey(rel string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(rel)
	}
	return rel
}

func scanWorkspaceCatalog(ctx context.Context, libraryRoot, slug string) ([]MediaItemDTO, MediaSummary, error) {
	var empty MediaSummary
	root, err := checkedWorkspaceDir(libraryRoot, slug)
	if err != nil {
		return nil, empty, err
	}
	checked := make(map[string]error)
	metaPath, _, err := checkedWorkspaceFile(root, "workspace.json", checked)
	if err != nil {
		return nil, empty, err
	}
	data, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, empty, err
	}
	var workspace WorkspaceMeta
	if err := json.Unmarshal(data, &workspace); err != nil {
		return nil, empty, fmt.Errorf("读取聊天信息: %w", err)
	}
	readOptional := func(rel string) ([]byte, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		abs, _, err := checkedWorkspaceFile(root, rel, checked)
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return os.ReadFile(abs)
	}

	// Preserve archive-data precedence, then official exports; files already
	// listed by one source cannot replace it with less complete raw metadata.
	refs := make([]catalogReference, 0, 256)
	if data, err := readOptional("data/archive-data.js"); err != nil {
		return nil, empty, err
	} else if len(data) > 0 {
		start := bytes.IndexByte(data, '{')
		if start < 0 {
			return nil, empty, errors.New("媒体归档数据格式无效")
		}
		var parsed archiveDataFile
		if err := json.NewDecoder(bytes.NewReader(data[start:])).Decode(&parsed); err != nil {
			return nil, empty, fmt.Errorf("读取媒体归档: %w", err)
		}
		for _, msg := range parsed.Messages {
			for _, x := range msg.Media {
				refs = append(refs, catalogReference{msg.ID, x.Name, x.Kind, x.Path, x.Thumb})
			}
		}
	}
	if data, err := readOptional("official-media-index.json"); err != nil {
		return nil, empty, err
	} else if len(data) > 0 {
		var idx officialIndexFile
		if err := json.Unmarshal(data, &idx); err != nil {
			return nil, empty, fmt.Errorf("读取官方媒体索引: %w", err)
		}
		for _, ex := range idx.Exports {
			ids := make([]string, 0, len(ex.Media))
			for id := range ex.Media {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			for _, id := range ids {
				for _, x := range ex.Media[id] {
					refs = append(refs, catalogReference{id, x.Name, x.Kind, x.Path, x.Thumb})
				}
			}
		}
	}
	dimensions := make(map[string][2]int)
	if data, err := readOptional("source/result.json"); err != nil {
		// Dimensions are optional; media and summary do not depend on them.
		if ctx.Err() != nil {
			return nil, empty, ctx.Err()
		}
	} else if len(data) > 0 {
		var source struct {
			Messages []struct {
				ID     json.RawMessage `json:"id"`
				Width  int             `json:"width"`
				Height int             `json:"height"`
			} `json:"messages"`
		}
		if json.Unmarshal(data, &source) == nil {
			for _, msg := range source.Messages {
				id := strings.Trim(strings.TrimSpace(string(msg.ID)), `"`)
				if id != "" && msg.Width > 0 && msg.Height > 0 {
					dimensions[id] = [2]int{msg.Width, msg.Height}
				}
			}
		}
	}

	// Read each referenced directory once. On Windows DirEntry.Info returns
	// the FindFirstFile data directly, without a remote stat for every item.
	dirs := map[string]string{}
	wanted := map[string]bool{}
	addDir := func(dir string) {
		key := catalogRelKey(dir)
		if _, exists := dirs[key]; !exists {
			dirs[key] = dir
		}
	}
	for _, dir := range []string{"media", "files", "thumbs"} {
		addDir(dir)
	}
	for i := range refs {
		clean, ok := cleanWorkspaceFile(refs[i].rel)
		if !ok || archive.IsThumbnailFile(clean) || archive.IsThumbnailFile(refs[i].name) {
			refs[i].rel = ""
			continue
		}
		refs[i].rel = clean
		wanted[catalogRelKey(clean)] = true
		addDir(filepath.ToSlash(filepath.Dir(filepath.FromSlash(clean))))
		if thumb, ok := cleanWorkspaceFile(refs[i].thumb); ok {
			refs[i].thumb = thumb
			wanted[catalogRelKey(thumb)] = true
			addDir(filepath.ToSlash(filepath.Dir(filepath.FromSlash(thumb))))
		} else {
			refs[i].thumb = ""
		}
	}
	dirList := make([]string, 0, len(dirs))
	for _, dir := range dirs {
		dirList = append(dirList, dir)
	}
	sort.Strings(dirList)
	files := map[string]catalogFile{}
	raw := make([]catalogReference, 0, 256)
	thumbsByID := map[string]string{}
	for _, dir := range dirList {
		if err := ctx.Err(); err != nil {
			return nil, empty, err
		}
		if err := checkWorkspaceParents(root, filepath.FromSlash(dir), checked); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, empty, fmt.Errorf("读取媒体目录 %s: %w", dir, err)
		}
		entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(dir)))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, empty, fmt.Errorf("读取媒体目录 %s: %w", dir, err)
		}
		rawDir := catalogRelKey(dir) == catalogRelKey("media") || catalogRelKey(dir) == catalogRelKey("files")
		thumbDir := catalogRelKey(dir) == catalogRelKey("thumbs")
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return nil, empty, err
			}
			name := entry.Name()
			rel := name
			if dir != "." {
				rel = dir + "/" + name
			}
			clean, ok := cleanWorkspaceFile(rel)
			if !ok || entry.Type()&os.ModeType != 0 {
				continue
			}
			key := catalogRelKey(clean)
			generatedID := ""
			if thumbDir {
				generatedID = mediaMessageID(name)
			}
			rawCandidate := rawDir && !strings.HasPrefix(name, ".") && !archive.IsThumbnailFile(clean)
			if !wanted[key] && !rawCandidate && generatedID == "" {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				return nil, empty, fmt.Errorf("读取媒体文件 %s: %w", clean, err)
			}
			if !info.Mode().IsRegular() {
				continue
			}
			files[key] = catalogFile{clean, info.Size(), info.ModTime().UnixMilli()}
			if generatedID != "" {
				thumbsByID[generatedID] = clean
			}
			if rawCandidate {
				raw = append(raw, catalogReference{mediaMessageID(name), name, mediaKindFromExt(filepath.Ext(name)), clean, ""})
			}
		}
	}
	refs = append(refs, raw...)
	items := make([]MediaItemDTO, 0, len(refs))
	seen := map[string]bool{}
	var summary MediaSummary
	for _, ref := range refs {
		if err := ctx.Err(); err != nil {
			return nil, empty, err
		}
		key := catalogRelKey(ref.rel)
		file, ok := files[key]
		if !ok || ref.rel == "" || seen[key] {
			continue
		}
		name := ref.name
		if name == "" {
			name = filepath.Base(filepath.FromSlash(file.rel))
		}
		kind := strings.ToLower(ref.kind)
		switch kind {
		case "image", "video", "audio", "file":
		default:
			kind = mediaKindFromExt(filepath.Ext(name))
		}
		id := ref.id
		if id == "" {
			id = mediaMessageID(name)
		}
		thumb, hasThumb := files[catalogRelKey(ref.thumb)]
		if !hasThumb {
			thumb, hasThumb = files[catalogRelKey(thumbsByID[id])]
		}
		item := MediaItemDTO{ID: id, Name: name, Kind: kind, Rel: file.rel, Size: file.size, ModTime: file.modTime}
		if hasThumb {
			item.Thumb, item.ThumbSize, item.ThumbModTime = thumb.rel, thumb.size, thumb.modTime
		}
		if dim, ok := dimensions[id]; ok {
			item.Width, item.Height = dim[0], dim[1]
		}
		items = append(items, item)
		seen[key] = true
		summary.Total++
		summary.Bytes += item.Size
		switch kind {
		case "image":
			summary.Images++
			summary.ImageBytes += item.Size
		case "video":
			summary.Videos++
			summary.VideoBytes += item.Size
		case "audio":
			summary.Audio++
			summary.AudioBytes += item.Size
		default:
			summary.Files++
			summary.FileBytes += item.Size
		}
	}
	return items, summary, nil
}
