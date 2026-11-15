//go:build !windows

package platform

import "syscall"

func diskSpace(path string) (free, total int64) {
	var st syscall.Statfs_t
	if syscall.Statfs(path, &st) != nil {
		return 0, 0
	}
	return int64(st.Bavail * uint64(st.Bsize)), int64(st.Blocks * uint64(st.Bsize))
}
