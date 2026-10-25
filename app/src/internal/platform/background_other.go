//go:build !windows

package platform

func Background() func() { return func() {} }
