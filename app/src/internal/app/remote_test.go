package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRemoteStatusKeepsOfflineMappedIdentity(t *testing.T) {
	f := &Facade{a: &App{
		Settings:  Settings{LastRemoteRoot: `X:\`, LastRemoteKind: "mapped"},
		ConfigDir: t.TempDir(),
	}}
	st := f.RemoteStatusFor(`X:\`)
	if !st.Remote || st.Kind != "mapped" {
		t.Fatalf("offline mapped library should stay remote: %+v", st)
	}
	if st.Reachable || st.Writable {
		t.Fatalf("missing drive should not be reachable/writable: %+v", st)
	}
}

func TestRemoteStatusDoesNotModifyLibrary(t *testing.T) {
	root := t.TempDir()
	marker := filepath.Join(root, ".tak-write-test")
	if err := os.WriteFile(marker, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	f := &Facade{a: &App{Settings: Settings{LibraryRoot: root, LastRemoteRoot: root}, ConfigDir: t.TempDir()}}
	if status := f.RemoteStatus(); !status.Reachable || !status.Remote || status.WritableKnown {
		t.Fatal("test library should be reachable and remote")
	}
	if status := f.RemoteStatusFor(root); !status.WritableKnown || !status.Writable {
		t.Fatal("explicit probe should confirm that the library is writable")
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "keep" {
		t.Fatal("status probe modified the library")
	}
	if entries, err := os.ReadDir(root); err != nil || len(entries) != 1 {
		t.Fatal("probe left a temporary file")
	}
}
