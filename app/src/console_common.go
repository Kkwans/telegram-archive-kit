package main

import (
	"fmt"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

const (
	keyUnknown = iota
	keyUp
	keyDown
	keyLeft
	keyRight
	keyEnter
	keyEsc
	keyHome
	keyEnd
	keyPageUp
	keyPageDown
)

type Key struct {
	Code  int
	Rune  rune
	Ctrl  bool
	Alt   bool
	Shift bool
}

const (
	ansiReset  = "\x1b[0m"
	ansiBold   = "\x1b[1m"
	ansiCyan   = "\x1b[38;2;110;211;255m"
	ansiBlue   = "\x1b[38;2;148;163;255m"
	ansiPurple = "\x1b[38;2;196;167;255m"
	ansiGreen  = "\x1b[38;2;103;232;176m"
	ansiYellow = "\x1b[38;2;250;204;110m"
	ansiRed    = "\x1b[38;2;251;126;145m"
	ansiGray   = "\x1b[38;2;203;211;223m"
	ansiWhite  = "\x1b[38;2;241;245;249m"
	ansiMuted  = "\x1b[38;2;143;157;178m"
	ansiBorder = "\x1b[38;2;83;104;151m"
	ansiBgSel  = "\x1b[48;2;30;41;58m"
)

var (
	legacyFrameActive bool
	legacyFrameBuffer strings.Builder
	altScreenActive   bool
	frameMu           sync.Mutex
)

func color(s, c string) string { return c + s + ansiReset }
func bold(s string) string     { return ansiBold + s + ansiReset }
func dim(s string) string      { return ansiGray + s + ansiReset }
func muted(s string) string    { return ansiMuted + s + ansiReset }
func cyan(s string) string     { return color(s, ansiCyan) }
func blue(s string) string     { return color(s, ansiBlue) }
func purple(s string) string   { return color(s, ansiPurple) }
func green(s string) string    { return color(s, ansiGreen) }
func yellow(s string) string   { return color(s, ansiYellow) }
func red(s string) string      { return color(s, ansiRed) }

// enterAltScreen switches to the terminal's alternate buffer. This is the same
// model used by full-screen TUIs: menu navigation and progress refreshes update
// one viewport instead of appending thousands of copies to scrollback.
func enterAltScreen() {
	if altScreenActive {
		return
	}
	altScreenActive = true
	fmt.Print("\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l")
}

func leaveAltScreen() {
	if !altScreenActive {
		return
	}
	showCursor()
	fmt.Print("\x1b[?1049l")
	altScreenActive = false
}

func clearScreen() {
	if altScreenActive {
		fmt.Print("\x1b[H\x1b[2J")
		return
	}
	fmt.Print("\x1b[2J\x1b[H")
}

// renderFrame performs a single in-place frame update. We intentionally do not
// clear the terminal before drawing, which avoids the flash caused by the v6
// clear-and-reprint loop. \x1b[J removes leftover rows from a previous taller frame.
// renderFrame is the single compositor for interactive screens. Every frame has
// one closed rounded outer border; the header and footer share its width.
// Never rely on terminal wrapping: ANSI-aware clipping happens *before* drawing.
func renderFrame(s string) {
	frameMu.Lock()
	defer frameMu.Unlock()
	fmt.Print(composeFrame(s))
}

func composeFrame(s string) string {
	inner := uiInnerWidth()
	lead := uiLeadFor(inner)
	raw := strings.Split(strings.Trim(s, "\n"), "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		lines = append(lines, strings.TrimPrefix(line, lead))
	}
	if len(lines) == 0 {
		return ""
	}
	// title/header are always the first two authored lines.
	header := make([]string, 0, 2)
	body := lines
	for len(body) > 0 && len(header) < 2 {
		if strings.TrimSpace(ansiRE.ReplaceAllString(body[0], "")) != "" {
			header = append(header, body[0])
		}
		body = body[1:]
	}
	// Last substantive line with a shortcut hint becomes the permanent footer.
	footer := "↑/↓ 选择     Enter 确认     Esc 返回"
	for len(body) > 0 && strings.TrimSpace(ansiRE.ReplaceAllString(body[len(body)-1], "")) == "" {
		body = body[:len(body)-1]
	}
	if len(body) > 0 {
		last := strings.TrimSpace(ansiRE.ReplaceAllString(body[len(body)-1], ""))
		if strings.HasPrefix(last, "Esc ") || strings.HasPrefix(last, "↑↓") || strings.HasPrefix(last, "↑/↓") {
			footer = body[len(body)-1]
			body = body[:len(body)-1]
		}
	}
	w := inner + 4
	edge := color("─", ansiBorder)
	_ = edge
	row := func(content string) string {
		// Keep all glyphs in the same fixed content rectangle.
		if visibleWidth(content) > inner {
			content = clipANSI(content, inner)
		}
		return lead + color("│", ansiBorder) + "  " + padVisible(content, inner) + "  " + color("│", ansiBorder)
	}
	var out strings.Builder
	out.WriteString("\x1b[?25l\x1b[H")
	out.WriteString(lead + color("╭"+strings.Repeat("─", w)+"╮", ansiBorder) + "\n")
	for _, h := range header {
		out.WriteString(row(h) + "\n")
	}
	out.WriteString(lead + color("├"+strings.Repeat("─", w)+"┤", ansiBorder) + "\n")
	for _, line := range body {
		out.WriteString(row(line) + "\n")
	}
	out.WriteString(lead + color("├"+strings.Repeat("─", w)+"┤", ansiBorder) + "\n")
	out.WriteString(row(footer) + "\n")
	out.WriteString(lead + color("╰"+strings.Repeat("─", w)+"╯", ansiBorder))
	out.WriteString("\x1b[J")
	// Clear the *whole* physical terminal line, not just our rounded panel.
	// In v9.8.6 a previous tdl output could leak "ult.json" to its right.
	return strings.ReplaceAll(out.String(), "\n", "\n\x1b[2K")
}

// clipANSI preserves terminal control sequences while measuring CJK/emoji cells.
func clipANSI(s string, maxWidth int) string {
	var b strings.Builder
	width := 0
	for i := 0; i < len(s); {
		if s[i] == 27 {
			if loc := ansiRE.FindStringIndex(s[i:]); loc != nil && loc[0] == 0 {
				b.WriteString(s[i : i+loc[1]])
				i += loc[1]
				continue
			}
		}
		r, n := utf8.DecodeRuneInString(s[i:])
		rw := 1
		if isWideRune(r) {
			rw = 2
		}
		if r == 0xfe0f || r == 0x200d || r >= 0x300 && r <= 0x36f {
			rw = 0
		}
		if width+rw > maxWidth-1 {
			b.WriteString("…")
			b.WriteString(ansiReset)
			return b.String()
		}
		b.WriteString(s[i : i+n])
		i += n
		width += rw
	}
	return b.String()
}

func hideCursor() { fmt.Print("\x1b[?25l") }
func showCursor() { fmt.Print("\x1b[?25h") }

func hr(width int) string {
	if width < 20 {
		width = 20
	}
	return strings.Repeat("─", width)
}

var ansiRE = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

func visibleWidth(s string) int {
	plain := ansiRE.ReplaceAllString(s, "")
	w := 0
	lastWidth := 0
	for _, r := range plain {
		if r == 0xfe0f {
			if lastWidth == 1 {
				w++
				lastWidth = 2
			}
			continue
		}
		if r == 0x200d || r >= 0x0300 && r <= 0x036f {
			continue
		}
		rw := 1
		if isWideRune(r) {
			rw = 2
		}
		w += rw
		lastWidth = rw
	}
	return w
}

func isWideRune(r rune) bool {
	return r == 0x2795 || (r >= 0x1100 && r <= 0x115f) || (r >= 0x2e80 && r <= 0xa4cf) || (r >= 0xac00 && r <= 0xd7a3) || (r >= 0xf900 && r <= 0xfaff) || (r >= 0xfe10 && r <= 0xfe6f) || (r >= 0xff00 && r <= 0xff60) || (r >= 0x1f000 && r <= 0x1faff)
}

func padVisible(s string, width int) string {
	if d := width - visibleWidth(s); d > 0 {
		return s + strings.Repeat(" ", d)
	}
	return s
}

func truncatePlain(s string, width int) string {
	if width <= 1 {
		return ""
	}
	if visibleWidth(s) <= width {
		return s
	}
	var b strings.Builder
	used := 0
	for _, r := range s {
		rw := 1
		if isWideRune(r) {
			rw = 2
		}
		if used+rw > width-1 {
			break
		}
		b.WriteRune(r)
		used += rw
	}
	return b.String() + "…"
}

func kvText(label, value string, labelWidth int) string {
	if labelWidth < 4 {
		labelWidth = 4
	}
	return padVisible(label, labelWidth) + "  " + value
}
func uiInnerWidth() int {
	w := terminalWidth() - 16
	if w < 60 {
		w = 60
	}
	if w > 94 {
		w = 94
	}
	return w
}

func uiLeadFor(inner int) string {
	total := inner + 6
	n := (terminalWidth() - total) / 2
	if n < 2 {
		n = 2
	}
	return strings.Repeat(" ", n)
}

func uiLead() string { return uiLeadFor(uiInnerWidth()) }

func uiPrintln(s string) {
	if legacyFrameActive {
		legacyFrameBuffer.WriteString(uiLead() + s + "\n")
		renderFrame(legacyFrameBuffer.String())
	} else {
		fmt.Println(uiLead() + s)
	}
}

func panelLine(content string, inner int) string {
	return uiLeadFor(inner) + color("│", ansiBorder) + " " + padVisible(content, inner-2) + " " + color("│", ansiBorder)
}

func topFrame(title, subtitle string) string {
	inner := uiInnerWidth()
	lead := uiLeadFor(inner)
	brand := ansiBold + ansiCyan + "✈  Telegram Archive Kit" + ansiReset + "  " + purple("v"+version)
	line := ansiBold + ansiWhite + title + ansiReset
	if subtitle != "" {
		line += "  " + muted(truncatePlain(subtitle, max(12, inner-visibleWidth(title)-5)))
	}
	return "\n" + lead + brand + "\n" + lead + line + "\n\n"
}
