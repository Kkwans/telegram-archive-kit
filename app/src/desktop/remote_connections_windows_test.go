//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	takapp "telegramarchivekit/internal/app"
)

const testSavedLibraryID = "0123456789abcdef0123456789abcdef"

func TestRemoteConnectionEndpointsRejectInlineConfiguration(t *testing.T) {
	for _, target := range []string{"-oProxyCommand", "ssh://admin:secret@host", "admin@host -F extra"} {
		if _, err := sshEndpoint(target, "/library"); err == nil {
			t.Errorf("accepted SSH target %q", target)
		}
	}
	for _, remote := range []string{":sftp", "nas,pass=secret", "C", "--config"} {
		if _, err := rcloneEndpoint(remote, "library", "Z"); err == nil {
			t.Errorf("accepted rclone remote %q", remote)
		}
	}
	endpoint, err := rcloneEndpoint("库备份+nas@example:", `root\archive`, "z:")
	if err != nil || endpoint.Name != "库备份+nas@example" || endpoint.Path != "root/archive" || endpoint.Drive != "Z" {
		t.Fatalf("rclone endpoint: %+v, %v", endpoint, err)
	}
	endpoint, err = uncEndpoint("//server/share/archive/../library")
	if err != nil || endpoint.Path != `\\server\share\library` {
		t.Fatalf("UNC endpoint: %+v, %v", endpoint, err)
	}
	for _, root := range []string{`\\server`, `\\?\UNC\server\share`, `\\user:secret@server\share`} {
		if _, err := uncEndpoint(root); err == nil {
			t.Errorf("accepted UNC path %q", root)
		}
	}
}

