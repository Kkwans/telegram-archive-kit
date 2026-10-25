//go:build !windows

package app

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
	if r == 127 || r == 8 {
		return Key{Code: keyBackspace}
	}
	return Key{Rune: r}
}
func pollKey(timeout time.Duration) (Key, bool) { return Key{}, false }

func enablePerMonitorDPI()            {}
func processRunning(name string) bool { return false }
func readClipboardText() string       { return "" }
