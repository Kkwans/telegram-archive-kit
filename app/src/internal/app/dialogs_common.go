package app

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

func readLinePrompt(label string) string {
	fmt.Print("  " + label + ": ")
	r := bufio.NewReader(os.Stdin)
	s, _ := r.ReadString('\n')
	return strings.TrimSpace(s)
}
