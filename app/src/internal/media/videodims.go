package media

import (
	"encoding/binary"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
)

// VideoDimensions reads display dimensions from an MP4/MOV container without
// invoking ffmpeg. Telegram exports sometimes omit width/height from
// result.json, but the viewer still needs the real aspect ratio before the
// video has loaded.
func VideoDimensions(path string) (width, height int) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp4", ".m4v", ".mov", ".3gp":
		return mp4Dimensions(path)
	default:
		return 0, 0
	}
}

func ImageDimensions(path string) (width, height int) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return 0, 0
	}
	return cfg.Width, cfg.Height
}

func mp4Dimensions(path string) (width, height int) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0, 0
	}
	width, height, _ = findTkhd(f, 0, info.Size(), 0)
	return width, height
}

func findTkhd(f *os.File, start, end int64, depth int) (width, height int, ok bool) {
	if depth > 6 || start < 0 || end <= start {
		return 0, 0, false
	}
	offset := start
	for offset+8 <= end {
		var head [8]byte
		if _, err := f.ReadAt(head[:], offset); err != nil {
			return 0, 0, false
		}
		size := int64(binary.BigEndian.Uint32(head[:4]))
		kind := string(head[4:8])
		header := int64(8)
		if size == 1 {
			var large [8]byte
			if _, err := f.ReadAt(large[:], offset+8); err != nil {
				return 0, 0, false
			}
			size = int64(binary.BigEndian.Uint64(large[:]))
			header = 16
		} else if size == 0 {
			size = end - offset
		}
		if size < header || offset+size > end {
			return 0, 0, false
		}
		payload := offset + header
		payloadEnd := offset + size
		switch kind {
		case "moov", "trak":
			if w, h, found := findTkhd(f, payload, payloadEnd, depth+1); found {
				return w, h, true
			}
		case "tkhd":
			if w, h, found := parseTkhd(f, payload, payloadEnd); found {
				return w, h, true
			}
		}
		offset = payloadEnd
	}
	return 0, 0, false
}

func parseTkhd(f *os.File, start, end int64) (width, height int, ok bool) {
	length := end - start
	if length < 8 || length > 4096 {
		return 0, 0, false
	}
	payload := make([]byte, length)
	if _, err := f.ReadAt(payload, start); err != nil {
		return 0, 0, false
	}
	tail := payload[len(payload)-8:]
	w := int(binary.BigEndian.Uint32(tail[:4]) >> 16)
	h := int(binary.BigEndian.Uint32(tail[4:]) >> 16)
	if w <= 0 || h <= 0 {
		return 0, 0, false
	}
	// tkhd ends with the 3x3 transform followed by width/height. A 90/270
	// degree transform means the displayed video is portrait even when the
	// coded track reports landscape dimensions.
	if len(payload) >= 44 {
		matrix := payload[len(payload)-44 : len(payload)-8]
		a := int32(binary.BigEndian.Uint32(matrix[0:4]))
		b := int32(binary.BigEndian.Uint32(matrix[4:8]))
		c := int32(binary.BigEndian.Uint32(matrix[12:16]))
		d := int32(binary.BigEndian.Uint32(matrix[16:20]))
		if a == 0 && d == 0 && (b != 0 || c != 0) {
			w, h = h, w
		}
	}
	return w, h, true
}
