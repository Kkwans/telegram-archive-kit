package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

var ErrLibraryIdentity = errors.New("档案库身份不符")
var ErrLibraryReadOnly = errors.New("档案库不可写")

// ReadLibraryID checks only the marker. In particular it does not create a
// workspace when a remembered mount points to a different disk.
func ReadLibraryID(root string) (string, error) {
	if root == "" {
		return "", ErrLibraryIdentity
	}
	runtimeDir := filepath.Join(root, ".runtime")
	dir, err := os.Lstat(runtimeDir)
	if err != nil {
		return "", err
	}
	if dir.Mode().Type() != os.ModeDir {
		return "", ErrLibraryIdentity
	}
	path := filepath.Join(runtimeDir, "library-id")
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() != 32 {
		return "", ErrLibraryIdentity
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	actual, err := file.Stat()
	if err != nil {
		return "", err
	}
	dirNow, err := os.Lstat(runtimeDir)
	if err != nil {
		return "", err
	}
	if !os.SameFile(info, actual) || !os.SameFile(dir, dirNow) || dirNow.Mode().Type() != os.ModeDir {
		return "", ErrLibraryIdentity
	}
	data, err := io.ReadAll(io.LimitReader(file, 33))
	if err != nil {
		return "", err
	}
	id := string(data)
	if decoded, err := hex.DecodeString(id); err != nil || len(decoded) != 16 || id != strings.ToLower(id) {
		return "", ErrLibraryIdentity
	}
	return id, nil
}

func (f *Facade) RegisterCurrentLibrary() (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	root := f.a.Settings.LibraryRoot
	if root == "" || f.libLock == nil || f.remoteSuspended {
		return "", errors.New("请先打开可写的档案库")
	}
	if f.op != nil {
		return "", ErrOperationRunning
	}
	return registerLibraryIdentity(root, f.libLock)
}

func registerLibraryIdentity(root string, lock *sessionLock) (string, error) {
	id, err := ReadLibraryID(root)
	if err == nil {
		return id, lock.addIdentity(id)
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.MkdirAll(filepath.Join(root, ".runtime"), 0755); err != nil {
		return "", err
	}
	info, err := os.Lstat(filepath.Join(root, ".runtime"))
	if err != nil {
		return "", err
	}
	if info.Mode().Type() != os.ModeDir {
		return "", ErrLibraryIdentity
	}
	var key [16]byte
	if _, err = rand.Read(key[:]); err != nil {
		return "", err
	}
	id = hex.EncodeToString(key[:])
	if err = lock.addIdentity(id); err != nil {
		return "", err
	}
	target := filepath.Join(root, ".runtime", "library-id")
	file, err := os.CreateTemp(filepath.Join(root, ".runtime"), ".library-id-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(file.Name())
	_, err = file.WriteString(id)
	if err := errors.Join(err, file.Sync(), file.Close()); err != nil {
		return "", err
	}
	err = publishLibraryID(file.Name(), target)
	if os.IsExist(err) {
		return acquireRegisteredLibraryID(root, lock)
	}
	if err != nil {
		return "", err
	}
	return id, nil
}

func acquireRegisteredLibraryID(root string, lock *sessionLock) (string, error) {
	id, err := ReadLibraryID(root)
	if err == nil {
		err = lock.addIdentity(id)
	}
	return id, err
}

func (f *Facade) CurrentLibrarySelection() (string, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.a.Settings.LibraryRoot, f.a.Settings.ExpectedLibraryID
}

func (f *Facade) ActivePlanLibraryID() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.libLock == nil || f.remoteSuspended {
		return ""
	}
	return f.libLock.identity
}

func (f *Facade) ManagedRemoteUnavailable() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.a.Settings.ExpectedLibraryID != "" && (f.libLock == nil || f.remoteSuspended)
}

func (f *Facade) setLibraryIdentityLocked(id string) error {
	old := f.a.Settings.ExpectedLibraryID
	if old == id {
		return nil
	}
	f.a.Settings.ExpectedLibraryID = id
	if err := f.a.saveSettings(); err != nil {
		f.a.Settings.ExpectedLibraryID = old
		return err
	}
	return nil
}

func (f *Facade) SetCurrentLibraryIdentity(root, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !strings.EqualFold(filepath.Clean(f.a.Settings.LibraryRoot), filepath.Clean(root)) || f.libLock == nil || f.remoteSuspended {
		return ErrLibraryIdentity
	}
	if id != "" && id != f.libLock.identity {
		return ErrLibraryIdentity
	}
	return f.setLibraryIdentityLocked(id)
}

func (f *Facade) RestoreLibrary(ctx context.Context, root, expectedID, previousRoot, previousID string) error {
	if expectedID == "" {
		return ErrLibraryIdentity
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return f.switchLibrary(ctx, root, expectedID, previousRoot, previousID, false)
}

func (f *Facade) SuspendRemoteLibrary(root, id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if id == "" || id != f.a.Settings.ExpectedLibraryID || !strings.EqualFold(filepath.Clean(f.a.Settings.LibraryRoot), filepath.Clean(root)) {
		return
	}
	f.remoteSuspended = true
	if f.op != nil {
		f.op.cancel()
	}
}
