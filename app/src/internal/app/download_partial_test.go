package app

import (
	"context"
	"errors"
	"testing"
)

func TestRecoverableDownloadFailureClassifiesPartialConditions(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"stalled", &TdlFailure{Kind: tdlFailureNetwork, Stalled: true}, true},
		{"network", &TdlFailure{Kind: tdlFailureNetwork}, true},
		{"content", &TdlFailure{Kind: tdlFailureContent}, true},
		{"auth", &TdlFailure{Kind: tdlFailureAuth}, false},
		{"unknown", &TdlFailure{Kind: tdlFailureUnknown}, false},
		{"deferred", errDeferredExhausted, true},
		{"deadline", context.DeadlineExceeded, true},
		{"abort", errUserAbort, false},
		{"move", errors.New("移动文档到 files/ 失败"), false},
	}
	for _, tc := range cases {
		if got := recoverableDownloadFailure(tc.err); got != tc.want {
			t.Errorf("%s: recoverable=%v want %v", tc.name, got, tc.want)
		}
	}
}
