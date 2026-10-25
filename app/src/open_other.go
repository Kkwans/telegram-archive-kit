//go:build !windows

package main

import (
	"os/exec"
	"runtime"
)

func systemOpen(target string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", target).Start()
	}
	return exec.Command("xdg-open", target).Start()
}
