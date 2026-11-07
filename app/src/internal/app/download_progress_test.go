package app

import (
	"testing"
	"time"
)

func TestDownloadPercentUsesBytes(t *testing.T) {
	plan := downloadPlan{Total: 4, KnownCount: 4, KnownBytes: 1000}
	s := newDownloadSnapshot("chat", 1, plan, 1, 250, 10, 20*time.Second, nil, "正在下载", "", 0, 4, 4)
	if s.Percent != 25 {
		t.Fatalf("percent = %v, want 25 (250/1000 bytes)", s.Percent)
	}
	if s.TotalBytes != 1000 || s.TotalBytesEstimated {
		t.Fatalf("total bytes = %d estimated=%v", s.TotalBytes, s.TotalBytesEstimated)
	}
}

func TestDownloadPercentExtrapolatesMissingSizes(t *testing.T) {
	plan := downloadPlan{Total: 4, KnownCount: 2, KnownBytes: 1000}
	s := newDownloadSnapshot("chat", 1, plan, 1, 500, 10, 20*time.Second, nil, "正在下载", "", 0, 4, 4)
	if s.TotalBytes != 2000 || !s.TotalBytesEstimated {
		t.Fatalf("total bytes = %d estimated=%v", s.TotalBytes, s.TotalBytesEstimated)
	}
	if s.Percent != 25 {
		t.Fatalf("percent = %v, want 25 (500/2000 bytes)", s.Percent)
	}
}
