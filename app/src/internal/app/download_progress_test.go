package app

import (
	"encoding/json"
	"reflect"
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

func TestDownloadPlanForMessagesSelectionAndDuplicateSizes(t *testing.T) {
	messages := []map[string]any{
		{"id": json.Number("1"), "media_type": "photo", "file_size": json.Number("100")},
		{"id": json.Number("2"), "media_type": "audio_file", "file_size": json.Number("250")},
		{"id": json.Number("2"), "media_type": "audio_file", "file_size": json.Number("300")},
		{"id": json.Number("3"), "media_type": "file", "file_size": json.Number("400")},
	}
	all := downloadPlanForMessages(messages, nil)
	if all.Total != 3 || all.KnownCount != 3 || all.KnownBytes != 800 || all.Audio != 1 || all.IDs["2"] != 300 {
		t.Fatalf("duplicate IDs must contribute their final size once: %#v", all)
	}
	selected := downloadPlanForMessages(messages, map[string]bool{"2": true, "3": false})
	if selected.Total != 1 || selected.KnownCount != 1 || selected.KnownBytes != 300 || selected.Audio != 1 {
		t.Fatalf("unexpected selected plan: %#v", selected)
	}
	if empty := downloadPlanForMessages(messages, map[string]bool{}); empty.Total != 0 {
		t.Fatalf("empty selection must not mean all messages: %#v", empty)
	}
	data, err := json.Marshal(RawExport{Messages: messages})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parseDownloadPlan(data)
	if err != nil || !reflect.DeepEqual(parsed, all) {
		t.Fatalf("parsed and direct plans differ: %#v, %v", parsed, err)
	}
}

func TestProgressSnapshotKeepsInFlightBytesAndPlanKinds(t *testing.T) {
	c := newProgressCapture(nil)
	plan := downloadPlan{
		Total: 3,
		IDs:   map[string]int64{"1": 100, "2": 1000, "3": 0},
		Kinds: map[string]string{"1": "image", "2": "video", "3": "audio"},
	}
	_, _ = c.Write([]byte("Chat(1):2 -> file ... 30% [300 B in 1s]\n"))
	_, _ = c.Write([]byte("Chat(1):3 -> file ... done! [50 B in 1s]\n"))
	_, _ = c.Write([]byte("Chat(1):999 -> file ... 50% [999 B in 1s]\n"))
	done, bytes, _, _ := c.progressSnapshot(plan, map[string]bool{"1": true}, 100)
	if done != 2 || bytes != 450 {
		t.Fatalf("done=%d bytes=%d, want 2 and 450", done, bytes)
	}
	active, completed := c.taskProgress(plan, time.Now())
	if len(active) != 2 || active[0].Kind != "video" || len(completed) != 1 || completed[0].Kind != "audio" || completed[0].Transferred != 50 {
		t.Fatalf("active=%#v completed=%#v", active, completed)
	}
	_, _ = c.Write([]byte("Chat(1):2 -> file ... done! [1 KB in 1s]\n"))
	done, bytes, _, _ = c.progressSnapshot(plan, map[string]bool{"1": true}, 100)
	if done != 3 || bytes != 1150 {
		t.Fatalf("completion should use exact known size: done=%d bytes=%d", done, bytes)
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
