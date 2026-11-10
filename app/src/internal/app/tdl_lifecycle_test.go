package app

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestCleanupInterruptedMediaOnlyNewKnownPartials(t *testing.T) {
	a := &App{}
	a.Settings.LibraryRoot = t.TempDir()
	slug := "chat"
	media, files := a.mediaDir(slug), a.filesDir(slug)
	for _, dir := range []string{media, files} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path, data string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(data), 0644); err != nil {
			t.Fatal(err)
		}
	}
	existing := filepath.Join(media, "msg_1__existing.mp4")
	write(existing, "old")
	before := a.existingDownloadPaths(slug)
	partial := filepath.Join(media, "msg_1__new.mp4")
	complete := filepath.Join(media, "msg_2__complete.mp4")
	unknown := filepath.Join(media, "msg_3__unknown.mp4")
	otherDir := filepath.Join(files, "msg_4__archive.mp4")
	image := filepath.Join(media, "msg_5__resized.jpg")
	outOfPlan := filepath.Join(media, "msg_9__other.mp4")
	for _, path := range []string{partial, complete, unknown, otherDir, image, outOfPlan} {
		write(path, "abc")
	}
	plan := downloadPlan{IDs: map[string]int64{"1": 10, "2": 3, "3": 0, "4": 10, "5": 10}, Kinds: map[string]string{"5": "image"}}
	a.cleanupInterruptedMedia(slug, map[string]bool{"1": true, "2": true, "3": true, "4": true, "5": true, "9": true}, plan, before)
	if fileExists(partial) {
		t.Fatal("new, known-size partial should be removed")
	}
	for _, path := range []string{existing, complete, unknown, otherDir, image, outOfPlan} {
		if !fileExists(path) {
			t.Fatalf("unrelated or possibly complete file was removed: %s", path)
		}
	}
}

func TestDownloadAttemptProcessHelper(t *testing.T) {
	if os.Getenv("TAK_TEST_PROCESS_HELPER") != "1" {
		return
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
	os.Exit(0)
}

func TestStopDownloadAttemptIsBoundedAndReapsOwnedProcess(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestDownloadAttemptProcessHelper$")
	cmd.Env = append(os.Environ(), "TAK_TEST_PROCESS_HELPER=1")
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	result := make(chan error, 1)
	go func() { result <- cmd.Wait() }()
	started := time.Now()
	_, exited := stopDownloadAttempt(result, &trackedTdl{pid: cmd.Process.Pid}, 3*time.Second)
	if !exited || time.Since(started) > 4*time.Second {
		t.Fatalf("owned process did not stop within the bound: exited=%v elapsed=%v", exited, time.Since(started))
	}
}

func TestStopDownloadAttemptKeepsCompletedResult(t *testing.T) {
	result := make(chan error, 1)
	result <- nil
	if err, exited := stopDownloadAttempt(result, &trackedTdl{}, time.Second); !exited || err != nil {
		t.Fatalf("already completed process lost its result: exited=%v err=%v", exited, err)
	}
}
