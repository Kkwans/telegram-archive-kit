package app

import "testing"

func TestRemoteStatusKeepsOfflineMappedIdentity(t *testing.T) {
	f := &Facade{a: &App{
		Settings:  Settings{LastRemoteRoot: `X:\`, LastRemoteKind: "mapped"},
		ConfigDir: t.TempDir(),
	}}
	st := f.RemoteStatusFor(`X:\`)
	if !st.Remote || st.Kind != "mapped" {
		t.Fatalf("offline mapped library should stay remote: %+v", st)
	}
	if st.Reachable || st.Writable {
		t.Fatalf("missing drive should not be reachable/writable: %+v", st)
	}
}
