package webpublish

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/Microsoft/go-winio"
)

const WatchdogArg = "--web-publication-watchdog"
const retryDelay = 5 * time.Second

func failureMarker(dir string) string { return filepath.Join(dir, ".web-publication-retry-limit") }

// RunWatchdog survives a worker failure in the signed-in user's session. Each
// explicit deployment start has one fixed retry budget and a fresh run token.
func RunWatchdog(dir, token string) error {
	saved := readConfig(filepath.Join(dir, "web-publication.json"))
	if !saved.RestartOnFailure || !saved.Resume || !workerRequested(dir, token) {
		return nil
	}
	sid, err := processSID()
	if err != nil {
		return err
	}
	lock, err := winio.ListenPipe(pipeName(dir)+"-watchdog", &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;" + sid + ")"})
	if err != nil {
		return err
	}
	defer lock.Close()
	for attempt := 0; workerRequested(dir, token); attempt++ {
		current := readConfig(filepath.Join(dir, "web-publication.json"))
		if !current.Resume || !current.RestartOnFailure {
			return nil
		}
		cmd, err := workerCommand(WorkerArg, dir, token)
		if err == nil {
			err = cmd.Run()
		}
		if err == nil || !workerRequested(dir, token) {
			return nil
		}
		if attempt >= saved.RestartLimit {
			if err := os.WriteFile(failureMarker(dir), []byte(token), 0600); err != nil {
				return err
			}
			return fmt.Errorf("网页部署已达到 %d 次重启上限：%w", saved.RestartLimit, err)
		}
		if !waitForRetry(dir, token) {
			return nil
		}
	}
	return nil
}

func waitForRetry(dir, token string) bool {
	deadline := time.NewTimer(retryDelay)
	defer deadline.Stop()
	probe := time.NewTicker(200 * time.Millisecond)
	defer probe.Stop()
	for {
		select {
		case <-deadline.C:
			return workerRequested(dir, token)
		case <-probe.C:
			if !workerRequested(dir, token) {
				return false
			}
		}
	}
}

func stopWorkerRun(dir string) error {
	if err := os.Remove(workerMarker(dir)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
