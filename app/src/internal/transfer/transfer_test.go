package transfer

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestV9TransferIncrementalResume(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "a.bin"), []byte("12345"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(src, "nested"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "nested", "b.bin"), []byte("abcdef"), 0644); err != nil {
		t.Fatal(err)
	}
	// Pretend one file already completed on an earlier run.
	if err := os.WriteFile(filepath.Join(dst, "a.bin"), []byte("12345"), 0644); err != nil {
		t.Fatal(err)
	}
	res, err := DirIncremental(context.Background(), src, dst, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Skipped != 1 || res.Copied != 1 {
		t.Fatalf("want skipped=1 copied=1, got %#v", res)
	}
	b, err := os.ReadFile(filepath.Join(dst, "nested", "b.bin"))
	if err != nil || string(b) != "abcdef" {
		t.Fatalf("bad copied file: %q err=%v", b, err)
	}
}
