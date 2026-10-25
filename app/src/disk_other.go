//go:build !windows

package main

import "syscall"

func freeSpaceBytes(path string) uint64 {
	var st syscall.Statfs_t
	if syscall.Statfs(path, &st) != nil {
		return 0
	}
	return st.Bavail * uint64(st.Bsize)
}
