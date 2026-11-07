package archive

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBuildOfficialArchiveParsesMessagesAndReusesMedia(t *testing.T) {
	root := t.TempDir()
	html := `<!DOCTYPE html><html><head><title>Exported Data</title></head><body>
<div class="message service" id="message-1"><div class="body details">28 October 2022</div></div>
<div class="message default clearfix" id="message13">
  <div class="body">
    <div class="pull_right date details" title="28.10.2022 00:34:24 UTC+08:00">00:34</div>
    <div class="from_name">Alice</div>
    <div class="media_wrap clearfix"><a class="video_file_wrap clearfix pull_left" href="video_files/v1.mp4"><img class="video_file" src="video_files/v1.mp4_thumb.jpg"></a></div>
  </div>
</div>
<div class="message default clearfix joined" id="message17">
  <div class="body">
    <div class="pull_right date details" title="28.10.2022 00:35:00 UTC+08:00">00:35</div>
    <div class="media_wrap clearfix"><a class="video_file_wrap clearfix pull_left" href="video_files/v2.mp4"></a></div>
  </div>
</div>
<div class="message default clearfix" id="message20">
  <div class="body">
    <div class="pull_right date details" title="28.10.2022 00:36:00 UTC+08:00">00:36</div>
    <div class="text">Hello<br>World &amp; <a href="https://example.com">link</a></div>
  </div>
</div>
</body></html>`
	if err := os.WriteFile(filepath.Join(root, "messages.html"), []byte(html), 0644); err != nil {
		t.Fatal(err)
	}
	extra := map[string][]Media{
		"13": {{Path: "official_exports/x/video_files/v1.mp4", Name: "v1.mp4", Kind: "video", Size: 10, Thumb: "official_exports/x/video_files/v1.mp4_thumb.jpg"}},
		"17": {{Path: "official_exports/x/video_files/v2.mp4", Name: "v2.mp4", Kind: "video", Size: 20}},
	}
	arc, err := BuildOfficialArchive([]string{root}, extra, "Alice Chat")
	if err != nil {
		t.Fatal(err)
	}
	if arc.Chat.Name != "Alice Chat" {
		t.Fatalf("chat name = %q", arc.Chat.Name)
	}
	if len(arc.Messages) != 3 {
		t.Fatalf("messages = %d, want 3", len(arc.Messages))
	}
	if arc.Messages[0].ID != "13" || arc.Messages[0].From != "Alice" || len(arc.Messages[0].Media) != 1 {
		t.Fatalf("first message = %+v", arc.Messages[0])
	}
	if arc.Messages[1].From != "Alice" {
		t.Fatalf("joined sender = %q, want Alice", arc.Messages[1].From)
	}
	if arc.Messages[2].Text != "Hello\nWorld & link" {
		t.Fatalf("text = %q", arc.Messages[2].Text)
	}
	if arc.Stats.Messages != 3 || arc.Stats.Videos != 2 || arc.Stats.MediaFiles != 2 {
		t.Fatalf("stats = %+v", arc.Stats)
	}
}
