//go:build windows

package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestConPTYLauncherEcho(t *testing.T) {
	term, wait, err := newConPTYLauncher()(context.Background(), `C:\Windows\System32\cmd.exe`, []string{"/c", "echo hello-conpty"})
	if err != nil {
		t.Fatal(err)
	}
	defer term.Close()

	ch := make(chan string, 8)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := term.Read(buf)
			if n > 0 {
				ch <- string(buf[:n])
			}
			if err != nil {
				close(ch)
				return
			}
		}
	}()
	_ = wait
	deadline := time.After(4 * time.Second)
	var got strings.Builder
	for {
		select {
		case chunk, ok := <-ch:
			if !ok {
				t.Fatalf("console closed before echo: %q", got.String())
			}
			got.WriteString(chunk)
			if strings.Contains(got.String(), "hello-conpty") {
				return
			}
		case <-deadline:
			t.Fatalf("pseudo console produced no echo: %q", got.String())
		}
	}
}
