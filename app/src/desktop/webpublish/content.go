package webpublish

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"telegramarchivekit/internal/app"
	"telegramarchivekit/internal/media"
	"telegramarchivekit/internal/model"
	"telegramarchivekit/internal/render"
)

const maxArchiveBytes = 64 << 20

type Catalog struct {
	Chats   []Chat
	Version [32]byte
	stamp   time.Time
	size    int64
}

type Chat struct {
	Slug  string `json:"slug"`
	Name  string `json:"name"`
	Count int    `json:"messages"`
	Ready bool   `json:"ready"`
	ID    string `json:"id"`
	info  model.LibraryChat
}

// ReadCatalog only reads the manifest written after a completed library build.
func ReadCatalog(ctx context.Context, library string) (Catalog, error) {
	return readCatalog(ctx, library, Catalog{})
}

func readCatalog(ctx context.Context, library string, previous Catalog) (Catalog, error) {
	root, err := os.OpenRoot(library)
	if err != nil {
		return Catalog{}, err
	}
	defer root.Close()
	info, err := root.Lstat("library.json")
	if err != nil || !info.Mode().IsRegular() {
		return Catalog{}, fs.ErrNotExist
	}
	if previous.stamp.Equal(info.ModTime()) && previous.size == info.Size() {
		return previous, nil
	}
	data, err := readFile(ctx, root, "library.json", 16<<20)
	if err != nil {
		return Catalog{}, err
	}
	var index model.LibraryManifest
	if err := json.Unmarshal(data, &index); err != nil {
		return Catalog{}, err
	}
	h := sha256.New()
	_, _ = h.Write(data)
	_, _ = io.WriteString(h, strconv.FormatInt(info.ModTime().UnixNano(), 10))
	out := Catalog{Chats: make([]Chat, 0, len(index.Chats)), stamp: info.ModTime(), size: info.Size()}
	copy(out.Version[:], h.Sum(nil))
	for _, chat := range index.Chats {
		if !localPath(chat.Slug) || strings.Contains(chat.Slug, "/") {
			continue
		}
		ready := chat.DataScript == "chats/"+chat.Slug+"/data/archive-data.js"
		if ready && chat.Pages == 0 {
			// Old manifests may omit the page count. Distinguish those archives
			// from a download that has not produced its first web build yet.
			data, err := root.Lstat(chat.DataScript)
			ready = err == nil && data.Mode().IsRegular()
		}
		out.Chats = append(out.Chats, Chat{
			Slug: chat.Slug, ID: chat.ID, Name: chat.Name, Count: chat.Messages,
			Ready: ready, info: chat,
		})
	}
	return out, nil
}

func localPath(path string) bool {
	if !fs.ValidPath(path) || path == "." || strings.ContainsAny(path, `\:`) || !filepath.IsLocal(filepath.FromSlash(path)) {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if strings.TrimRight(part, " .") != part {
			return false
		}
	}
	return true
}

// Open a real directory relative to its parent, never a directory alias.
func childRoot(parent *os.Root, path string) (*os.Root, error) {
	info, err := parent.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode().Type() != os.ModeDir {
		return nil, fs.ErrNotExist
	}
	root, err := parent.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(info, opened) {
		root.Close()
		return nil, fs.ErrNotExist
	}
	return root, nil
}

type contextReader struct {
	ctx context.Context
	*os.File
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.File.Read(p)
}

func readFile(ctx context.Context, root *os.Root, path string, max int64) ([]byte, error) {
	f, err := openRegular(root, path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(contextReader{ctx, f}, max+1))
	if int64(len(data)) > max {
		return nil, errors.New("归档数据超出网页服务读取上限")
	}
	return data, err
}

func openRegular(root *os.Root, path string) (*os.File, error) {
	if !localPath(filepath.ToSlash(path)) {
		return nil, fs.ErrNotExist
	}
	parts := strings.Split(filepath.ToSlash(path), "/")
	var expected fs.FileInfo
	for i := range parts {
		name := filepath.Join(parts[:i+1]...)
		info, err := root.Lstat(name)
		if err != nil {
			return nil, err
		}
		if i == len(parts)-1 {
			if !info.Mode().IsRegular() {
				return nil, fs.ErrNotExist
			}
			expected = info
		} else if info.Mode().Type() != os.ModeDir {
			return nil, fs.ErrNotExist
		}
	}
	f, err := root.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(expected, info) {
		f.Close()
		return nil, fs.ErrNotExist
	}
	return f, nil
}

type fileRef struct {
	// A relative base is inside this workspace. An absolute base is the
	// explicitly registered root of a referenced official export.
	base, path, name, kind string
}

type chatContent struct {
	chat   model.Chat
	pages  [][]model.Message
	strict [][]model.Message
	search []byte
	dates  []byte
	files  map[string]fileRef
	cost   int
}

