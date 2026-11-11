package webpublish

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"telegramarchivekit/assets"
	"telegramarchivekit/internal/model"
	"telegramarchivekit/internal/render"
)

const cacheBudget = 128 << 20

type Selection struct {
	Slug string `json:"slug"`
	ID   string `json:"id"`
}

type Scope struct {
	All   bool        `json:"all"`
	Chats []Selection `json:"chats"`
}

type Site struct {
	library  string
	mu       sync.Mutex
	entries  map[string]*entry
	index    []byte
	version  [32]byte
	cache    int
	closed   bool
	loads    chan struct{}
	media    chan struct{}
	requests chan struct{}
}

type entry struct {
	info    Chat
	ctx     context.Context
	cancel  context.CancelFunc
	content *chatContent
	loaded  [32]byte
	failed  [32]byte
	retry   time.Time
	touched time.Time
	job     chan struct{}
}

func NewSite(library string) *Site {
	return &Site{library: library, entries: map[string]*entry{}, loads: make(chan struct{}, 2), media: make(chan struct{}, 12), requests: make(chan struct{}, 64)}
}

func (s *Site) Publish(catalog Catalog, scope Scope) int {
	selected := make(map[string]string, len(scope.Chats))
	for _, item := range scope.Chats {
		selected[item.Slug] = item.ID
	}
	manifest := model.LibraryManifest{SchemaVersion: model.SchemaVersion, Generator: "TelegramArchiveKit/" + model.Version, Chats: []model.LibraryChat{}}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return 0
	}
	next := make(map[string]*entry)
	for _, chat := range catalog.Chats {
		id, checked := selected[chat.Slug]
		if !chat.Ready || (!scope.All && (!checked || id != chat.ID)) {
			continue
		}
		if _, duplicate := next[chat.Slug]; duplicate {
			continue
		}
		old := s.entries[chat.Slug]
		if old == nil || old.info.ID != chat.ID {
			ctx, cancel := context.WithCancel(context.Background())
			old = &entry{info: chat, ctx: ctx, cancel: cancel}
		}
		next[chat.Slug] = old
		row := chat.info
		row.DataScript, row.SourceRel, row.ReportRel, row.WorkspaceRel = "", "", "", ""
		row.MessagesRel = "chats/" + chat.Slug + "/messages.html"
		manifest.Chats = append(manifest.Chats, row)
	}
	for slug, old := range s.entries {
		if next[slug] != old {
			old.cancel()
			if old.content != nil {
				s.cache -= old.content.cost
			}
		}
	}
	data, _ := json.Marshal(manifest)
	s.index = append(append([]byte("window.__TAK_LIBRARY__ = "), data...), ';', '\n')
	s.entries, s.version = next, catalog.Version
	return len(next)
}

func (s *Site) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	for _, e := range s.entries {
		e.cancel()
	}
	s.entries, s.index, s.cache = nil, nil, 0
}

var assetRoutes = map[string]string{
	"/": "index.html", "/index.html": "index.html", "/favicon.svg": "favicon.svg", "/favicon.ico": "favicon.ico",
	"/assets/app.css": "app.css", "/assets/app.js": "app.js", "/assets/tak-lightbox.css": "tak-lightbox.css",
	"/assets/tak-lightbox.js": "tak-lightbox.js", "/assets/tak-prelude.js": "tak-prelude.js",
	"/assets/tak-bridge.css": "tak-bridge.css", "/assets/tak-bridge.js": "tak-bridge.js",
	"/assets/beautifier/style.css": "beautifier-theme.css", "/assets/beautifier/script.js": "beautifier-theme.js",
}

var pagePattern = regexp.MustCompile(`^(strict-)?messages([1-9][0-9]{0,6})?\.html$`)
var mediaPattern = regexp.MustCompile(`^_media/([0-9a-f]{32})$`)

func (s *Site) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'none'")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	select {
	case s.requests <- struct{}{}:
		defer func() { <-s.requests }()
	default:
		unavailable(w)
		return
	}
	if asset, ok := assetRoutes[r.URL.Path]; ok {
		data, err := assets.UI.ReadFile("ui/" + asset)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		serveBytes(w, r, asset, data)
		return
	}
	if r.URL.Path == "/library-data.js" {
		s.mu.Lock()
		index := s.index
		s.mu.Unlock()
		if index == nil {
			unavailable(w)
			return
		}
		serveBytes(w, r, "library-data.js", index)
		return
	}
	slug, route, ok := strings.Cut(strings.TrimPrefix(r.URL.Path, "/chats/"), "/")
	if !ok || !strings.HasPrefix(r.URL.Path, "/chats/") {
		http.NotFound(w, r)
		return
	}
	page, media := pagePattern.FindStringSubmatch(route), mediaPattern.FindStringSubmatch(route)
	if page == nil && media == nil && route != "data/search-index.js" && route != "data/date-index.js" {
		http.NotFound(w, r)
		return
	}
	s.mu.Lock()
	e := s.entries[slug]
	s.mu.Unlock()
	if e == nil {
		http.NotFound(w, r)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(e.ctx, cancel)
	defer stop()
	defer cancel()
	r = r.WithContext(ctx)
	content, err := s.content(ctx, e, slug)
	if err != nil {
		if e.ctx.Err() != nil {
			http.NotFound(w, r)
		} else if ctx.Err() == nil {
			unavailable(w)
		}
		return
	}
	if ctx.Err() != nil || e.ctx.Err() != nil {
		http.NotFound(w, r)
		return
	}
	switch {
	case route == "data/search-index.js":
		serveBytes(w, r, "search-index.js", content.search)
	case route == "data/date-index.js":
		serveBytes(w, r, "date-index.js", content.dates)
	case media != nil:
		if file, ok := content.files[media[1]]; ok {
			s.serveFile(w, r, slug, file)
		} else {
			http.NotFound(w, r)
		}
	case page != nil:
		n := 1
		if page[2] != "" {
			n, _ = strconv.Atoi(page[2])
		}
		pages := content.pages
		if page[1] != "" {
			pages = content.strict
		}
		if n > len(pages) {
			http.NotFound(w, r)
			return
		}
		html := render.RenderPage(content.chat, pages[n-1], n, len(pages))
		if page[1] != "" {
			html = strictLinks.ReplaceAllString(html, `href="strict-messages${1}.html`)
		}
		serveBytes(w, r, route, []byte(html))
	}
}

