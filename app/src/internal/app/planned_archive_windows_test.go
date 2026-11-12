package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPlannedMessagesOnlyAndScopedMissingMedia(t *testing.T) {
	root, config := t.TempDir(), t.TempDir()
	f := &Facade{a: &App{
		ConfigDir: config, ConfigPath: filepath.Join(config, "config.json"),
		Settings: Settings{LibraryRoot: root},
	}}
	if err := f.AcquireLibraryLock(); err != nil {
		t.Fatal(err)
	}
	defer f.ReleaseLibraryLock()
	id, err := f.RegisterCurrentLibrary()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(config, "prepared.json")
	data := `{"name":"Test group","type":"private_group","id":99,"messages":[
{"id":11,"type":"message","text":"new","date":"2026-11-10T10:00:00","date_unixtime":"1794304800"},
{"id":12,"type":"message","photo":"photos/fixture.jpg","file_size":350,"date":"2026-11-10T10:01:00","date_unixtime":"1794304860"},
{"id":13,"type":"message","media_type":"video_file","file":"video_files/fixture.mp4","file_size":800,"date":"2026-11-10T10:02:00","date_unixtime":"1794304920"}]}`
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := f.RunPlannedArchive(context.Background(), id, "plan", "run", "Scheduled", "Test group", func(string) error { return nil },
		func(context.Context, func(string)) (PlannedArchiveInput, error) {
			return PlannedArchiveInput{Source: path, ChatID: "99", ChatType: "private_group", Added: 3}, nil
		}, func(PlannedArchiveResult) error { return nil })
	if err != nil || result.Slug == "" || len(result.Pending) != 0 {
		t.Fatalf("messages-only archive did not finish: %+v, %v", result, err)
	}
	_, last, err := f.PlanArchiveBaseline("99", "private_group")
	if err != nil || last != 13 {
		t.Fatalf("committed cursor source = %d, %v", last, err)
	}
	if _, err := os.Stat(filepath.Join(root, "chats", result.Slug, "messages.html")); err != nil {
		t.Fatal(err)
	}
	count, missing, err := f.a.generateMissingWithin(result.Slug, map[string]bool{"13": true})
	if err != nil || count != 1 {
		t.Fatalf("missing media scope = %d, %v", count, err)
	}
	filtered, err := loadDownloadPlan(missing)
	if err != nil || filtered.Images != 0 || filtered.Videos != 1 {
		t.Fatalf("selected types changed: %+v, %v", filtered, err)
	}
}

func TestRestoreRejectsReusedDriveBeforeCreatingLibrary(t *testing.T) {
	original, replacement, config := t.TempDir(), t.TempDir(), t.TempDir()
	f := &Facade{a: &App{ConfigDir: config, ConfigPath: filepath.Join(config, "config.json"), Settings: Settings{LibraryRoot: original}}}
	if err := f.AcquireLibraryLock(); err != nil {
		t.Fatal(err)
	}
	defer f.ReleaseLibraryLock()
	id, err := f.RegisterCurrentLibrary()
	if err != nil {
		t.Fatal(err)
	}
	if err := f.SetCurrentLibraryIdentity(original, id); err != nil {
		t.Fatal(err)
	}
	if err := f.RestoreLibrary(context.Background(), replacement, id, original, id); !errors.Is(err, ErrLibraryIdentity) {
		t.Fatalf("expected identity failure, got %v", err)
	}
	if entries, err := os.ReadDir(replacement); err != nil || len(entries) != 0 {
		t.Fatalf("reused target was modified: %v, %v", entries, err)
	}
	f.SuspendRemoteLibrary(original, id)
	if f.ActivePlanLibraryID() != "" {
		t.Fatal("offline library is eligible for a plan")
	}
	if err := f.RestoreLibrary(context.Background(), original, id, original, id); err != nil || f.ActivePlanLibraryID() != id {
		t.Fatalf("failed to recover verified library: %v", err)
	}
}
