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
	a.ensureImageThumbnailsProgress(slug, arc, nil)
}

type thumbTask struct {
	mi, xi int
	src    string
	dst    string
	rel    string
	name   string
	kind   string
}

type thumbResult struct {
	task thumbTask
	err  error
}

func (a *App) ensureImageThumbnailsProgress(slug string, arc *Archive, progress func(done, total int, name string)) {
	a.ensureImageThumbnailsProgressCtx(context.Background(), slug, arc, progress)
}
func (a *App) ensureImageThumbnailsProgressCtx(ctx context.Context, slug string, arc *Archive, progress func(done, total int, name string)) {
	if arc == nil {
		return
	}
	thumbDir := filepath.Join(a.workspaceDir(slug), "thumbs")
	_ = os.MkdirAll(thumbDir, 0755)

	decoder := media.FindFFmpeg()
	var tasks []thumbTask
	done := 0
	for mi := range arc.Messages {
		for xi := range arc.Messages[mi].Media {
			x := &arc.Messages[mi].Media[xi]
			if x.Kind != "image" && x.Kind != "video" {
				continue
			}
			ext := strings.ToLower(filepath.Ext(x.Name))
			if x.Kind == "image" && ext != ".jpg" && ext != ".jpeg" && ext != ".png" && ext != ".gif" && decoder == "" {
				continue
			}
			if x.Kind == "video" && decoder == "" {
				continue
			}
			src := media.MediaLocalPath(a.workspaceDir(slug), x.Path)
			if !fileExists(src) {
				continue
			}
			h := sha1.Sum([]byte(x.Path + fmt.Sprint(x.Size)))
			name := "thumb_" + sanitizeASCII(arc.Messages[mi].ID) + "_" + hex.EncodeToString(h[:])[:10] + ".jpg"
			dst := filepath.Join(thumbDir, name)
			rel := filepath.ToSlash(filepath.Join("thumbs", name))
			if fileExists(dst) {
				x.Thumb = rel
				done++
				continue
			}
			tasks = append(tasks, thumbTask{mi: mi, xi: xi, src: src, dst: dst, rel: rel, name: x.Name, kind: x.Kind})
		}
	}
	total := done + len(tasks)
	if progress != nil {
		progress(done, total, "")
	}
	if len(tasks) == 0 {
		return
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
				if t.kind == "video" {
					err = media.CreateVideoThumbnail(t.src, t.dst)
				} else {
					err = media.CreateImageThumbnail(t.src, t.dst, media.ThumbMaxSide)
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
}
