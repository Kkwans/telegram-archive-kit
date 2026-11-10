//go:build windows

package app

import "testing"

func TestLibraryFileURL(t *testing.T) {
	tests := []struct {
		path string
		slug string
		want string
	}{
		{`\\nas-box\Telegram\TG Library\index.html`, "", "file://nas-box/Telegram/TG%20Library/index.html"},
		{`\\nas-box\Telegram\TG Library\index.html`, "chat #42", "file://nas-box/Telegram/TG%20Library/index.html#chat=chat%20%2342"},
		{`D:\TG Library\index.html`, "chat-42", "file:///D:/TG%20Library/index.html#chat=chat-42"},
	}
	for _, tc := range tests {
		if got := localFileURL(tc.path, tc.slug); got != tc.want {
			t.Errorf("localFileURL(%q, %q) = %q, want %q", tc.path, tc.slug, got, tc.want)
		}
	}
}
