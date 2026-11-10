package app

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	mediaPageSize          = 50
	mediaCatalogSchema     = 1
	mediaCatalogTTL        = 5 * time.Minute
	mediaCatalogRetryDelay = 30 * time.Second
	mediaCatalogMaxJobs    = 8
	mediaCatalogParallel   = 2
	mediaCatalogMaxEntries = 16
	mediaCatalogMaxLoaded  = 3
)

type mediaCatalogHeader struct {
	Schema  int                       `json:"schema"`
	Key     string                    `json:"key"`
	Version string                    `json:"version"`
	BuiltAt int64                     `json:"builtAt"`
	Summary MediaSummary              `json:"summary"`
	First   map[string][]MediaItemDTO `json:"first"`
}

type mediaCatalogSnapshot struct {
	items      []MediaItemDTO
	mu         sync.Mutex
	orders     map[string][]MediaItemDTO
	thumbnails map[string]catalogFile
}

type mediaCatalogEntry struct {
	loaded      bool
	header      *mediaCatalogHeader
	snapshot    *mediaCatalogSnapshot
	generation  uint64
	invalid     bool
	lastAttempt time.Time
	lastUsed    time.Time
	job         *mediaCatalogJob
}

type mediaCatalogJob struct {
	done       chan struct{}
	ctx        context.Context
	cancel     context.CancelFunc
	generation uint64
	waiters    int
	background bool
	err        error
}

func mediaCatalogKey(root, slug string) string {
	// This is the same canonicalization used to bind the bridge to a library.
	return libraryFingerprint(root) + "\x00" + slug
}

func (f *Facade) mediaCatalogPath(key string) string {
	if f.a == nil || f.a.ConfigDir == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(key))
	return filepath.Join(f.a.ConfigDir, "media-catalog", hex.EncodeToString(sum[:])+".jsonl")
}

func readCatalogHeader(path, key string) (*mediaCatalogHeader, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	// The header holds four pages, not the full catalog.
	reader := bufio.NewReader(io.LimitReader(file, 16<<20))
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	var h mediaCatalogHeader
	if err := json.Unmarshal(line, &h); err != nil {
		return nil, err
	}
	if h.Schema != mediaCatalogSchema || h.Key != key || h.Version == "" || h.BuiltAt <= 0 || h.First == nil {
		return nil, errors.New("无效的媒体目录缓存")
	}
	for _, order := range []string{"newest", "oldest", "size-desc", "size-asc"} {
		if _, ok := h.First[order]; !ok || len(h.First[order]) > mediaPageSize {
			return nil, errors.New("无效的媒体目录首页")
		}
	}
	return &h, nil
}

// mediaEntryLocked reads only the local, small cache header. Caller holds mediaMu.
func (f *Facade) mediaEntryLocked(key string) *mediaCatalogEntry {
	if f.mediaCache == nil {
		f.mediaCache = map[string]*mediaCatalogEntry{}
	}
	e := f.mediaCache[key]
	if e == nil {
		for len(f.mediaCache) >= mediaCatalogMaxEntries {
			var oldestKey string
			var oldest time.Time
			for candidate, entry := range f.mediaCache {
				if entry.job == nil && (oldestKey == "" || entry.lastUsed.Before(oldest)) {
					oldestKey, oldest = candidate, entry.lastUsed
				}
			}
			if oldestKey == "" {
				break
			}
			delete(f.mediaCache, oldestKey)
		}
		e = &mediaCatalogEntry{}
		f.mediaCache[key] = e
	}
	e.lastUsed = time.Now()
	if !e.loaded {
		e.loaded = true
		if path := f.mediaCatalogPath(key); path != "" {
			if header, err := readCatalogHeader(path, key); err == nil {
				e.header = header
			}
		}
	}
	return e
}

// Full catalogs are much larger than headers. Limit retained snapshots even
// when a user visits many chats; evicted data remains recoverable locally.
func (f *Facade) trimMediaSnapshotsLocked(keep *mediaCatalogEntry) {
	for {
		count := 0
		var oldest *mediaCatalogEntry
		for _, entry := range f.mediaCache {
			if entry.snapshot == nil {
				continue
			}
			count++
			if entry != keep && (oldest == nil || entry.lastUsed.Before(oldest.lastUsed)) {
				oldest = entry
			}
		}
		if count <= mediaCatalogMaxLoaded || oldest == nil {
			return
		}
		oldest.snapshot = nil
	}
}

