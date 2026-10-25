//go:build !windows

package main

func beginBackgroundProcessing() func() { return func() {} }