var strictLinks = regexp.MustCompile(`href="messages(\d*)\.html`)

func serveBytes(w http.ResponseWriter, r *http.Request, name string, data []byte) {
	if ext := filepath.Ext(name); ext == ".js" {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}

func unavailable(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "5")
	http.Error(w, "档案网页暂不可用，请稍后刷新", http.StatusServiceUnavailable)
}

func (s *Site) content(ctx context.Context, e *entry, slug string) (*chatContent, error) {
	for {
		s.mu.Lock()
		if e.ctx.Err() != nil || s.closed {
			s.mu.Unlock()
			return nil, context.Canceled
		}
		version, previous := s.version, e.content
		e.touched = time.Now()
		if previous != nil && (e.loaded == version || e.job != nil || (e.failed == version && time.Now().Before(e.retry))) {
			s.mu.Unlock()
			return previous, nil
		}
		if e.failed == version && time.Now().Before(e.retry) {
			s.mu.Unlock()
			return nil, errors.New("归档暂不可用")
		}
		if e.job != nil {
			job := e.job
			s.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-job:
				continue
			}
		}
		job := make(chan struct{})
		e.job = job
		s.mu.Unlock()
		if previous != nil {
			go s.load(e.ctx, e, slug, version, job)
			return previous, nil
		}
		return s.load(ctx, e, slug, version, job)
	}
}

func (s *Site) load(ctx context.Context, e *entry, slug string, version [32]byte, job chan struct{}) (*chatContent, error) {
	var data *chatContent
	var err error
	select {
	case s.loads <- struct{}{}:
		data, err = loadChat(ctx, s.library, slug)
		<-s.loads
	case <-ctx.Done():
		err = ctx.Err()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	defer close(job)
	e.job = nil
	if e.ctx.Err() != nil || s.closed {
		return nil, context.Canceled
	}
	if err != nil {
		if ctx.Err() == nil {
			e.failed, e.retry = version, time.Now().Add(5*time.Second)
		}
		return nil, err
	}
	if data.cost > cacheBudget {
		// The first request can still render the page. Do not retain it in the
		// cache or displace other chats beyond the budget.
		if e.content != nil {
			s.cache -= e.content.cost
			e.content = nil
		}
		return data, nil
	}
	if e.content != nil {
		s.cache -= e.content.cost
	}
	e.content, e.loaded = data, version
	s.cache += data.cost
	for s.cache > cacheBudget {
		var victim *entry
		for _, cached := range s.entries {
			if cached != e && cached.content != nil && (victim == nil || cached.touched.Before(victim.touched)) {
				victim = cached
			}
		}
		if victim == nil {
			break
		}
		s.cache -= victim.content.cost
		victim.content = nil
	}
	return data, nil
}

func (s *Site) serveFile(w http.ResponseWriter, r *http.Request, slug string, ref fileRef) {
	select {
	case s.media <- struct{}{}:
		defer func() { <-s.media }()
	case <-r.Context().Done():
		return
	}
	root, err := openFileRoot(s.library, slug, ref.base)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	f, err := openRegular(root, ref.path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || r.Context().Err() != nil {
		return
	}
	contentType := browserMediaType(ref.kind, filepath.Ext(ref.path))
	w.Header().Set("Content-Type", contentType)
	if contentType == "application/octet-stream" {
		name := strings.Map(func(r rune) rune {
			if r < 32 || r == 127 || r == '/' || r == '\\' {
				return '_'
			}
			return r
		}, ref.name)
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	}
	http.ServeContent(w, r, ref.name, info.ModTime(), contextReader{r.Context(), f})
}

func openFileRoot(library, slug, base string) (*os.Root, error) {
	if filepath.IsAbs(base) {
		resolved, err := filepath.EvalSymlinks(base)
		if err != nil || !strings.EqualFold(filepath.Clean(resolved), filepath.Clean(base)) {
			return nil, os.ErrNotExist
		}
		return os.OpenRoot(resolved)
	}
	root, err := openWorkspace(library, slug)
	if err != nil {
		return nil, err
	}
	for _, part := range strings.Split(base, "/") {
		child, err := childRoot(root, part)
		root.Close()
		if err != nil {
			return nil, err
		}
		root = child
	}
	return root, nil
}

func browserMediaType(kind, ext string) string {
	t := mime.TypeByExtension(strings.ToLower(ext))
	if (kind == "image" && strings.HasPrefix(t, "image/") && t != "image/svg+xml") ||
		(kind == "video" && strings.HasPrefix(t, "video/")) ||
		(kind == "audio" && strings.HasPrefix(t, "audio/")) {
		return t
	}
	return "application/octet-stream"
}
