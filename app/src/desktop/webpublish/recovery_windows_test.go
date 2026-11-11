package webpublish

import (
	"path/filepath"
	"testing"
)

func TestOldConfigDefaultsToStoppingOnExit(t *testing.T) {
	file := filepath.Join(t.TempDir(), "web-publication.json")
	fixtureFile(t, file, []byte(`{"port":8780,"auto":true,"resume":true}`))
	config := readConfig(file)
	if !config.Auto || !config.Resume || config.KeepOnExit || config.RestartOnFailure || config.RestartLimit != 3 || config.Scope.All {
		t.Fatalf("unexpected migration defaults: %+v", config)
	}
}

func TestDefaultScopeDoesNotReplaceSavedChatSelection(t *testing.T) {
	file := filepath.Join(t.TempDir(), "web-publication.json")
	if cfg := readConfig(file); !cfg.Scope.All || cfg.Resume {
		t.Fatalf("new deployments should select the entire library and stay stopped: %+v", cfg)
	}
	fixtureFile(t, file, []byte(`{"port":8780,"library":"original-library","scope":{"all":false,"chats":[{"slug":"existing-chat","id":"42"}]}}`))
	if cfg := readConfig(file); cfg.Scope.All || len(cfg.Scope.Chats) != 1 || cfg.Scope.Chats[0].Slug != "existing-chat" {
		t.Fatalf("saved chat selection was replaced: %+v", cfg.Scope)
	}
	m := NewManager(filepath.Dir(file), func() string { return "another-library" }, nil, nil)
	defer m.Close()
	if status := m.Status(false); !status.Config.Scope.All || status.Requested {
		t.Fatalf("a different library should use the default scope without starting: %+v", status)
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
