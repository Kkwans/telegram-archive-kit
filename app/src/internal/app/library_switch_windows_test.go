package app

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestSwitchLibraryKeepsPreviousLibraryOnFailure(t *testing.T) {
	for _, point := range []string{"index", "config"} {
		t.Run(point, func(t *testing.T) {
			old, next, cfg := t.TempDir(), t.TempDir(), t.TempDir()
			f := &Facade{a: &App{ConfigDir: cfg, ConfigPath: filepath.Join(cfg, "config.json"), Settings: defaultSettings()}}
			f.a.Settings.LibraryRoot = old
			if err := f.AcquireLibraryLock(); err != nil {
				t.Fatal(err)
			}
			defer f.ReleaseLibraryLock()
			if err := f.a.saveSettings(); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(f.a.ConfigPath)
			if err != nil {
				t.Fatal(err)
			}
			block := filepath.Join(next, "library-data.js")
			if point == "config" {
				block = f.a.ConfigPath + ".tmp"
			}
			if err := os.Mkdir(block, 0755); err != nil {
				t.Fatal(err)
			}
			if err := f.SwitchLibrary(next); err == nil {
				t.Fatal("expected switch failure")
			}
			after, err := os.ReadFile(f.a.ConfigPath)
			if err != nil || !bytes.Equal(before, after) || f.a.Settings.LibraryRoot != old || f.libLock.root != old {
				t.Fatal("failed switch changed the active library, configuration or lock")
			}
			if _, held := heldLibraryLocks.Load(libraryFingerprint(next)); held {
				t.Fatal("failed switch left the candidate locked")
			}
		})
	}
}

func TestSwitchLibraryRejectsActiveTasksAndCommitsSuccessfulSwitch(t *testing.T) {
	old, next, cfg := t.TempDir(), t.TempDir(), t.TempDir()
	f := &Facade{a: &App{ConfigDir: cfg, ConfigPath: filepath.Join(cfg, "config.json"), Settings: defaultSettings()}}
	f.a.Settings.LibraryRoot = old
	if err := f.AcquireLibraryLock(); err != nil {
		t.Fatal(err)
	}
	defer f.ReleaseLibraryLock()
	task := f.createTask("import-json", "test", "")
	if err := f.SwitchLibrary(next); err != ErrOperationRunning {
		t.Fatalf("switch with active write task: %v", err)
	}
	task.finish(nil)
	if err := f.SwitchLibrary(next); err != nil {
		t.Fatal(err)
	}
	if f.a.Settings.LibraryRoot != next || f.libLock.root != next {
		t.Fatal("successful switch did not publish the new root and lock together")
	}
	if _, held := heldLibraryLocks.Load(libraryFingerprint(old)); held {
		t.Fatal("successful switch left the previous library locked")
	}
	loaded := &App{ConfigPath: f.a.ConfigPath}
	if err := loaded.loadSettings(); err != nil || loaded.Settings.LibraryRoot != next {
		t.Fatalf("successful switch did not persist the new root: %v", err)
	}
}