func catalogVersion(items []MediaItemDTO) string {
	h := sha256.New()
	_ = json.NewEncoder(h).Encode(items)
	return hex.EncodeToString(h.Sum(nil))
}

func catalogTimeKey(item MediaItemDTO) int64 {
	if id, err := strconv.ParseInt(item.ID, 10, 64); err == nil && id > 0 {
		return id
	}
	return item.ModTime
}

func catalogNewestLess(a, b MediaItemDTO) bool {
	at, bt := catalogTimeKey(a), catalogTimeKey(b)
	if at != bt {
		return at > bt
	}
	if a.Name != b.Name {
		return a.Name > b.Name
	}
	return a.Rel > b.Rel
}

func sortCatalogItems(items []MediaItemDTO, order string) {
	sort.Slice(items, func(i, j int) bool {
		a, b := items[i], items[j]
		switch order {
		case "oldest":
			return catalogNewestLess(b, a)
		case "size-desc":
			if a.Size != b.Size {
				return a.Size > b.Size
			}
		case "size-asc":
			if a.Size != b.Size {
				return a.Size < b.Size
			}
		}
		return catalogNewestLess(a, b)
	})
}

func (s *mediaCatalogSnapshot) ordered(order string) []MediaItemDTO {
	s.mu.Lock()
	defer s.mu.Unlock()
	if list, ok := s.orders[order]; ok {
		return list
	}
	list := append([]MediaItemDTO(nil), s.items...)
	sortCatalogItems(list, order)
	if s.orders == nil {
		s.orders = make(map[string][]MediaItemDTO)
	}
	s.orders[order] = list
	return list
}

func (s *mediaCatalogSnapshot) thumbnail(rel string) (int64, int64, bool) {
	item, ok := s.thumbnails[catalogRelKey(rel)]
	return item.size, item.modTime, ok
}

func indexCatalogThumbnails(items []MediaItemDTO) map[string]catalogFile {
	files := make(map[string]catalogFile)
	for _, item := range items {
		if item.Thumb != "" {
			files[catalogRelKey(item.Thumb)] = catalogFile{rel: item.Thumb, size: item.ThumbSize, modTime: item.ThumbModTime}
		}
		if item.Kind == "image" {
			files[catalogRelKey(item.Rel)] = catalogFile{rel: item.Rel, size: item.Size, modTime: item.ModTime}
		}
	}
	return files
}

func makeCatalogSnapshot(key string, items []MediaItemDTO, summary MediaSummary) (*mediaCatalogHeader, *mediaCatalogSnapshot) {
	if items == nil {
		items = []MediaItemDTO{}
	}
	sortCatalogItems(items, "newest")
	snapshot := &mediaCatalogSnapshot{items: items, orders: map[string][]MediaItemDTO{"newest": items}, thumbnails: indexCatalogThumbnails(items)}
	header := &mediaCatalogHeader{Schema: mediaCatalogSchema, Key: key, Version: catalogVersion(items), BuiltAt: time.Now().UnixMilli(), Summary: summary, First: map[string][]MediaItemDTO{}}
	for _, order := range []string{"newest", "oldest", "size-desc", "size-asc"} {
		list := snapshot.ordered(order)
		n := len(list)
		if n > mediaPageSize {
			n = mediaPageSize
		}
		header.First[order] = append([]MediaItemDTO{}, list[:n]...)
	}
	// The other full sorted copies are inexpensive to reconstruct when needed.
	snapshot.orders = map[string][]MediaItemDTO{"newest": items}
	return header, snapshot
}

