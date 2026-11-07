package media

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func tkhdPayload(width, height int, rotate bool) []byte {
	payload := make([]byte, 44)
	matrix := payload[0:36]
	if rotate {
		binary.BigEndian.PutUint32(matrix[4:8], 1<<16)
		binary.BigEndian.PutUint32(matrix[12:16], 0xFFFF0000)
	} else {
		binary.BigEndian.PutUint32(matrix[0:4], 1<<16)
		binary.BigEndian.PutUint32(matrix[16:20], 1<<16)
	}
	binary.BigEndian.PutUint32(payload[36:40], uint32(width)<<16)
	binary.BigEndian.PutUint32(payload[40:44], uint32(height)<<16)
	return payload
}

func TestParseTkhdDimensions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "track.bin")
	payload := tkhdPayload(720, 1280, false)
	if err := os.WriteFile(path, payload, 0644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	width, height, ok := parseTkhd(f, 0, int64(len(payload)))
	if !ok || width != 720 || height != 1280 {
		t.Fatalf("dimensions = %dx%d ok=%v", width, height, ok)
	}
}

func TestParseTkhdRotatedDimensions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "track.bin")
	payload := tkhdPayload(1920, 1080, true)
	if err := os.WriteFile(path, payload, 0644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	width, height, ok := parseTkhd(f, 0, int64(len(payload)))
	if !ok || width != 1080 || height != 1920 {
		t.Fatalf("rotated dimensions = %dx%d ok=%v", width, height, ok)
	}
}
