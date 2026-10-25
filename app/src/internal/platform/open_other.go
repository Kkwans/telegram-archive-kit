//go:build !windows

package platform

import (
	"os/exec"
	"runtime"
)

func Open(target string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", target).Start()
	}
	return exec.Command("xdg-open", target).Start()
}
