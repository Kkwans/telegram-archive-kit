package app

import (
	"bytes"
	"image"
	imagecolor "image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestNormalizeAvatarColor(t *testing.T) {
	got, err := normalizeAvatarColor(" #2f6bff ")
	if err != nil || got != "#2F6BFF" {
		t.Fatalf("normalizeAvatarColor() = %q, %v", got, err)
	}
	if got, err := normalizeAvatarColor(""); err != nil || got != "" {
		t.Fatalf("empty color should reset: %q, %v", got, err)
	}
	for _, value := range []string{"red", "#123", "#GG0000", "#12345678"} {
		if _, err := normalizeAvatarColor(value); err == nil {
			t.Fatalf("normalizeAvatarColor(%q) should fail", value)
		}
	}
}

func TestNormalizeAvatarFontSettings(t *testing.T) {
	family, err := normalizeAvatarFontFamily(" Microsoft YaHei ")
	if err != nil || family != "Microsoft YaHei" {
		t.Fatalf("font family = %q, %v", family, err)
	}
	if _, err := normalizeAvatarFontFamily("Not A Real Font"); err == nil {
		t.Fatal("unsupported font family should fail")
	}
	for _, size := range []int{0, 14, 24, 34} {
		if _, err := normalizeAvatarFontSize(size); err != nil {
			t.Fatalf("font size %d: %v", size, err)
		}
	}
	for _, size := range []int{-1, 13, 35} {
		if _, err := normalizeAvatarFontSize(size); err == nil {
			t.Fatalf("font size %d should fail", size)
		}
	}
	for _, weight := range []int{0, 400, 600, 700, 900} {
		if _, err := normalizeAvatarFontWeight(weight); err != nil {
			t.Fatalf("font weight %d: %v", weight, err)
		}
	}
	for _, weight := range []int{-1, 450, 1000} {
		if _, err := normalizeAvatarFontWeight(weight); err == nil {
			t.Fatalf("font weight %d should fail", weight)
		}
	}
}

func TestEncodeChatAvatarNormalizesPNGToJPEG(t *testing.T) {
	source := image.NewRGBA(image.Rect(0, 0, 40, 20))
	source.Set(10, 10, imagecolor.RGBA{R: 40, G: 90, B: 255, A: 255})
	var input bytes.Buffer
	if err := png.Encode(&input, source); err != nil {
		t.Fatal(err)
	}
	got, err := encodeChatAvatar(bytes.NewReader(input.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) < 2 || got[0] != 0xff || got[1] != 0xd8 {
		t.Fatalf("expected JPEG output, got %x", got[:min(2, len(got))])
	}
	decoded, err := jpeg.Decode(bytes.NewReader(got))
	if err != nil {
		t.Fatal(err)
	}
	if bounds := decoded.Bounds(); bounds.Dx() != 40 || bounds.Dy() != 20 {
		t.Fatalf("unexpected dimensions: %v", bounds)
	}
}

func TestEncodeChatAvatarRejectsNonImageAndOversizedDimensions(t *testing.T) {
	if _, err := encodeChatAvatar(bytes.NewBufferString("not an image")); err == nil {
		t.Fatal("non-image input should fail")
	}
	var input bytes.Buffer
	if err := png.Encode(&input, image.NewRGBA(image.Rect(0, 0, 9000, 10))); err != nil {
		t.Fatal(err)
	}
	if _, err := encodeChatAvatar(bytes.NewReader(input.Bytes())); err == nil {
		t.Fatal("oversized image dimensions should fail")
	}
}

func TestWriteChatAvatarFileKeepsPrevious(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "chats", "example")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	first := []byte{0xff, 0xd8, 0x01, 0xff}
	second := []byte{0xff, 0xd8, 0x02, 0xff}
	firstName, err := writeChatAvatarFile(dir, first)
	if err != nil {
		t.Fatal(err)
	}
	secondName, err := writeChatAvatarFile(dir, second)
	if err != nil {
		t.Fatal(err)
	}
	if firstName == secondName {
		t.Fatal("different avatar contents should use different filenames")
	}
	got, err := os.ReadFile(filepath.Join(dir, firstName))
	if err != nil || !bytes.Equal(got, first) {
		t.Fatalf("previous avatar changed: %x, %v", got, err)
	}
	got, err = os.ReadFile(filepath.Join(dir, secondName))
	if err != nil || !bytes.Equal(got, second) {
		t.Fatalf("new avatar = %x, %v", got, err)
	}
}

func TestWriteChatAvatarFileRejectsSymlinkTarget(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "chats", "example")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "outside.jpg")
	if err := os.WriteFile(outside, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	data := []byte{0xff, 0xd8, 0xff}
	if err := os.Symlink(outside, filepath.Join(dir, chatAvatarFilename(data))); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := writeChatAvatarFile(dir, data); err == nil {
		t.Fatal("symlink avatar target should fail")
	}
	got, err := os.ReadFile(outside)
	if err != nil || string(got) != "keep" {
		t.Fatalf("outside file changed: %q, %v", got, err)
	}
}
