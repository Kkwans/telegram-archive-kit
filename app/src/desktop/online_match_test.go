package main

import "testing"

func TestMatchOnlineChatByName(t *testing.T) {
	chats := []OnlineChat{
		{ID: 1, Name: "小反差"},
		{ID: 2, Name: "X wans"},
		{ID: 3, Name: "X.Wans (fan)"},
	}
	if chat, n := matchOnlineChatByName(chats, "小反差"); n != 1 || chat.ID != 1 {
		t.Fatalf("exact match = %+v, %d", chat, n)
	}
	if chat, n := matchOnlineChatByName(chats, "x wans"); n != 1 || chat.ID != 2 {
		t.Fatalf("case-insensitive match = %+v, %d", chat, n)
	}
	if _, n := matchOnlineChatByName(chats, "X Wans (fan)"); n != 1 {
		t.Fatalf("normalized match count = %d", n)
	}
	if _, n := matchOnlineChatByName(chats, "missing"); n != 0 {
		t.Fatalf("missing count = %d", n)
	}
	dupes := []OnlineChat{{ID: 4, Name: "同名"}, {ID: 5, Name: "同名"}}
	if _, n := matchOnlineChatByName(dupes, "同名"); n != 2 {
		t.Fatalf("duplicate count = %d", n)
	}
}
