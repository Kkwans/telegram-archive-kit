package webpublish

import (
	"path/filepath"
	"testing"
)

func TestOldConfigDefaultsToStoppingOnExit(t *testing.T) {
	file := filepath.Join(t.TempDir(), "web-publication.json")
	fixtureFile(t, file, []byte(`{"port":8780,"auto":true,"resume":true}`))
	config := readConfig(file)
	if !config.Auto || !config.Resume || config.KeepOnExit || config.RestartOnFailure || config.RestartLimit != 3 {
		t.Fatalf("unexpected migration defaults: %+v", config)
	}
}

func TestNewLaunchRevokesPreviousRecovery(t *testing.T) {
	dir := t.TempDir()
	first, err := startWorkerRun(dir)
	if err != nil || !workerRequested(dir, first) {
		t.Fatalf("first run failed: %v", err)
	}
	if err := stopWorkerRun(dir); err != nil || workerRequested(dir, first) {
		t.Fatalf("stopped worker remained authorized: %v", err)
	}
	second, err := startWorkerRun(dir)
	if err != nil || !workerRequested(dir, second) || workerRequested(dir, first) {
		t.Fatalf("new run did not replace the previous run: %v", err)
	}
}
