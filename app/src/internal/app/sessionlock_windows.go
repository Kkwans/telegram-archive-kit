package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// The desktop client owns a named mutex for the active library root while it
// runs. The console client checks the same mutex before writing, so two
// processes never rewrite chats/index/config at the same time. TAK_ALLOW_CONCURRENT
// is an escape hatch for recovery work.

type sessionFile struct {
	PID     int    `json:"pid"`
	Exe     string `json:"exe"`
	Version string `json:"version"`
	Started string `json:"started"`
}

type sessionLock struct {
	h    syscall.Handle
	root string

	stop            chan struct{}
	done            chan struct{}
	identityMu      sync.Mutex
	identity        string
	identityStop    chan struct{}
	identityDone    chan struct{}
	keepSessionFile bool
}

var heldLibraryLocks sync.Map // fingerprint -> *sessionLock

const waitAbandoned = 0x80

var (
	kernel32Proc     = syscall.NewLazyDLL("kernel32.dll")
	procCreateMutexW = kernel32Proc.NewProc("CreateMutexW")
	procReleaseMutex = kernel32Proc.NewProc("ReleaseMutex")
)

func libraryFingerprint(root string) string {
	clean := strings.ToLower(filepath.Clean(strings.TrimSpace(root)))
	sum := sha256.Sum256([]byte(clean))
	return hex.EncodeToString(sum[:8])
}

func libraryMutexName(root string) string {
	return `Local\TAK.Library.` + libraryFingerprint(root)
}

func identityMutexName(id string) string { return `Local\TAK.LibraryID.` + id }

func publishLibraryID(source, target string) error {
	from, err := syscall.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	to, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	return syscall.MoveFile(from, to)
}

func (l *sessionLock) addIdentity(id string) error {
	l.identityMu.Lock()
	defer l.identityMu.Unlock()
	if l.identity == id {
		return nil
	}
	handle, err := createNamedMutex(identityMutexName(id))
	if err != nil {
		return err
	}
	stop, done := make(chan struct{}), make(chan struct{})
	acquired := make(chan bool, 1)
	go func() {
		defer close(done)
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer syscall.CloseHandle(handle)
		state, err := syscall.WaitForSingleObject(handle, 0)
		ok := err == nil && (state == syscall.WAIT_OBJECT_0 || state == waitAbandoned)
		acquired <- ok
		if ok {
			<-stop
			_, _, _ = procReleaseMutex.Call(uintptr(handle))
		}
	}()
	if !<-acquired {
		return fmt.Errorf("档案库正由另一个进程使用")
	}
	if l.identityStop != nil {
		close(l.identityStop)
		<-l.identityDone
	}
	l.identity, l.identityStop, l.identityDone = id, stop, done
	return nil
}

func sessionFilePath(root string) string {
	return filepath.Join(root, ".runtime", "session.json")
}

func createNamedMutex(name string) (syscall.Handle, error) {
	name16, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	h, _, callErr := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name16)))
	if h == 0 {
		if callErr != syscall.Errno(0) {
			return 0, callErr
		}
		return 0, fmt.Errorf("CreateMutexW 失败")
	}
	return syscall.Handle(h), nil
}

func writeSessionFile(root string) {
	dir := filepath.Join(root, ".runtime")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return
	}
	exe, _ := os.Executable()
	data, err := json.MarshalIndent(sessionFile{
		PID:     os.Getpid(),
		Exe:     exe,
		Version: version,
		Started: time.Now().Format(time.RFC3339),
	}, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(sessionFilePath(root), data, 0644)
}

func readSessionFile(root string) (sessionFile, bool) {
	b, err := os.ReadFile(sessionFilePath(root))
	if err != nil {
		return sessionFile{}, false
	}
	var s sessionFile
	if json.Unmarshal(b, &s) != nil || s.PID <= 0 {
		return sessionFile{}, false
	}
	return s, true
}

func removeSessionFileIfOwner(root string) {
	s, ok := readSessionFile(root)
	if ok && s.PID != os.Getpid() {
		return
	}
	_ = os.Remove(sessionFilePath(root))
}

// acquireSessionLock takes ownership of the library mutex on a dedicated
// OS thread (mutex ownership is thread-affine) and keeps it held until release.
func acquireSessionLock(root string) (*sessionLock, error) {
	return acquireSessionLockAt(root, nil, "")
}

