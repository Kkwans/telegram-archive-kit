package app

import (
	"path/filepath"
	"testing"
)

func TestForgetLibraryHistoryRemovesOnlyMatchingEntry(t *testing.T) {
	dir := t.TempDir()
	f := &Facade{a: &App{ConfigDir: dir, ConfigPath: filepath.Join(dir, "config.json"), Settings: defaultSettings()}}
	f.a.Settings.LibraryHistory = []string{"/library/a", "/library/b"}
	got, err := f.ForgetLibraryHistory("/library/a")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "/library/b" {
		t.Fatalf("history = %v, want the remaining entry", got)
	}
}

func TestRemoteStatusWithoutLibraryIsNeutral(t *testing.T) {
	f := &Facade{a: &App{Settings: defaultSettings()}}
	got := f.RemoteStatus()
	if got.Root != "" || got.Error != "" {
		t.Fatalf("empty library status = %+v, want no error", got)
	}
}

func TestRemoteStatusDoesNotExposeRawStatText(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing-library")
	f := &Facade{a: &App{Settings: Settings{LibraryRoot: missing}}}
	got := f.RemoteStatus()
	if got.Error == "" || got.Error == "Stat: The system cannot find the path specified." {
		t.Fatalf("unexpected remote status error: %q", got.Error)
	}
}