func TestRemoteConnectionSettingsKeepEndpointAndRememberedRoots(t *testing.T) {
	s := &remoteConnections{file: filepath.Join(t.TempDir(), "remote-connections.json")}
	c := savedRemoteConnection{
		ID: testSavedLibraryID, Label: "NAS", Root: `Z:\`, AutoReconnect: true,
		remoteEndpoint: remoteEndpoint{Kind: "ssh", Name: "archive-nas", Path: "/volume/archive"},
	}
	if err := s.replaceLocked(c); err != nil {
		t.Fatal(err)
	}
	c.updateRoot(`Y:\`)
	if err := s.replaceLocked(c); err != nil {
		t.Fatal(err)
	}
	reloaded, err := readRemoteConnections(s.file)
	if err != nil || len(reloaded) != 1 {
		t.Fatalf("read persisted connection: %v, %v", reloaded, err)
	}
	got := reloaded[0]
	if got.ID != c.ID || got.Label != "NAS" || !got.AutoReconnect ||
		!got.remoteEndpoint.same(c.remoteEndpoint) || !got.matchesRoot(`Z:\`) || got.Root != `Y:\` {
		t.Fatalf("unexpected persisted connection: %+v", got)
	}
}

func TestRemoteConnectionListReportsLiveAndSavedMounts(t *testing.T) {
	endpoint := remoteEndpoint{Kind: "ssh", Name: "fixture@host", Path: "/archive"}
	root := `M:\archive`
	mount := &rcloneMount{endpoint: endpoint, libraryRoot: root, ready: true}
	bridge := &Bridge{mounts: map[string]*rcloneMount{"M": mount}}
	service := &remoteConnections{b: bridge, current: remoteSelection{
		id: testSavedLibraryID, root: root, ready: true, mount: mount,
	}}

	list, err := service.list()
	if err != nil || len(list.Connections) != 0 || len(list.MountedConnections) != 1 {
		t.Fatalf("unrecorded live mount missing: %+v, %v", list, err)
	}
	live := list.MountedConnections[0]
	if !live.Active || !live.Mounted || !live.CanSave || live.Status != "connected" || live.Drive != "M" {
		t.Fatalf("incorrect live mount state: %+v", live)
	}

	otherEndpoint := endpoint
	otherEndpoint.SSHUseRoot = true
	service.records = []savedRemoteConnection{{ID: testSavedLibraryID, Root: root, remoteEndpoint: otherEndpoint}}
	list, err = service.list()
	if err != nil || len(list.MountedConnections) != 1 || list.MountedConnections[0].CanSave || list.Connections[0].Active {
		t.Fatalf("different saved mode was mistaken for the live mount: %+v, %v", list, err)
	}

	service.records[0].remoteEndpoint = endpoint
	list, err = service.list()
	if err != nil || len(list.MountedConnections) != 0 || !list.Connections[0].Active || list.Connections[0].Status != "connected" {
		t.Fatalf("saved live mount was not recognized: %+v, %v", list, err)
	}

	service.current = remoteSelection{root: `D:\another-library`}
	list, err = service.list()
	if err != nil || list.Connections[0].Active || list.Connections[0].Status != "mounted" {
		t.Fatalf("inactive saved mount was reported offline: %+v, %v", list, err)
	}
}

func TestRemoteConnectionRejectsWrongLibraryBeforeWriting(t *testing.T) {
	root := t.TempDir()
	s := &remoteConnections{probes: make(map[string]*remoteProbe)}
	if err := s.verify(context.Background(), root, testSavedLibraryID); !errors.Is(err, takapp.ErrLibraryIdentity) {
		t.Fatalf("missing marker error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".runtime")); !os.IsNotExist(err) {
		t.Fatalf("identity probe created runtime state: %v", err)
	}
	runtimeDir := filepath.Join(root, ".runtime")
	if err := os.Mkdir(runtimeDir, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(runtimeDir, "library-id")
	wrong := strings.Repeat("f", 32)
	if err := os.WriteFile(marker, []byte(wrong), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.verify(context.Background(), root, testSavedLibraryID); !errors.Is(err, takapp.ErrLibraryIdentity) {
		t.Fatalf("wrong marker error: %v", err)
	}
	if err := s.verify(context.Background(), root, wrong); err != nil {
		t.Fatalf("expected marker error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(runtimeDir, "session.json")); !os.IsNotExist(err) {
		t.Fatalf("probe acquired a write session: %v", err)
	}
}

func TestRemoteConnectionProbeDoesNotTrustRememberedDrivePath(t *testing.T) {
	reused := t.TempDir()
	s := &remoteConnections{b: &Bridge{}, records: []savedRemoteConnection{{
		ID: testSavedLibraryID, Root: reused,
		remoteEndpoint: remoteEndpoint{Kind: "ssh", Name: "archive-nas", Path: "/volume/archive"},
	}}}
	err := s.validateExplicitProbe(context.Background(), reused, false)
	if err == nil || classifyRemoteError(err).status != "offline" {
		t.Fatalf("unowned mounted path was accepted: %v", err)
	}
	if err := s.validateExplicitProbe(context.Background(), reused, true); err == nil {
		t.Fatal("unowned path was accepted as a new mount")
	}
}

func TestRemoteConnectionBackoffOnlyForSelectedOptIn(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	current := savedRemoteConnection{ID: testSavedLibraryID}
	inactive := savedRemoteConnection{ID: strings.Repeat("a", 32), AutoReconnect: true}
	s := &remoteConnections{
		ctx: ctx, records: []savedRemoteConnection{current, inactive},
		current: remoteSelection{id: current.ID}, progress: make(map[string]remoteProgress),
	}
	var health time.Time
	var generation uint64
	s.poll(&health, &generation)
	if s.flight != nil {
		t.Fatal("auto-connect started for a non-current connection")
	}
	s.recordFailureLocked(current, context.DeadlineExceeded)
	s.recordFailureLocked(inactive, context.DeadlineExceeded)
	if !s.progress[current.ID].next.IsZero() || !s.progress[inactive.ID].next.IsZero() {
		t.Fatal("retry scheduled for opted-out or non-current connection")
	}
	current.AutoReconnect = true
	for range 8 {
		s.recordFailureLocked(current, context.DeadlineExceeded)
	}
	if remaining := time.Until(s.progress[current.ID].next); remaining < 50*time.Second || remaining > 60*time.Second {
		t.Fatalf("retry was not capped: %s", remaining)
	}
	s.recordFailureLocked(current, takapp.ErrLibraryIdentity)
	if !s.progress[current.ID].next.IsZero() || s.progress[current.ID].status != "identity_mismatch" {
		t.Fatal("identity mismatch scheduled a retry")
	}
}

func TestRemoteMountDiagnosticDoesNotExposeRawOutput(t *testing.T) {
	var report mountReport
	_, _ = report.Write([]byte("Permission denied: access token synthetic-secret"))
	err := report.failure(false)
	if err.status != "authentication_required" || strings.Contains(err.Error(), "synthetic-secret") {
		t.Fatalf("unsafe or untyped mount diagnostic: %v", err)
	}
}