// The temporary file is completed before publication; rename is serialized
// with invalidation so an older scan cannot repopulate a newer generation.
func (f *Facade) writeCatalogTemp(key string, header *mediaCatalogHeader, snapshot *mediaCatalogSnapshot) (string, error) {
	path := f.mediaCatalogPath(key)
	if path == "" {
		return "", nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".media-catalog-*.tmp")
	if err != nil {
		return "", err
	}
	name := file.Name()
	enc := json.NewEncoder(file)
	if err = enc.Encode(header); err == nil {
		err = enc.Encode(snapshot.items)
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(name)
		return "", err
	}
	return name, nil
}

func readCatalogSnapshot(path, key, version string) (*mediaCatalogSnapshot, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	var header mediaCatalogHeader
	if err := json.Unmarshal(line, &header); err != nil || header.Schema != mediaCatalogSchema || header.Key != key || header.Version != version {
		return nil, errors.New("媒体目录已更新")
	}
	var items []MediaItemDTO
	if err := json.NewDecoder(reader).Decode(&items); err != nil {
		return nil, err
	}
	if items == nil {
		items = []MediaItemDTO{}
	}
	if catalogVersion(items) != version {
		return nil, errors.New("媒体目录缓存损坏")
	}
	return &mediaCatalogSnapshot{items: items, orders: map[string][]MediaItemDTO{"newest": items}, thumbnails: indexCatalogThumbnails(items)}, nil
}

func (f *Facade) cachedWorkspaceMediaSummary(libraryRoot, slug string) (MediaSummary, bool) {
	if libraryRoot == "" || !validWorkspaceSlug(slug) {
		return MediaSummary{}, false
	}
	key := mediaCatalogKey(libraryRoot, slug)
	f.mediaMu.Lock()
	defer f.mediaMu.Unlock()
	e := f.mediaEntryLocked(key)
	if e.header == nil || e.invalid {
		return MediaSummary{}, false
	}
	return e.header.Summary, true
}

func (f *Facade) invalidateWorkspaceMedia(libraryRoot, slug string) {
	if libraryRoot == "" || !validWorkspaceSlug(slug) {
		return
	}
	key := mediaCatalogKey(libraryRoot, slug)
	f.mediaMu.Lock()
	e := f.mediaEntryLocked(key)
	e.generation++
	e.invalid = true
	e.header, e.snapshot = nil, nil
	e.lastAttempt = time.Time{}
	if e.job != nil {
		e.job.cancel()
		e.job = nil
	}
	if path := f.mediaCatalogPath(key); path != "" {
		_ = os.Remove(path)
	}
	f.mediaMu.Unlock()
}

