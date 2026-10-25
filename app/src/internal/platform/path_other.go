//go:build !windows

package platform

func AddUserPath(dir string) error { return nil }
