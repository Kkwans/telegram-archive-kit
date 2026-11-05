package app

import (
	"bytes"
	"testing"
)

type bufferWriteCloser struct{ bytes.Buffer }

func (b *bufferWriteCloser) Close() error { return nil }

func TestLoginInputSubmitsCarriageReturn(t *testing.T) {
	buf := &bufferWriteCloser{}
	sess := &loginSession{id: "login-test", state: "waiting", stdin: buf}
	f := &Facade{login: sess}
	if err := f.LoginInput(sess.id, " +8613800000000 "); err != nil {
		t.Fatal(err)
	}
	if got := buf.String(); got != "+8613800000000\r" {
		t.Fatalf("expected CR-terminated input, got %q", got)
	}
}
