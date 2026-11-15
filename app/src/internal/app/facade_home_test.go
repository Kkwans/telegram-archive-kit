package app

import (
	"testing"

	"telegramarchivekit/internal/platform"
)

func TestHomeStorageUsesLibraryVolumeOverride(t *testing.T) {
	root := t.TempDir()
	f := &Facade{a: &App{Settings: Settings{LibraryRoot: root}}}
	platform.SetSpaceOverride(root, 6400, 7200)
	t.Cleanup(func() { platform.ClearSpaceOverride(root) })
	got := f.HomeStorage()
	if got.DiskFree != 6400 || got.DiskTotal != 7200 {
		t.Fatalf("home storage = %+v, want the library volume capacity", got)
	}
}
