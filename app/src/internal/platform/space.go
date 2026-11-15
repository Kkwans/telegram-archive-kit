package platform

import (
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

type spaceOverride struct {
	prefix string
	free   int64
	total  int64
}

var (
	spaceMu        sync.RWMutex
	spaceOverrides []spaceOverride
)

// SetSpaceOverride lets the desktop shell report the capacity of a remote
// volume instead of the drive root exposed by the mount. The longest matching
// prefix wins, so a mount root override can be refined for a library folder.
func SetSpaceOverride(path string, free, total int64) {
	prefix := normalizeSpacePath(path)
	if prefix == "" || total <= 0 {
		return
	}
	spaceMu.Lock()
	defer spaceMu.Unlock()
	for i := range spaceOverrides {
		if spaceOverrides[i].prefix == prefix {
			spaceOverrides[i].free, spaceOverrides[i].total = free, total
			return
		}
	}
	spaceOverrides = append(spaceOverrides, spaceOverride{prefix: prefix, free: free, total: total})
}

func ClearSpaceOverride(path string) {
	prefix := normalizeSpacePath(path)
	spaceMu.Lock()
	defer spaceMu.Unlock()
	spaceOverrides = slicesDeleteFunc(spaceOverrides, func(v spaceOverride) bool { return v.prefix == prefix })
}

// Space returns the available and total bytes for a path. Remote mounts that
// expose several NAS volumes register a per-library override so downloads are
// checked against the actual archive volume, not the mount's aggregate root.
func Space(path string) (free, total int64) {
	if free, total, ok := spaceOverrideFor(path); ok {
		return free, total
	}
	return diskSpace(path)
}

func FreeSpaceBytes(path string) uint64 {
	free, _ := Space(path)
	if free <= 0 {
		return 0
	}
	return uint64(free)
}

func spaceOverrideFor(path string) (int64, int64, bool) {
	clean := normalizeSpacePath(path)
	spaceMu.RLock()
	defer spaceMu.RUnlock()
	var best *spaceOverride
	for i := range spaceOverrides {
		item := &spaceOverrides[i]
		if pathWithinSpace(clean, item.prefix) && (best == nil || len(item.prefix) > len(best.prefix)) {
			best = item
		}
	}
	if best == nil {
		return 0, 0, false
	}
	return best.free, best.total, true
}

func normalizeSpacePath(path string) string {
	clean := filepath.Clean(strings.TrimSpace(path))
	if clean == "." || clean == "" {
		return ""
	}
	return strings.ToLower(strings.TrimRight(clean, `\/`))
}

func pathWithinSpace(path, prefix string) bool {
	if path == prefix {
		return true
	}
	if strings.HasSuffix(prefix, ":") {
		return strings.HasPrefix(path, prefix)
	}
	return strings.HasPrefix(path, prefix+string(filepath.Separator))
}

func slicesDeleteFunc(items []spaceOverride, remove func(spaceOverride) bool) []spaceOverride {
	out := items[:0]
	for _, item := range items {
		if !remove(item) {
			out = append(out, item)
		}
	}
	sort.Slice(out, func(i, j int) bool { return len(out[i].prefix) < len(out[j].prefix) })
	return out
}
