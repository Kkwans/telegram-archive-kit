package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/gotd/td/tg"
)

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
	kind, file, _, _, ok := mapOnlineMedia(photo)
	if !ok || kind != "photo" || file == "" {
		t.Errorf("photo mapping = %q %q %v", kind, file, ok)
	}

	doc := &tg.Document{MimeType: "video/mp4", Size: 123, Attributes: []tg.DocumentAttributeClass{
		&tg.DocumentAttributeFilename{FileName: "clip.mp4"},
		&tg.DocumentAttributeVideo{},
	}}
	media := &tg.MessageMediaDocument{Document: doc}
	kind, file, name, size, ok := mapOnlineMedia(media)
	if !ok || kind != "video_file" || file != "clip.mp4" || name != "clip.mp4" || size != 123 {
		t.Errorf("document mapping = %q %q %q %d %v", kind, file, name, size, ok)
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
