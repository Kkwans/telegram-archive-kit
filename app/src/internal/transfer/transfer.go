package transfer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"telegramarchivekit/internal/platform"
)

type transferFile struct {
	Src  string
	Dst  string
	Rel  string
	Size int64
	Mode fs.FileMode
	Mod  time.Time
}

type Progress struct {
	Stage        string
	FilesDone    int
	FilesTotal   int
	BytesDone    int64
	BytesTotal   int64
	SessionBytes int64
	Current      string
	Copied       int
	Skipped      int
	StartedAt    time.Time
	InstantMove  bool
}

type Result struct {
	Copied  int
	Skipped int
	Bytes   int64
}

// sameVolume is deliberately conservative. On Windows drive letters / UNC roots are
// stable enough for deciding whether os.Rename can be expected to be metadata-only.
func SameVolume(a, b string) bool {
	va := strings.TrimSpace(filepath.VolumeName(filepath.Clean(a)))
	vb := strings.TrimSpace(filepath.VolumeName(filepath.Clean(b)))
	if va == "" || vb == "" {
		return false
	}
	return strings.EqualFold(va, vb)
}

func scanTransfer(src, dst string, update func(Progress)) ([]transferFile, int, int64, error) {
	var files []transferFile
	totalBytes := int64(0)
	scanned := 0
	started := time.Now()
	last := time.Time{}
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		info, er := d.Info()
		if er != nil {
			return er
		}
		rel, er := filepath.Rel(src, path)
		if er != nil {
			return er
		}
		files = append(files, transferFile{Src: path, Dst: filepath.Join(dst, rel), Rel: rel, Size: info.Size(), Mode: info.Mode(), Mod: info.ModTime()})
		totalBytes += max(int64(0), info.Size())
		scanned++
		if update != nil && (last.IsZero() || time.Since(last) >= 140*time.Millisecond) {
			update(Progress{Stage: "正在扫描源目录", FilesDone: scanned, FilesTotal: scanned, BytesDone: totalBytes, BytesTotal: totalBytes, Current: rel, StartedAt: started})
			last = time.Now()
		}
		return nil
	})
	return files, scanned, totalBytes, err
}

func copyOneFile(ctx context.Context, f transferFile, copiedBytes *atomic.Int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(f.Dst), 0755); err != nil {
		return err
	}
	// Never expose a partially-copied destination under the final filename. This is
	// what makes cancellation / crash recovery safe and makes the next run resumable.
	tmp := f.Dst + ".tak-part"
	_ = os.Remove(tmp)
	in, err := os.Open(f.Src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, f.Mode.Perm())
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		_ = out.Close()
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	// A single sequential stream is intentionally used for archive migration. It
	// avoids seek thrashing and keeps Windows responsive while copying large media
	// between different disks. Download concurrency is a separate concern.
	buf := make([]byte, 4*1024*1024)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, rerr := in.Read(buf)
		if n > 0 {
			wn, werr := out.Write(buf[:n])
			if werr != nil {
				return werr
			}
			if wn != n {
				return io.ErrShortWrite
			}
			copiedBytes.Add(int64(n))
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return rerr
		}
	}
	if err := out.Sync(); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	_ = os.Chtimes(tmp, f.Mod, f.Mod)
	_ = os.Remove(f.Dst)
	if err := os.Rename(tmp, f.Dst); err != nil {
		return err
	}
	ok = true
	return nil
}

