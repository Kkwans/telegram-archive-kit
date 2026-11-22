package main

import (
	"os/exec"

	"golang.org/x/sys/windows"
)

// A private job releases a download child and its database lock if this
// desktop process exits unexpectedly. It never contains user-started tdl jobs.
func startManagedTdlProcess(cmd *exec.Cmd) (func(), error) {
	job, err := startManagedChildProcess(cmd)
	if err != nil {
		return nil, err
	}
	return func() { _ = windows.CloseHandle(job) }, nil
}