func loadChat(ctx context.Context, library, slug string) (*chatContent, error) {
	root, err := openWorkspace(library, slug)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	data, err := readFile(ctx, root, "data/archive-data.js", maxArchiveBytes)
	if err != nil {
		return nil, err
	}
	arc, err := app.DecodePublicationArchive(data)
	if err != nil {
		return nil, err
	}
	ws := filepath.Join(library, "chats", slug)
	var official []app.PublicationOfficialExport
	if b, err := readFile(ctx, root, "official-media-index.json", maxArchiveBytes); err == nil {
		official, _ = app.DecodePublicationOfficialIndex(b)
	}
	registered := officialReferences(ws, official)
	out := &chatContent{chat: arc.Chat, files: make(map[string]fileRef)}
	for i := range arc.Messages {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		m := &arc.Messages[i]
		for j := range m.Entities {
			safeEntity(&m.Entities[j])
		}
		kept := m.Media[:0]
		for _, item := range m.Media {
			item.Path = out.mediaURL(item.Path, item.Name, item.Kind, false, registered)
			if item.Path == "" {
				continue
			}
			item.Thumb = out.mediaURL(item.Thumb, item.Name, "image", true, registered)
			kept = append(kept, item)
		}
		m.Media = kept
	}
	out.pages = render.VisualPages(arc.Messages)
	byID := make(map[string]model.Message, len(arc.Messages))
	for _, m := range arc.Messages {
		byID[m.ID] = m
	}
	out.strict = make([][]model.Message, len(out.pages))
	for i, page := range out.pages {
		var raw []model.Message
		for _, m := range page {
			for _, id := range m.SourceIDs {
				if original, ok := byID[id]; ok {
					raw = append(raw, original)
				}
			}
		}
		out.strict[i] = render.GroupStrictAlbums(raw)
	}
	if out.search, err = app.SearchIndexScript(arc); err != nil {
		return nil, err
	}
	if out.dates, err = app.DateIndexScript(arc); err != nil {
		return nil, err
	}
	out.cost = len(data)*4 + len(out.search) + len(out.dates) + len(out.files)*192
	return out, nil
}

func openWorkspace(library, slug string) (*os.Root, error) {
	root, err := os.OpenRoot(library)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	chats, err := childRoot(root, "chats")
	if err != nil {
		return nil, err
	}
	defer chats.Close()
	return childRoot(chats, slug)
}

func officialReferences(workspace string, exports []app.PublicationOfficialExport) map[string]fileRef {
	out := map[string]fileRef{}
	for _, export := range exports {
		base := filepath.FromSlash(export.Meta.Root)
		if base == "" || base == "." {
			continue
		}
		if !filepath.IsAbs(base) {
			if !localPath(filepath.ToSlash(base)) {
				continue
			}
			base = filepath.Join(workspace, base)
		} else if export.Meta.Mode != "referenced" {
			// A managed/copied registration can use an old absolute path, but it
			// still has to be inside its workspace.
			rel, err := filepath.Rel(workspace, base)
			if err != nil || !localPath(filepath.ToSlash(rel)) {
				continue
			}
		}
		base = filepath.Clean(base)
		// A drive/share root cannot be an official export directory.
		if filepath.Dir(base) == base || strings.EqualFold(base, workspace) {
			continue
		}
		serveBase := base
		if rel, err := filepath.Rel(workspace, base); err == nil && localPath(filepath.ToSlash(rel)) {
			serveBase = filepath.ToSlash(rel)
		}
		for _, items := range export.Media {
			for _, item := range items {
				for _, path := range []string{item.Path, item.Thumb} {
					if path == "" {
						continue
					}
					abs := media.MediaLocalPath(workspace, path)
					rel, err := filepath.Rel(base, abs)
					if err == nil && localPath(filepath.ToSlash(rel)) {
						out[path] = fileRef{base: serveBase, path: filepath.ToSlash(rel)}
					}
				}
			}
		}
	}
	return out
}

func (c *chatContent) mediaURL(path, name, kind string, thumb bool, official map[string]fileRef) string {
	ref, ok := official[path]
	if !ok && localPath(path) {
		base, rel, _ := strings.Cut(path, "/")
		if (base == "media" || base == "files" || (thumb && base == "thumbs")) && localPath(rel) {
			ref, ok = fileRef{base: base, path: rel}, true
		}
	}
	if !ok {
		return ""
	}
	ref.name, ref.kind = filepath.Base(name), kind
	if thumb {
		ref.name = filepath.Base(ref.path)
	}
	digest := sha256.Sum256([]byte(ref.base + "\x00" + ref.path + "\x00" + ref.kind + "\x00" + ref.name))
	id := hex.EncodeToString(digest[:16])
	c.files[id] = ref
	return "_media/" + id
}

func safeEntity(e *model.Entity) {
	switch strings.ToLower(e.Type) {
	case "link", "url", "text_link", "email", "mention", "phone":
		value := strings.TrimSpace(e.Href)
		if value == "" {
			value = strings.TrimSpace(e.Text)
			if e.Type == "email" && !strings.HasPrefix(value, "mailto:") {
				value = "mailto:" + value
			} else if e.Type == "phone" && !strings.HasPrefix(value, "tel:") {
				value = "tel:" + value
			}
		}
		u, err := url.Parse(value)
		if err == nil {
			switch strings.ToLower(u.Scheme) {
			case "https", "http", "tg", "mailto", "tel":
				e.Href = value
				return
			}
		}
		e.Type, e.Href = "plain", ""
	}
}
