package app

import "testing"

func TestHasParentSegment(t *testing.T) {
	cases := map[string]bool{
		"media/5091999969_62218_26378..mp4": false,
		"media/..hidden/file.jpg":           false,
		"media/file.jpg":                    false,
		"../secret":                         true,
		"media/../secret":                   true,
		"media/..":                          true,
		"..":                                true,
	}
	for rel, want := range cases {
		if got := hasParentSegment(rel); got != want {
			t.Errorf("hasParentSegment(%q) = %v, want %v", rel, got, want)
		}
	}
}
