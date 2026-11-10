package app

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"telegramarchivekit/internal/media"
	"telegramarchivekit/internal/platform"
)

func (a *App) ensureImageThumbnails(slug string, arc *Archive) {
	ctx := context.Background()
	plan := a.planThumbnails(ctx, slug, arc)
	_ = plan.generate(ctx, arc, media.FindFFmpeg(), nil)
}

type thumbTask struct {
	mi, xi int
	src    string
	dst    string
	rel    string
	name   string
	video  bool
	decode bool
}

type thumbResult struct {
	task thumbTask
	err  error
}

type thumbnailPlan struct {
	tasks       []thumbTask
	cached      int
	needsFFmpeg bool
}

// NAS directory listings supply file metadata in batches. Keep a snapshot for
// this build only, and fall back to Stat when a directory cannot be listed.
func thumbnailFileLookup() func(string) bool {
	directories := make(map[string]map[string]bool)
	return func(path string) bool {
		dir, name := filepath.Split(path)
		key := catalogRelKey(filepath.Clean(dir))
		files, cached := directories[key]
		if !cached {
			entries, err := os.ReadDir(dir)
			if err == nil || os.IsNotExist(err) {
				files = make(map[string]bool, len(entries))
				for _, entry := range entries {
					if entry.IsDir() {
						continue
					}
					if info, err := entry.Info(); err == nil && info.Mode().IsRegular() {
						files[catalogRelKey(entry.Name())] = info.Size() > 0
					}
				}
			}
			directories[key] = files
		}
		if files != nil {
			return files[catalogRelKey(name)]
		}
		info, err := os.Stat(path)
		return err == nil && info.Mode().IsRegular() && info.Size() > 0
	}
}

func (a *App) planThumbnails(ctx context.Context, slug string, arc *Archive) thumbnailPlan {
	var plan thumbnailPlan
	if arc == nil {
		return plan
	}
	workspace := a.workspaceDir(slug)
	exists := thumbnailFileLookup()
	for mi := range arc.Messages {
		for xi := range arc.Messages[mi].Media {
			if ctx.Err() != nil {
				return plan
			}
			x := &arc.Messages[mi].Media[xi]
			if x.Kind != "image" && x.Kind != "video" {
				continue
			}
			if x.Thumb != "" && exists(media.MediaLocalPath(workspace, x.Thumb)) {
				plan.cached++
				continue
			}
			x.Thumb = ""
			h := sha1.Sum([]byte(x.Path + fmt.Sprint(x.Size)))
			name := "thumb_" + sanitizeASCII(arc.Messages[mi].ID) + "_" + hex.EncodeToString(h[:])[:10] + ".jpg"
			rel := filepath.ToSlash(filepath.Join("thumbs", name))
			dst := filepath.Join(workspace, filepath.FromSlash(rel))
			if exists(dst) {
				x.Thumb = rel
				plan.cached++
				continue
			}
			src := media.MediaLocalPath(workspace, x.Path)
			if !exists(src) {
				continue
			}
			ext := strings.ToLower(filepath.Ext(x.Name))
			video := x.Kind == "video"
			decode := video || ext != ".jpg" && ext != ".jpeg" && ext != ".png" && ext != ".gif"
			plan.needsFFmpeg = plan.needsFFmpeg || decode
			plan.tasks = append(plan.tasks, thumbTask{mi: mi, xi: xi, src: src, dst: dst, rel: rel, name: x.Name, video: video, decode: decode})
		}
	}
	return plan
}

func (p thumbnailPlan) generate(ctx context.Context, arc *Archive, decoder string, progress func(done, total int, name string)) error {
	tasks := p.tasks
	if decoder == "" && p.needsFFmpeg {
		tasks = make([]thumbTask, 0, len(p.tasks))
		for _, task := range p.tasks {
			if !task.decode {
				tasks = append(tasks, task)
			}
		}
	}
	done := p.cached
	total := done + len(tasks)
	if progress != nil {
		progress(done, total, "")
	}
	if len(tasks) == 0 {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(tasks[0].dst), 0755); err != nil {
		return err
	}

	// Thumbnail generation is intentionally background-priority. It is enabled by
	// default in v9.5 because previews matter, but it should not make the desktop
	// feel frozen while decoding thousands of large photos.
	restorePriority := platform.Background()
	defer restorePriority()

	workers := runtime.NumCPU() / 4
	if workers < 2 {
		workers = 2
	}
	if workers > 4 {
		workers = 4
	}
	jobs := make(chan thumbTask)
	results := make(chan thumbResult, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for t := range jobs {
				var err error
				if t.video {
					err = media.CreateVideoThumbnail(ctx, decoder, t.src, t.dst)
				} else {
					err = media.CreateImageThumbnail(ctx, decoder, t.src, t.dst, media.ThumbMaxSide)
				}
				results <- thumbResult{task: t, err: err}
			}
		}()
	}
	go func() {
	schedule:
		for _, t := range tasks {
			select {
			case <-ctx.Done():
				break schedule
			case jobs <- t:
			}
		}
		close(jobs)
		wg.Wait()
		close(results)
	}()

	for r := range results {
		done++
		if r.err == nil {
			arc.Messages[r.task.mi].Media[r.task.xi].Thumb = r.task.rel
		}
		if progress != nil {
			progress(done, total, r.task.name)
		}
	}
	return ctx.Err()
}
