package webpublish

import (
	"net"
	"os"
	"slices"
	"testing"
)

func TestCheckPortFindsIPv4AndIPv6Listeners(t *testing.T) {
	v4, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer v4.Close()
	v6, err := net.ListenTCP("tcp6", &net.TCPAddr{IP: net.IPv6loopback, Port: v4.Addr().(*net.TCPAddr).Port})
	if err != nil {
		t.Fatal(err)
	}
	defer v6.Close()
	owners, err := CheckPort(v4.Addr().(*net.TCPAddr).Port)
	if err != nil {
		t.Fatal(err)
	}
	for _, owner := range owners {
		if owner.PID != uint32(os.Getpid()) {
			continue
		}
		if owner.CanEnd || owner.Name == "" || owner.Started == "" || !slices.Contains(owner.Addresses, v4.Addr().String()) || !slices.Contains(owner.Addresses, v6.Addr().String()) {
			t.Fatalf("expected both addresses on the protected test process: %+v", owner)
		}
		if err := EndPortOwner(v4.Addr().(*net.TCPAddr).Port, owner.PID, owner.Started); err == nil {
			t.Fatal("the current process must be protected at confirmation too")
		}
		return
	}
	t.Fatal("test process was not found in the listener table")
}
