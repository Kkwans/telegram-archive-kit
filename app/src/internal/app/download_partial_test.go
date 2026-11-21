package app

import (
	"context"
	"errors"
	"testing"
)

func TestPartialBelowThreshold(t *testing.T) {
	cases := []struct {
		plan, done int
		want       bool
	}{
		{0, 0, false},
		{2025, 0, true},
		{2025, 100, true},
		{2025, 101, true},
		{2025, 102, false},
		{2025, 144, false},
		{100, 5, false},
		{100, 4, true},
		{1, 0, true},
		{1, 1, false},
	}
	for _, tc := range cases {
		if got := partialBelowThreshold(tc.plan, tc.done); got != tc.want {
			t.Errorf("plan=%d done=%d: below=%v want %v", tc.plan, tc.done, got, tc.want)
		}
	}
}

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
