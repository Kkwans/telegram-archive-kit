package platform

import (
	"path/filepath"
	"testing"
)

func TestSpaceOverrideUsesLongestLibraryPrefix(t *testing.T) {
	root := t.TempDir()
	library := filepath.Join(root, "volume2", "Telegram", "TG Library")
	workspace := filepath.Join(library, "chats", "chat-1")
	SetSpaceOverride(root, 900, 1000)
	SetSpaceOverride(library, 400, 700)
	t.Cleanup(func() {
		ClearSpaceOverride(root)
		ClearSpaceOverride(library)
	})
	if free, total := Space(workspace); free != 400 || total != 700 {
		t.Fatalf("library override = %d/%d, want 400/700", free, total)
	}
	if free, total := Space(filepath.Join(root, "other")); free != 900 || total != 1000 {
		t.Fatalf("mount override = %d/%d, want 900/1000", free, total)
	}
	ClearSpaceOverride(library)
	if free, total := Space(workspace); free != 900 || total != 1000 {
		t.Fatalf("fallback mount override = %d/%d, want 900/1000", free, total)
	}
}
