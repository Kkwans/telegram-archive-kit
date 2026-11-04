package app

import "testing"

func TestSessionLockIsExclusiveAndReleases(t *testing.T) {
	dir := t.TempDir()
	first, err := acquireSessionLock(dir)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	if busy, _ := libraryInUse(dir); busy {
		t.Fatal("the owning process must not see its own lock as a conflict")
	}
	if err := (&App{Settings: Settings{LibraryRoot: dir}}).guardWritable(); err != nil {
		t.Fatalf("guard must allow the lock owner: %v", err)
	}
	second, err := acquireSessionLock(dir)
	if err == nil {
		second.release()
		t.Fatal("a second process-level owner must be rejected")
	}
	first.release()
	third, err := acquireSessionLock(dir)
	if err != nil {
		t.Fatalf("lock was not released: %v", err)
	}
	third.release()
}
