package app

import (
	"os/exec"
	"syscall"
)

const createNoWindow = 0x08000000

// hideWindow keeps console helpers (tdl checks, taskkill) from flashing a
// console window when the desktop GUI runs them. Interactive tdl login does
// not use this path.
func hideWindow(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}
