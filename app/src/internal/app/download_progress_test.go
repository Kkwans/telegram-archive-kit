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

func TestActiveTransferredBytesCountsInFlightFiles(t *testing.T) {
	c := newProgressCapture(nil)
	c.active["2"] = true
	c.active["3"] = true
	c.active["4"] = true
	c.transferred["2"] = 300
	c.transferred["3"] = 900
	c.transferred["4"] = 100
	plan := downloadPlan{IDs: map[string]int64{"2": 1000, "3": 500, "4": 1000}}
	baseline := map[string]bool{"1": true}
	completed := map[string]bool{"4": true}
	if got := c.activeTransferredBytes(plan, baseline, completed); got != 800 {
		t.Fatalf("active bytes = %d, want 800 (300 + capped 500, completed excluded)", got)
	}
}

func TestAverageRunSpeedExcludesBaseline(t *testing.T) {
	if got := averageRunSpeed(1500, 1000, 2*time.Second); got != 250 {
		t.Fatalf("average = %v, want 250", got)
	}
	if got := averageRunSpeed(900, 1000, 2*time.Second); got != 0 {
		t.Fatalf("average below baseline = %v, want 0", got)
	}
}
