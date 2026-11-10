package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func writeBoundaryFixture(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{}`), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceBoundaryRejectsDeleteAndMediaTraversal(t *testing.T) {
	root := t.TempDir()
	sentinel := filepath.Join(root, "sentinel.txt")
	writeBoundaryFixture(t, sentinel)
	writeBoundaryFixture(t, filepath.Join(root, "chats", "chat-test", "workspace.json"))
	f := &Facade{a: &App{ConfigDir: t.TempDir()}}
	f.a.Settings.LibraryRoot = root
	if _, err := f.MediaFilePath("..", "sentinel.txt"); err == nil {
		t.Error("media lookup escaped the chats directory")
	}
	if err := f.DeleteChat(".."); err == nil {
		t.Error("delete accepted the library root as a workspace")
	}
	if _, err := os.Stat(sentinel); err != nil {
		t.Fatal("rejected delete must preserve the library")
	}
}

func TestWorkspaceBoundaryRejectsLinkedWorkspaceAndMedia(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	workspace := filepath.Join(root, "chats", "chat-test")
	writeBoundaryFixture(t, filepath.Join(workspace, "workspace.json"))
	writeBoundaryFixture(t, filepath.Join(outside, "outside.txt"))
	makeLink := func(link string) {
		t.Helper()
		if err := os.Symlink(outside, link); err != nil {
			if runtime.GOOS != "windows" {
				t.Skipf("creating test directory link: %v", err)
			}
			if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", link, outside).CombinedOutput(); err != nil {
				t.Fatalf("creating test junction: %v (%s)", err, output)
			}
		}
	}
	makeLink(filepath.Join(workspace, "linked"))
	makeLink(filepath.Join(root, "chats", "chat-linked"))
	f := &Facade{a: &App{ConfigDir: t.TempDir()}}
	f.a.Settings.LibraryRoot = root
	if _, err := f.MediaFilePath("chat-test", "linked/outside.txt"); err == nil {
		t.Error("media lookup escaped the workspace through a directory link")
	}
	if _, err := f.MediaFilePath("chat-linked", "outside.txt"); err == nil {
		t.Error("media lookup accepted a linked workspace outside the library")
	}
	if err := f.DeleteChat("chat-linked"); err == nil {
		t.Error("delete accepted a linked workspace outside the library")
	}
	if _, err := os.Stat(filepath.Join(outside, "outside.txt")); err != nil {
		t.Fatal("rejected delete must preserve the linked target")
	}
}

func TestWorkspaceBoundaryAcceptsExistingWorkspace(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "chats", "chat-valid")
	file := filepath.Join(workspace, "media", "clip..mp4")
	writeBoundaryFixture(t, filepath.Join(workspace, "workspace.json"))
	writeBoundaryFixture(t, file)
	f := &Facade{a: &App{ConfigDir: t.TempDir()}}
	f.a.Settings.LibraryRoot = root
	if got, err := f.MediaFilePath("chat-valid", `media\clip..mp4`); err != nil || got != file {
		t.Fatalf("valid media: %q, %v", got, err)
	}
	if err := f.DeleteChat("chat-valid"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(workspace); !os.IsNotExist(err) {
		t.Fatalf("workspace still exists: %v", err)
	}
}

func TestBackfillAndVerifyKeepDocumentsInPlace(t *testing.T) {
	root := t.TempDir()
	slug := "chat-documents"
	f := &Facade{a: &App{Settings: Settings{LibraryRoot: root}}}
	file := filepath.Join(f.a.mediaDir(slug), "9_4_bundle.zip")
	writeBoundaryFixture(t, f.a.workspaceMetaPath(slug))
	writeBoundaryFixture(t, file)
	writeBoundaryFixture(t, f.a.sourcePath(slug))
	if err := os.WriteFile(f.a.sourcePath(slug), []byte(`{"messages":[{"id":4,"type":"message","media_type":"document","file":"bundle.zip","file_size":2}]}`), 0644); err != nil {
		t.Fatal(err)
	}
	if preview, err := f.PreviewBackfill(slug); err != nil || preview.Missing != 0 {
		t.Fatalf("preview missing=%d, err=%v", preview.Missing, err)
	}
	if _, err := f.VerifyChat(slug); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatal("read-only operations moved a document")
	}
}
