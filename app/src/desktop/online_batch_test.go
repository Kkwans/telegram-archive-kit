package main

import (
	"testing"

	takapp "telegramarchivekit/internal/app"
)

func TestMatchRetryChatUsesStoredOnlineName(t *testing.T) {
	item := takapp.TaskBatchItemDTO{Name: "闪现", OnlineName: "闪现", Slug: "chat_1"}
	chats := []OnlineChat{{Peer: "user:1", ID: 1, Name: "闪现"}}
	chat, ok := matchRetryChat(item, chats, nil)
	if !ok || chat.Peer != "user:1" {
		t.Fatalf("expected stored online name to match, got %+v ok=%v", chat, ok)
	}
}

func TestMatchRetryChatUsesLocalChatID(t *testing.T) {
	item := takapp.TaskBatchItemDTO{Name: "旧名称", Slug: "chat_1"}
	chats := []OnlineChat{{Peer: "channel:9", ID: 9, Name: "新名称"}}
	locals := []takapp.ChatDTO{{Slug: "chat_1", Name: "旧名称", ID: "9"}}
	chat, ok := matchRetryChat(item, chats, locals)
	if !ok || chat.Peer != "channel:9" {
		t.Fatalf("expected local id match, got %+v ok=%v", chat, ok)
	}
}

func TestMatchRetryChatRejectsAmbiguousOnlineName(t *testing.T) {
	item := takapp.TaskBatchItemDTO{Name: "闪现", OnlineName: "闪现", Slug: "chat_1"}
	chats := []OnlineChat{
		{Peer: "user:1", ID: 1, Name: "闪现"},
		{Peer: "user:2", ID: 2, Name: "闪现"},
	}
	if chat, ok := matchRetryChat(item, chats, nil); ok {
		t.Fatalf("ambiguous online name must not match, got %+v", chat)
	}
}