// DirIncremental performs an incremental, cancel-safe directory transfer.
// For moves on the same volume it first tries an O(1) rename. Across volumes it
// copies in background-I/O mode and deletes the source only after every file is safe.
func DirIncremental(ctx context.Context, src, dst string, move bool, update func(Progress)) (Result, error) {
	var result Result
	src = filepath.Clean(src)
	dst = filepath.Clean(dst)
	if src == dst {
		return result, nil
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return result, err
	}
	if move && SameVolume(src, dst) {
		if _, err := os.Stat(dst); os.IsNotExist(err) {
			if update != nil {
				update(Progress{Stage: "同一磁盘，正在快速移动目录", StartedAt: time.Now()})
			}
			if err := os.Rename(src, dst); err == nil {
				if update != nil {
					update(Progress{Stage: "完成", InstantMove: true, StartedAt: time.Now()})
				}
				return result, nil
			}
		}
	}

	started := time.Now()
	files, _, totalBytes, err := scanTransfer(src, dst, update)
	if err != nil {
		return result, err
	}
	// Cross-volume archive moves can be tens or hundreds of GB. Windows background
	// processing mode lowers CPU *and disk I/O* priority so the desktop/IME stays
	// responsive instead of letting a bulk copy monopolize storage latency.
	endBackground := platform.Background()
	defer endBackground()

	var copiedBytes atomic.Int64
	// Existing completed files count toward overall progress immediately.
	skippedBytes := int64(0)
	for _, f := range files {
		if di, er := os.Stat(f.Dst); er == nil && !di.IsDir() && di.Size() == f.Size && f.Size > 0 {
			skippedBytes += f.Size
		}
	}
	copiedBytes.Store(skippedBytes)
	lastNotify := time.Time{}
	for i, f := range files {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if di, er := os.Stat(f.Dst); er == nil && !di.IsDir() && di.Size() == f.Size && f.Size > 0 {
			result.Skipped++
			if update != nil && (lastNotify.IsZero() || time.Since(lastNotify) > 120*time.Millisecond) {
				update(Progress{Stage: "正在迁移文件", FilesDone: i + 1, FilesTotal: len(files), BytesDone: copiedBytes.Load(), BytesTotal: totalBytes, SessionBytes: copiedBytes.Load() - skippedBytes, Current: f.Rel, Copied: result.Copied, Skipped: result.Skipped, StartedAt: started})
				lastNotify = time.Now()
			}
			continue
		}
		before := copiedBytes.Load()
		doneCh := make(chan error, 1)
		go func(tf transferFile) { doneCh <- copyOneFile(ctx, tf, &copiedBytes) }(f)
		ticker := time.NewTicker(180 * time.Millisecond)
		copying := true
		for copying {
			select {
			case er := <-doneCh:
				ticker.Stop()
				if er != nil {
					return result, er
				}
				result.Copied++
				result.Bytes += copiedBytes.Load() - before
				copying = false
			case <-ticker.C:
				if update != nil {
					update(Progress{Stage: "正在迁移文件", FilesDone: i, FilesTotal: len(files), BytesDone: copiedBytes.Load(), BytesTotal: totalBytes, SessionBytes: copiedBytes.Load() - skippedBytes, Current: f.Rel, Copied: result.Copied, Skipped: result.Skipped, StartedAt: started})
				}
			case <-ctx.Done():
				ticker.Stop()
				<-doneCh
				return result, ctx.Err()
			}
		}
		if update != nil {
			update(Progress{Stage: "正在迁移文件", FilesDone: i + 1, FilesTotal: len(files), BytesDone: copiedBytes.Load(), BytesTotal: totalBytes, SessionBytes: copiedBytes.Load() - skippedBytes, Current: f.Rel, Copied: result.Copied, Skipped: result.Skipped, StartedAt: started})
		}
	}
	// Recreate empty directories after files, so the managed copy is structurally complete.
	_ = filepath.WalkDir(src, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || !d.IsDir() {
			return nil
		}
		rel, er := filepath.Rel(src, path)
		if er == nil {
			_ = os.MkdirAll(filepath.Join(dst, rel), 0755)
		}
		return nil
	})
	if move {
		if update != nil {
			update(Progress{Stage: "复制完成，正在清理源目录", FilesDone: len(files), FilesTotal: len(files), BytesDone: totalBytes, BytesTotal: totalBytes, SessionBytes: totalBytes - skippedBytes, Copied: result.Copied, Skipped: result.Skipped, StartedAt: started})
		}
		if err := os.RemoveAll(src); err != nil {
			return result, fmt.Errorf("文件已复制完成，但删除源目录失败（为安全起见源数据仍保留）: %w", err)
		}
	}
	if update != nil {
		update(Progress{Stage: "完成", FilesDone: len(files), FilesTotal: len(files), BytesDone: totalBytes, BytesTotal: totalBytes, SessionBytes: totalBytes - skippedBytes, Copied: result.Copied, Skipped: result.Skipped, StartedAt: started})
	}
	return result, nil
}

func CopyDirIncremental(src, dst string) (copied, skipped int, err error) {
	r, err := DirIncremental(context.Background(), src, dst, false, nil)
	return r.Copied, r.Skipped, err
}

func MoveDirSafe(src, dst string) error {
	_, err := DirIncremental(context.Background(), src, dst, true, nil)
	return err
}

func ETA(p Progress) time.Duration {
	if p.BytesDone <= 0 || p.BytesTotal <= p.BytesDone || p.StartedAt.IsZero() {
		return 0
	}
	elapsed := time.Since(p.StartedAt)
	if elapsed < 1200*time.Millisecond {
		return 0
	}
	session := p.SessionBytes
	if session <= 0 {
		return 0
	}
	speed := float64(session) / elapsed.Seconds()
	if speed <= 0 {
		return 0
	}
	return time.Duration(float64(p.BytesTotal-p.BytesDone)/speed) * time.Second
}

func Speed(p Progress) float64 {
	if p.SessionBytes <= 0 || p.StartedAt.IsZero() {
		return 0
	}
	elapsed := time.Since(p.StartedAt).Seconds()
	if elapsed <= 0 {
		return 0
	}
	return float64(p.SessionBytes) / elapsed
}

var ErrCancelled = errors.New("用户已取消文件迁移；已完成文件会保留，下次可继续")
