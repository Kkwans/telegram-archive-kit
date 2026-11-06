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
