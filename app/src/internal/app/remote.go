package app

import (
	"crypto/sha1"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"time"

	"telegramarchivekit/internal/platform"
)

const remoteCacheLimitBytes int64 = 8 << 30

type RemoteStatusDTO struct {
	Root            string `json:"root"`
	Remote          bool   `json:"remote"`
	Kind            string `json:"kind"`
	Reachable       bool   `json:"reachable"`
	Writable        bool   `json:"writable"`
	WritableKnown   bool   `json:"writableKnown"`
	FreeBytes       uint64 `json:"freeBytes"`
	FreeKnown       bool   `json:"freeKnown"`
	LatencyMs       int64  `json:"latencyMs"`
	CacheBytes      int64  `json:"cacheBytes"`
	CacheLimitBytes int64  `json:"cacheLimitBytes"`
	CachePath       string `json:"cachePath,omitempty"`
	Error           string `json:"error,omitempty"`
}

// RemoteStatus checks reachability without writing to the current library.
func (f *Facade) RemoteStatus() RemoteStatusDTO {
	return f.remoteStatus(f.a.Settings.LibraryRoot, false)
}

// RemoteStatusFor is the explicit test in the connection dialog.
func (f *Facade) RemoteStatusFor(root string) RemoteStatusDTO {
	return f.remoteStatus(root, true)
}

func (f *Facade) remoteStatus(root string, testWrite bool) RemoteStatusDTO {
	remote, kind := platform.NetworkPathKind(root)
	if !remote && f.a.Settings.LastRemoteRoot != "" && strings.EqualFold(filepath.Clean(root), filepath.Clean(f.a.Settings.LastRemoteRoot)) {
		// A mapped drive can vanish from Windows after a network drop. Keep the
		// library classified as remote so the UI shows the offline banner.
		remote = true
		kind = f.a.Settings.LastRemoteKind
		if kind == "" {
			kind = "mapped"
		}
	}
	out := RemoteStatusDTO{
		Root: root, Remote: remote, Kind: kind,
		CacheLimitBytes: remoteCacheLimitBytes,
	}
	start := time.Now()
	st, err := os.Stat(root)
	out.LatencyMs = time.Since(start).Milliseconds()
	if err != nil || !st.IsDir() {
		out.Error = "目录不可访问"
		if err != nil {
			out.Error = err.Error()
		}
		return out
	}
	out.Reachable = true
	if testWrite {
		out.WritableKnown = true
		if err := platform.ProbeDirectoryWrite(root); err == nil {
			out.Writable = true
		} else {
			out.Error = "目录不可写：" + err.Error()
		}
	}
	out.FreeBytes = platform.FreeSpaceBytes(root)
	out.FreeKnown = out.FreeBytes > 0
	if remote {
		sum := sha1.Sum([]byte(strings.ToLower(filepath.Clean(root))))
		out.CachePath = filepath.Join(f.a.ConfigDir, "remote-cache", hex.EncodeToString(sum[:8]))
		out.CacheBytes = dirSize(out.CachePath)
	}
	return out
}

func (f *Facade) ClearRemoteCache() (int64, error) {
	root := f.a.Settings.LibraryRoot
	remote, _ := platform.NetworkPathKind(root)
	if !remote {
		return 0, os.ErrInvalid
	}
	sum := sha1.Sum([]byte(strings.ToLower(filepath.Clean(root))))
	dir := filepath.Join(f.a.ConfigDir, "remote-cache", hex.EncodeToString(sum[:8]))
	size := dirSize(dir)
	if err := os.RemoveAll(dir); err != nil {
		return 0, err
	}
	return size, nil
}

func dirSize(root string) int64 {
	var total int64
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}
