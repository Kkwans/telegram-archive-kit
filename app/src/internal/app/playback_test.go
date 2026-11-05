package app

import (
	"os"
	"path/filepath"
	"testing"
)

func writeBoxes(t *testing.T, boxes ...string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "sample.mp4")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, box := range boxes {
		size := len(box) + 8
		if _, err := f.Write([]byte{byte(size >> 24), byte(size >> 16), byte(size >> 8), byte(size)}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.WriteString(box); err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte{0, 0, 0, 0}); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

func TestHasFaststart(t *testing.T) {
	if !hasFaststart(writeBoxes(t, "ftyp", "moov", "mdat")) {
		t.Fatal("moov before mdat should be faststart")
	}
	if hasFaststart(writeBoxes(t, "ftyp", "free", "mdat", "moov")) {
		t.Fatal("moov after mdat needs remux")
	}
}
