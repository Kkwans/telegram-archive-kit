package media

import (
	"os/exec"
	"syscall"
)

// ffmpeg is always used headlessly; a GUI host must not flash a console.
func hideWindow(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return cmd
}
