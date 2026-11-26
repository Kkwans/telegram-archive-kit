package main

import (
	"context"
	"errors"
	"testing"

	takapp "telegramarchivekit/internal/app"
)

func TestBindSyncPlanDoesNotUseArchiveMutationLock(t *testing.T) {
	t.Setenv("TAK_CONFIG_DIR", t.TempDir())
	t.Setenv("TAK_LIBRARY_ROOT", t.TempDir())
	facade, err := takapp.OpenFacade()
	if err != nil {
		t.Fatal(err)
	}
	defer facade.Shutdown()
	bridge := NewBridge(facade)
	bridge.archiveMu.Lock()
	defer bridge.archiveMu.Unlock()
	_, err = bridge.bindSyncPlan(context.Background(), nil)
	if errors.Is(err, takapp.ErrOperationRunning) {
		t.Fatal("saving a plan must not be blocked by an unrelated archive task")
	}
}
