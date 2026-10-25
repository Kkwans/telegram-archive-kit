//go:build !windows

package main

import (
	"bufio"
	"os"
	"time"
)

func terminalInit()      {}
func terminalWidth() int { return 100 }
func flushInput()        {}

func readKey() Key {
	r, _, _ := bufio.NewReader(os.Stdin).ReadRune()
	if r == '\n' || r == '\r' {
		return Key{Code: keyEnter}
	}
	if r == 27 {
		return Key{Code: keyEsc}
	}
	return Key{Rune: r}
}
func pollKey(timeout time.Duration) (Key, bool) { return Key{}, false }

func enablePerMonitorDPI() {}
