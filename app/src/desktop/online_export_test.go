package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gotd/td/tg"
)

func TestPreviewGenerationsIsolateCancellationAndProgress(t *testing.T) {
	b := &Bridge{}
	first, cancelFirst, generationFirst := b.beginPreview()
	b.setPreviewProgress(generationFirst, OnlineExportProgress{Active: true, Stage: "first"})
	second, cancelSecond, generationSecond := b.beginPreview()
	if first.Err() != context.Canceled {
		t.Fatal("starting a new preview must cancel the previous preview")
	}
	b.setPreviewProgress(generationSecond, OnlineExportProgress{Active: true, Stage: "second"})
	b.finishPreview(generationFirst, cancelFirst)
	b.setPreviewProgress(generationFirst, OnlineExportProgress{Active: true, Stage: "stale"})
	if got := b.OnlineExportPreviewProgress(); got.Stage != "second" || !got.Active {
		t.Fatalf("old preview changed the new preview: %#v", got)
	}
	b.OnlineExportPreviewCancel()
	if second.Err() != context.Canceled {
		t.Fatal("cancel after an old defer must still reach the current preview")
	}
	b.setPreviewProgress(generationSecond, OnlineExportProgress{Active: true, Stage: "late"})
	if got := b.OnlineExportPreviewProgress(); got.Stage != "正在取消统计" {
		t.Fatalf("cancelled preview published late progress: %#v", got)
	}
	b.finishPreview(generationSecond, cancelSecond)
	if got := b.OnlineExportPreviewProgress(); got.Active {
		t.Fatalf("finished preview remains active: %#v", got)
	}
}

func TestDesktopChatType(t *testing.T) {
	cases := []struct {
		chat OnlineChat
		want string
	}{
		{OnlineChat{Type: "private"}, "personal_chat"},
		{OnlineChat{Type: "bot"}, "personal_chat"},
		{OnlineChat{Type: "group"}, "private_group"},
		{OnlineChat{Type: "group", Username: "public"}, "public_group"},
		{OnlineChat{Type: "channel"}, "private_channel"},
		{OnlineChat{Type: "channel", Username: "news"}, "public_channel"},
	}
	for _, c := range cases {
		if got := desktopChatType(c.chat); got != c.want {
			t.Errorf("desktopChatType(%+v) = %q, want %q", c.chat, got, c.want)
		}
	}
}

func TestTextEntitiesKeepsUTF16Offsets(t *testing.T) {
	// "Hi 😀 ok": H/i at 0-2, emoji at UTF-16 3-5, "ok" at 6-8.
	text := "Hi 😀 ok"
	entities := []tg.MessageEntityClass{
		&tg.MessageEntityBold{Offset: 0, Length: 2},
		&tg.MessageEntityTextURL{Offset: 6, Length: 2, URL: "https://example.com"},
	}
	segments := textEntities(text, entities)
	if len(segments) != 3 {
		t.Fatalf("expected 3 segments, got %d: %#v", len(segments), segments)
	}
	if segments[0]["type"] != "bold" || segments[0]["text"] != "Hi" {
		t.Errorf("bold segment = %#v", segments[0])
	}
	if segments[1]["type"] != "plain" || segments[1]["text"] != " 😀 " {
		t.Errorf("plain gap = %#v", segments[1])
	}
	if segments[2]["type"] != "text_link" || segments[2]["text"] != "ok" || segments[2]["href"] != "https://example.com" {
		t.Errorf("link segment = %#v", segments[2])
	}
}

func TestLocalMaxMessageID(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "source"), 0755); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"messages": []any{
		map[string]any{"id": "10"},
		map[string]any{"id": 42},
		map[string]any{"id": "7"},
	}}
	b, _ := json.Marshal(payload)
	if err := os.WriteFile(filepath.Join(root, "source", "result.json"), b, 0644); err != nil {
		t.Fatal(err)
	}
	if got := localMaxMessageID(root); got != 42 {
		t.Errorf("localMaxMessageID = %d, want 42", got)
	}
}

func TestMapOnlineMedia(t *testing.T) {
	photo := &tg.MessageMediaPhoto{Photo: &tg.Photo{}}
	kind, file, _, _, _, _, ok := mapOnlineMedia(photo)
	if !ok || kind != "photo" || file == "" {
		t.Errorf("photo mapping = %q %q %v", kind, file, ok)
	}

	doc := &tg.Document{MimeType: "video/mp4", Size: 123, Attributes: []tg.DocumentAttributeClass{
		&tg.DocumentAttributeFilename{FileName: "clip.mp4"},
		&tg.DocumentAttributeVideo{},
	}}
	media := &tg.MessageMediaDocument{Document: doc}
	kind, file, name, size, width, height, ok := mapOnlineMedia(media)
	if !ok || kind != "video_file" || file != "clip.mp4" || name != "clip.mp4" || size != 123 || width != 0 || height != 0 {
		t.Errorf("document mapping = %q %q %q %d %dx%d %v", kind, file, name, size, width, height, ok)
	}
}

func TestFriendlyOnlineError(t *testing.T) {
	err := friendlyOnlineError(errors.New("callback: rpcDoRequest: rpc error code 420: FLOOD_WAIT (17)"))
	if err.Error() != "Telegram 限流，请等待 17 秒后再试" {
		t.Errorf("friendlyOnlineError = %q", err)
	}
	plain := errors.New("network down")
	if got := friendlyOnlineError(plain); got != plain {
		t.Errorf("plain error changed: %v", got)
	}
}

