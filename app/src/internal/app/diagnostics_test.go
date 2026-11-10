package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiagnosticsReadsOnlyLogTailAndListsEmptyLogs(t *testing.T) {
	root := t.TempDir()
	f := &Facade{a: &App{Settings: Settings{LibraryRoot: root}}}
	if logs := f.ListLogs(); logs == nil || len(logs) != 0 {
		t.Fatalf("missing log directory must produce an empty list: %#v", logs)
	}
	dir := filepath.Join(root, ".logs")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if logs := f.ListLogs(); logs == nil || len(logs) != 0 {
		t.Fatalf("empty log directory must produce an empty list: %#v", logs)
	}
	path := filepath.Join(dir, "run.log")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	const tail = "\nverified end\n"
	if _, err := file.WriteAt([]byte(tail), 8<<20); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	contents, err := f.ReadLog("run.log")
	if err != nil || len(contents) != 256<<10 || !strings.HasSuffix(contents, tail) {
		t.Fatalf("wrong bounded log tail: %d bytes, %v", len(contents), err)
	}
	if _, err := f.ReadLog("../run.log"); err == nil {
		t.Fatal("log path escaped the current library")
	}
}
