package webpublish

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"telegramarchivekit/internal/model"
)

func waitStatus(t *testing.T, m *Manager, accept func(Status) bool) Status {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for {
		status := m.Status(false)
		if accept(status) {
			return status
		}
		if time.Now().After(deadline) {
			t.Fatalf("deployment never reached expected state: phase=%s message=%s", status.Phase, status.Message)
		}
		time.Sleep(15 * time.Millisecond)
	}
}

func TestRestorePortConflictAndExplicitStop(t *testing.T) {
	library, configDir := t.TempDir(), t.TempDir()
	writeArchive(t, filepath.Join(library, "chats", "local"), "复测聊天", "恢复检查", nil)
	fixtureJSON(t, filepath.Join(library, "library.json"), model.LibraryManifest{Chats: []model.LibraryChat{{Slug: "local", DataScript: "chats/local/data/archive-data.js"}}})
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	port := busy.Addr().(*net.TCPAddr).Port
	discover := func(context.Context) Network {
		return Network{Adapters: []Adapter{{ID: "fixture", IP: "127.0.0.1", LAN: netip.MustParsePrefix("127.0.0.0/8")}}, TailError: "Tailscale 离线"}
	}
	registered := false
	startup := func(enabled bool) error { registered = enabled; return nil }
	current := func() string { return library }
	m := NewManager(configDir, current, discover, startup)
	defer m.Close()
	config := Config{Scope: Scope{All: true}, Adapter: "fixture", Tailscale: true, Port: port, Auto: true}
	if err := m.Save(config, true); err != nil || !registered {
		t.Fatalf("could not start and register recovery: %v", err)
	}
	waitStatus(t, m, func(s Status) bool { return s.Phase == "waiting" && len(s.Endpoints) == 2 })
	busy.Close()
	m.signal()
	running := waitStatus(t, m, func(s Status) bool { return s.Phase == "running" })
	var address string
	for _, endpoint := range running.Endpoints {
		if endpoint.Kind == "lan" {
			address = endpoint.URL
		}
	}
	if address == "" || running.Published != 1 {
		t.Fatal("LAN should remain usable when Tailscale is unavailable")
	}
	if err := m.SwitchLibrary(func() error { t.Fatal("library switch called while deploying"); return nil }); err == nil {
		t.Fatal("library switch should require stop")
	}
	client := &http.Client{Timeout: time.Second}
	res, err := client.Get(address + "library-data.js")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || !strings.Contains(string(b), "local") {
		t.Fatal("no published manifest over the listener")
	}
	m.Close()
	if res, err := client.Get(address); err == nil {
		res.Body.Close()
		t.Fatal("closing the app must close the listener")
	}
	restored := NewManager(configDir, current, discover, startup)
	defer restored.Close()
	restored.Restore()
	waitStatus(t, restored, func(s Status) bool { return s.Phase == "running" })
	if err := restored.Stop(); err != nil {
		t.Fatal(err)
	}
	restored.Close()
	stopped := NewManager(configDir, current, discover, startup)
	defer stopped.Close()
	stopped.Restore()
	if stopped.Requested() {
		t.Fatal("an explicitly stopped deployment must not resume")
	}
}