func (f *Facade) startMediaCatalogJobLocked(key, root, slug string, e *mediaCatalogEntry, background bool) (*mediaCatalogJob, error) {
	if e.job != nil {
		select {
		case <-e.job.ctx.Done():
			e.job = nil
		default:
			return e.job, nil
		}
	}
	if f.mediaJobs >= mediaCatalogMaxJobs || (background && f.mediaJobs >= mediaCatalogParallel) {
		return nil, errors.New("媒体目录正在处理，请稍后重试")
	}
	if f.mediaSlots == nil {
		f.mediaSlots = make(chan struct{}, mediaCatalogParallel)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	job := &mediaCatalogJob{done: make(chan struct{}), ctx: ctx, cancel: cancel, generation: e.generation, background: background}
	e.job = job
	e.lastAttempt = time.Now()
	f.mediaJobs++
	go f.runMediaCatalogJob(ctx, key, root, slug, e, job)
	return job, nil
}

func (f *Facade) runMediaCatalogJob(ctx context.Context, key, root, slug string, e *mediaCatalogEntry, job *mediaCatalogJob) {
	var header *mediaCatalogHeader
	var snapshot *mediaCatalogSnapshot
	var temp string
	var err error
	select {
	case f.mediaSlots <- struct{}{}:
		items, summary, scanErr := scanWorkspaceCatalog(ctx, root, slug)
		if scanErr == nil {
			scanErr = ctx.Err()
		}
		if scanErr == nil {
			header, snapshot = makeCatalogSnapshot(key, items, summary)
			temp, scanErr = f.writeCatalogTemp(key, header, snapshot)
		}
		<-f.mediaSlots
		err = scanErr
	case <-ctx.Done():
		err = ctx.Err()
	}
	f.mediaMu.Lock()
	if err == nil {
		err = ctx.Err()
	}
	if err == nil && (e.generation != job.generation || e.job != job) {
		err = context.Canceled
	}
	if err == nil && temp != "" {
		err = os.Rename(temp, f.mediaCatalogPath(key))
		if err == nil {
			temp = ""
		}
	}
	if err == nil {
		e.header, e.snapshot, e.invalid = header, snapshot, false
		f.trimMediaSnapshotsLocked(e)
	}
	if e.job == job {
		e.job = nil
	}
	f.mediaJobs--
	job.err = err
	close(job.done)
	f.mediaMu.Unlock()
	job.cancel()
	if temp != "" {
		_ = os.Remove(temp)
	}
}

func (f *Facade) waitMediaCatalogJob(ctx context.Context, job *mediaCatalogJob) error {
	select {
	case <-job.done:
		f.mediaMu.Lock()
		job.waiters--
		err := job.err
		f.mediaMu.Unlock()
		return err
	case <-ctx.Done():
		f.mediaMu.Lock()
		job.waiters--
		if job.waiters == 0 && !job.background {
			job.cancel()
		}
		f.mediaMu.Unlock()
		return ctx.Err()
	}
}

func normalizeCatalogQuery(q *MediaQuery) error {
	if q.Page < 1 {
		q.Page = 1
	}
	switch q.Sort {
	case "newest", "oldest", "size-desc", "size-asc":
	default:
		q.Sort = "newest"
	}
	switch q.Kind {
	case "", "all":
		q.Kind = "all"
	case "media", "visual", "image", "video", "audio", "file":
	default:
		return errors.New("无效的媒体类别")
	}
	q.Query = strings.ToLower(strings.TrimSpace(q.Query))
	return nil
}

func mediaCatalogStale(e *mediaCatalogEntry) bool {
	return e.invalid || e.header == nil || time.Since(time.UnixMilli(e.header.BuiltAt)) >= mediaCatalogTTL
}

func (f *Facade) maybeRefreshCatalogLocked(key, root, slug string, e *mediaCatalogEntry) {
	if !mediaCatalogStale(e) || e.job != nil || (!e.lastAttempt.IsZero() && time.Since(e.lastAttempt) < mediaCatalogRetryDelay) {
		return
	}
	_, _ = f.startMediaCatalogJobLocked(key, root, slug, e, true)
}

func (f *Facade) queryMediaCatalog(ctx context.Context, root string, q MediaQuery) (MediaPageDTO, error) {
	if err := normalizeCatalogQuery(&q); err != nil {
		return MediaPageDTO{}, err
	}
	key := mediaCatalogKey(root, q.Slug)
	for {
		if err := ctx.Err(); err != nil {
			return MediaPageDTO{}, err
		}
		f.mediaMu.Lock()
		e := f.mediaEntryLocked(key)
		if q.Refresh || e.header == nil {
			job, err := f.startMediaCatalogJobLocked(key, root, q.Slug, e, false)
			if err != nil {
				f.mediaMu.Unlock()
				return MediaPageDTO{}, err
			}
			job.waiters++
			f.mediaMu.Unlock()
			if err := f.waitMediaCatalogJob(ctx, job); err != nil {
				return MediaPageDTO{}, err
			}
			q.Refresh = false
			continue
		}
		header, snapshot := e.header, e.snapshot
		stale := mediaCatalogStale(e)
		f.maybeRefreshCatalogLocked(key, root, q.Slug, e)
		if q.Version != "" && q.Version != header.Version {
			f.mediaMu.Unlock()
			return MediaPageDTO{Items: []MediaItemDTO{}, Total: header.Summary.Total, Page: q.Page, PageSize: mediaPageSize, Version: header.Version, Summary: header.Summary, Stale: true}, nil
		}
		if q.Page == 1 && q.Kind == "all" && q.Query == "" {
			list := append([]MediaItemDTO{}, header.First[q.Sort]...)
			f.mediaMu.Unlock()
			return MediaPageDTO{Items: list, Total: header.Summary.Total, Page: q.Page, PageSize: mediaPageSize, Version: header.Version, Summary: header.Summary, Stale: stale}, nil
		}
		if snapshot == nil {
			path, version := f.mediaCatalogPath(key), header.Version
			f.mediaMu.Unlock()
			loaded, err := readCatalogSnapshot(path, key, version)
			f.mediaMu.Lock()
			current := f.mediaEntryLocked(key)
			if current.header != header {
				f.mediaMu.Unlock()
				continue
			}
			if err == nil {
				if current.snapshot == nil {
					current.snapshot = loaded
					f.trimMediaSnapshotsLocked(current)
				}
				snapshot = current.snapshot
				f.mediaMu.Unlock()
			} else {
				job, startErr := f.startMediaCatalogJobLocked(key, root, q.Slug, current, false)
				if startErr != nil {
					f.mediaMu.Unlock()
					return MediaPageDTO{}, startErr
				}
				job.waiters++
				f.mediaMu.Unlock()
				if err := f.waitMediaCatalogJob(ctx, job); err != nil {
					return MediaPageDTO{}, err
				}
				continue
			}
		} else {
			f.mediaMu.Unlock()
		}
		page := filterCatalogPage(snapshot.ordered(q.Sort), q)
		page.Version, page.Summary, page.Stale = header.Version, header.Summary, stale
		return page, nil
	}
}

func filterCatalogPage(items []MediaItemDTO, q MediaQuery) MediaPageDTO {
	page := MediaPageDTO{Items: []MediaItemDTO{}, Page: q.Page, PageSize: mediaPageSize}
	start := int64(math.MaxInt64)
	if int64(q.Page)-1 <= math.MaxInt64/mediaPageSize {
		start = (int64(q.Page) - 1) * mediaPageSize
	}
	if q.Kind == "all" && q.Query == "" {
		page.Total = len(items)
		if start < int64(len(items)) {
			end := start + mediaPageSize
			if end > int64(len(items)) {
				end = int64(len(items))
			}
			page.Items = append(page.Items, items[int(start):int(end)]...)
		}
		return page
	}
	for _, item := range items {
		switch q.Kind {
		case "media":
			if item.Kind == "file" {
				continue
			}
		case "visual":
			if item.Kind != "image" && item.Kind != "video" {
				continue
			}
		case "all":
		default:
			if item.Kind != q.Kind {
				continue
			}
		}
		if q.Query != "" && !strings.Contains(strings.ToLower(item.Name), q.Query) && !strings.Contains(strings.ToLower(item.ID), q.Query) {
			continue
		}
		if int64(page.Total) >= start && len(page.Items) < mediaPageSize {
			page.Items = append(page.Items, item)
		}
		page.Total++
	}
	return page
}

// CachedMediaThumbnail returns only information from a previously checked
// snapshot. It never touches the library and never accepts another version.
func (f *Facade) CachedMediaThumbnail(libraryRoot, slug, rel, version string) (int64, int64, bool) {
	clean, ok := cleanWorkspaceFile(rel)
	if !ok || version == "" || libraryRoot == "" || !validWorkspaceSlug(slug) {
		return 0, 0, false
	}
	key := mediaCatalogKey(libraryRoot, slug)
	f.mediaMu.Lock()
	defer f.mediaMu.Unlock()
	e := f.mediaEntryLocked(key)
	if e.header == nil || e.invalid || e.header.Version != version {
		return 0, 0, false
	}
	find := func(items []MediaItemDTO) (int64, int64, bool) {
		for _, item := range items {
			if item.Thumb != "" && catalogRelKey(item.Thumb) == catalogRelKey(clean) {
				return item.ThumbSize, item.ThumbModTime, true
			}
			if item.Kind == "image" && catalogRelKey(item.Rel) == catalogRelKey(clean) {
				return item.Size, item.ModTime, true
			}
		}
		return 0, 0, false
	}
	if e.snapshot != nil {
		return e.snapshot.thumbnail(clean)
	}
	for _, items := range e.header.First {
		if size, mod, found := find(items); found {
			return size, mod, true
		}
	}
	return 0, 0, false
}
