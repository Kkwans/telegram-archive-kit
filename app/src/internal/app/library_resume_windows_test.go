package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTryResumeRemoteLibraryClearsStaleSuspension(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".runtime"), 0755); err != nil {
		t.Fatal(err)
	}
	id := "00112233445566778899aabbccddeeff"
	if err := os.WriteFile(filepath.Join(root, ".runtime", "library-id"), []byte(id), 0644); err != nil {
		t.Fatal(err)
	}
	f := &Facade{
		a:       &App{Settings: Settings{LibraryRoot: root, ExpectedLibraryID: id}},
		libLock: &sessionLock{root: root, identity: id}, remoteSuspended: true,
	}
	if !f.ManagedRemoteUnavailable() {
		t.Fatal("expected suspended state")
	}
	if !f.RemoteLibraryReadable(root, id) {
		t.Fatal("expected readable library identity")
	}
	if !f.TryResumeRemoteLibrary() {
		t.Fatal("expected reachable remote library to resume")
	}
	if f.ManagedRemoteUnavailable() {
		t.Fatal("remote library remained suspended after a successful probe")
	}
}

func TestTryResumeRemoteLibraryRejectsMissingIdentity(t *testing.T) {
	root := t.TempDir()
	f := &Facade{
		a:       &App{Settings: Settings{LibraryRoot: root, ExpectedLibraryID: "00112233445566778899aabbccddeeff"}},
		libLock: &sessionLock{root: root}, remoteSuspended: true,
	}
	if f.TryResumeRemoteLibrary() {
		t.Fatal("must not resume without a readable library identity")
	}
}
