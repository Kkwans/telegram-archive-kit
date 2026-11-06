//go:build !windows

package platform

import "strings"

func NetworkPathKind(path string) (bool, string) {
	p := strings.TrimSpace(path)
	if strings.HasPrefix(p, "//") {
		return true, "unc"
	}
	return false, "local"
}