func TestOnlineStats(t *testing.T) {
	messages := []map[string]any{
		{"id": "1", "type": "message", "media_type": "photo", "file_size": int64(100)},
		{"id": "2", "type": "message", "media_type": "video_file", "file_size": int64(200)},
		{"id": "3", "type": "message", "media_type": "video_message"},
		{"id": "4", "type": "message", "media_type": "audio_file", "file_size": int64(300)},
		{"id": "5", "type": "message", "media_type": "voice_message"},
		{"id": "6", "type": "message", "media_type": "file", "file_size": int64(400)},
		{"id": "7", "type": "message", "media_type": "sticker"},
		{"id": "8", "type": "message", "media_type": "poll"},
		{"id": "9", "type": "message"},
		{"id": "10", "type": "service"},
	}
	service, images, videos, audio, files, other, media, size := onlineStats(messages)
	if service != 1 || images != 1 || videos != 2 || audio != 2 || files != 2 || other != 1 || media != 8 {
		t.Errorf("stats = service %d images %d videos %d audio %d files %d other %d media %d", service, images, videos, audio, files, other, media)
	}
	if size != 1000 {
		t.Errorf("size = %d, want 1000", size)
	}
}

func TestMapFolders(t *testing.T) {
	chats := []OnlineChat{
		{Peer: "channel:10", Type: "channel"},
		{Peer: "user:20", Type: "private", Contact: true},
		{Peer: "user:21", Type: "private"},
		{Peer: "chat:30", Type: "group"},
		{Peer: "chat:31", Type: "group", Archived: true},
		{Peer: "chat:32", Type: "group", Archived: true},
		{Peer: "user:40", Type: "bot"},
	}
	filters := []tg.DialogFilterClass{
		&tg.DialogFilter{
			ID: 3, Title: tg.TextWithEntities{Text: "反差"}, Emoticon: "🔥",
			PinnedPeers:  []tg.InputPeerClass{&tg.InputPeerChannel{ChannelID: 10}},
			IncludePeers: []tg.InputPeerClass{&tg.InputPeerUser{UserID: 20}},
			ExcludePeers: []tg.InputPeerClass{&tg.InputPeerUser{UserID: 21}},
		},
		&tg.DialogFilter{
			ID: 4, Title: tg.TextWithEntities{Text: "常用"},
			Groups: true, Contacts: true, Bots: true, ExcludeArchived: true,
			IncludePeers: []tg.InputPeerClass{&tg.InputPeerChat{ChatID: 32}},
		},
		&tg.DialogFilterDefault{},
	}
	folders := mapFolders(filters, chats)
	if len(folders) != 2 {
		t.Fatalf("folders = %#v", folders)
	}
	first := map[string]bool{}
	for _, peer := range folders[0].Peers {
		first[peer] = true
	}
	if folders[0].Title != "反差" || folders[0].Emoticon != "🔥" || len(first) != 2 || !first["channel:10"] || !first["user:20"] {
		t.Errorf("explicit folder = %#v", folders[0])
	}
	second := map[string]bool{}
	for _, peer := range folders[1].Peers {
		second[peer] = true
	}
	if !second["chat:30"] || !second["user:20"] || !second["user:40"] || !second["chat:32"] {
		t.Errorf("rule folder = %#v", folders[1])
	}
	if second["chat:31"] || second["user:21"] || second["channel:10"] {
		t.Errorf("rule folder included excluded peers: %#v", folders[1])
	}
}

func TestPreparedExportLifecycle(t *testing.T) {
	svc := NewOnlineService(t.TempDir())
	token := svc.Prepare("ns", "user:1", OnlineChat{Peer: "user:1"}, []map[string]any{{"id": "1"}}, 0)
	if token == "" {
		t.Fatal("empty token")
	}
	item, ok := svc.TakePrepared("ns", "user:1", token)
	if !ok || item.peer != "user:1" || len(item.messages) != 1 {
		t.Fatalf("prepared = %#v, ok = %v", item, ok)
	}
	if _, ok := svc.TakePrepared("ns", "user:1", token); ok {
		t.Error("prepared token was reusable")
	}

	token = svc.Prepare("ns", "user:2", OnlineChat{Peer: "user:2"}, []map[string]any{{"id": "2"}}, 0)
	svc.prepMu.Lock()
	item = svc.prepared[token]
	item.createdAt = time.Now().Add(-16 * time.Minute)
	svc.prepared[token] = item
	svc.prepMu.Unlock()
	if _, ok := svc.TakePrepared("ns", "user:2", token); ok {
		t.Error("expired prepared token was accepted")
	}
}

func TestPeerInputFromChat(t *testing.T) {
	user := peerInputFromChat(OnlineChat{Peer: "user:42", ID: 42, AccessHash: 99})
	if p, ok := user.(*tg.InputPeerUser); !ok || p.UserID != 42 || p.AccessHash != 99 {
		t.Errorf("user peer = %#v", user)
	}
	channel := peerInputFromChat(OnlineChat{Peer: "channel:43", ID: 43, AccessHash: 88})
	if p, ok := channel.(*tg.InputPeerChannel); !ok || p.ChannelID != 43 || p.AccessHash != 88 {
		t.Errorf("channel peer = %#v", channel)
	}
	chat := peerInputFromChat(OnlineChat{Peer: "chat:44", ID: 44})
	if p, ok := chat.(*tg.InputPeerChat); !ok || p.ChatID != 44 {
		t.Errorf("chat peer = %#v", chat)
	}
}