func acquireSessionLockAt(root string, previous *sessionLock, expectedID string) (*sessionLock, error) {
	if strings.TrimSpace(root) == "" {
		return nil, nil
	}
	h, err := createNamedMutex(libraryMutexName(root))
	if err != nil {
		return nil, err
	}
	l := &sessionLock{h: h, root: root, stop: make(chan struct{}), done: make(chan struct{})}
	if id, err := ReadLibraryID(root); err == nil && (previous == nil || previous.identity != id) {
		if err := l.addIdentity(id); err != nil {
			syscall.CloseHandle(h)
			return nil, err
		}
	}
	acquired := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		ev, waitErr := syscall.WaitForSingleObject(h, 0)
		if waitErr != nil || (ev != syscall.WAIT_OBJECT_0 && ev != waitAbandoned) {
			syscall.CloseHandle(h)
			acquired <- fmt.Errorf("档案库正由另一个进程使用")
			close(l.done)
			return
		}
		if expectedID != "" {
			if id, err := ReadLibraryID(root); err != nil || id != expectedID {
				_, _, _ = procReleaseMutex.Call(uintptr(h))
				syscall.CloseHandle(h)
				acquired <- ErrLibraryIdentity
				close(l.done)
				return
			}
		}
		heldLibraryLocks.Store(libraryFingerprint(root), l)
		writeSessionFile(root)
		acquired <- nil
		<-l.stop
		if !l.keepSessionFile {
			removeSessionFileIfOwner(root)
		}
		heldLibraryLocks.Delete(libraryFingerprint(root))
		_, _, _ = procReleaseMutex.Call(uintptr(h))
		syscall.CloseHandle(h)
		close(l.done)
	}()
	if err := <-acquired; err != nil {
		l.release()
		return nil, err
	}
	return l, nil
}

func (l *sessionLock) transferIdentityFrom(previous *sessionLock, id string) {
	if previous == nil || id == "" || previous.identity != id || l.identity == id {
		return
	}
	l.identity, l.identityStop, l.identityDone = previous.identity, previous.identityStop, previous.identityDone
	previous.identity, previous.identityStop, previous.identityDone = "", nil, nil
	previous.keepSessionFile = true
}

func (l *sessionLock) release() {
	if l == nil {
		return
	}
	l.identityMu.Lock()
	if l.identityStop != nil {
		close(l.identityStop)
		<-l.identityDone
		l.identityStop = nil
	}
	l.identityMu.Unlock()
	select {
	case <-l.stop:
	default:
		close(l.stop)
	}
	select {
	case <-l.done:
	case <-time.After(2 * time.Second):
	}
}

// libraryInUse reports whether another process currently owns the library.
// The calling process is never considered a conflict.
func libraryInUse(root string) (bool, sessionFile) {
	if strings.TrimSpace(root) == "" {
		return false, sessionFile{}
	}
	if _, ok := heldLibraryLocks.Load(libraryFingerprint(root)); ok {
		return false, sessionFile{}
	}
	name := libraryMutexName(root)
	if id, err := ReadLibraryID(root); err == nil {
		name = identityMutexName(id)
	}
	h, err := createNamedMutex(name)
	if err != nil {
		return false, sessionFile{}
	}
	runtime.LockOSThread()
	ev, waitErr := syscall.WaitForSingleObject(h, 0)
	owned := waitErr == nil && (ev == syscall.WAIT_OBJECT_0 || ev == waitAbandoned)
	if owned {
		_, _, _ = procReleaseMutex.Call(uintptr(h))
		runtime.UnlockOSThread()
		syscall.CloseHandle(h)
		return false, sessionFile{}
	}
	runtime.UnlockOSThread()
	syscall.CloseHandle(h)
	if waitErr != nil {
		return false, sessionFile{}
	}
	info, _ := readSessionFile(root)
	if info.PID == os.Getpid() {
		return false, info
	}
	return true, info
}

func (a *App) guardWritable() error {
	if expected := a.Settings.ExpectedLibraryID; expected != "" {
		if id, err := ReadLibraryID(a.Settings.LibraryRoot); err != nil || id != expected {
			return ErrLibraryIdentity
		}
	}
	if os.Getenv("TAK_ALLOW_CONCURRENT") == "1" {
		return nil
	}
	root := strings.TrimSpace(a.Settings.LibraryRoot)
	if root == "" {
		return nil
	}
	busy, info := libraryInUse(root)
	if !busy {
		return nil
	}
	if info.PID > 0 {
		return fmt.Errorf("档案库正由桌面客户端使用（PID %d）；请先关闭桌面客户端，或设置 TAK_ALLOW_CONCURRENT=1 强制继续", info.PID)
	}
	return fmt.Errorf("档案库正由另一个 TelegramArchiveKit 进程使用；请先关闭它，或设置 TAK_ALLOW_CONCURRENT=1 强制继续")
}
