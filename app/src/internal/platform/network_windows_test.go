//go:build windows

package platform

import "testing"

func TestNetworkPathKindUNC(t *testing.T) {
	remote, kind := NetworkPathKind(`\\nas\share\TG Library`)
	if !remote || kind != "unc" {
		t.Fatalf("NetworkPathKind(UNC) = %v, %q; want true, unc", remote, kind)
	}
}

func TestNetworkPathKindForwardSlashUNC(t *testing.T) {
	remote, kind := NetworkPathKind(`//nas/share/TG Library`)
	if !remote || kind != "unc" {
		t.Fatalf("NetworkPathKind(//UNC) = %v, %q; want true, unc", remote, kind)
	}
}

func TestManagedSSHDriveReportsRemoteUntilUnmounted(t *testing.T) {
	const root = `a:\archives`
	wasRemote, previousKind := NetworkPathKind(root)
	unmark := MarkManagedRemoteDrive("A")
	t.Cleanup(unmark)
	if remote, kind := NetworkPathKind(root); !remote || kind != "mapped" {
		t.Fatalf("mounted archive reported remote=%v kind=%q", remote, kind)
	}
	unmark()
	if remote, kind := NetworkPathKind(root); remote != wasRemote || kind != previousKind {
		t.Fatalf("unmounted drive reported remote=%v kind=%q", remote, kind)
	}
}
