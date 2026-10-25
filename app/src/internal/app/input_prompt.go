package app

import "strings"

// inlineEditor is the single-line editor behind every in-frame text prompt.
// It stays inside the rounded panel so Windows console line input can never
// paint text outside the UI, and it captures Esc/arrows instead of waiting for
// a newline.
type inlineEditor struct {
	text []rune
	pos  int
}

func newInlineEditor(initial string) *inlineEditor {
	text := make([]rune, 0, len(initial))
	for _, r := range initial {
		if r == '\r' || r == '\n' || r == '\t' {
			r = ' '
		}
		if r < 32 || r == 127 {
			continue
		}
		text = append(text, r)
	}
	return &inlineEditor{text: text, pos: len(text)}
}

func (e *inlineEditor) value() string { return string(e.text) }

func (e *inlineEditor) insert(s string) {
	for _, r := range s {
		if r == '\r' || r == '\n' || r == '\t' {
			r = ' '
		}
		if r < 32 || r == 127 {
			continue
		}
		e.text = append(e.text, 0)
		copy(e.text[e.pos+1:], e.text[e.pos:])
		e.text[e.pos] = r
		e.pos++
	}
}

func (e *inlineEditor) backspace() {
	if e.pos == 0 {
		return
	}
	e.text = append(e.text[:e.pos-1], e.text[e.pos:]...)
	e.pos--
}

func (e *inlineEditor) deleteForward() {
	if e.pos >= len(e.text) {
		return
	}
	e.text = append(e.text[:e.pos], e.text[e.pos+1:]...)
}

func (e *inlineEditor) left() {
	if e.pos > 0 {
		e.pos--
	}
}

func (e *inlineEditor) right() {
	if e.pos < len(e.text) {
		e.pos++
	}
}

func (e *inlineEditor) home() { e.pos = 0 }
func (e *inlineEditor) end()  { e.pos = len(e.text) }

// view returns the text fragments on both sides of the caret, scrolled so the
// caret always stays inside width cells including one caret cell.
func (e *inlineEditor) view(width int) (string, string) {
	if width < 5 {
		width = 5
	}
	avail := width - 1
	start := e.scrollStart(avail)
	if start > 0 {
		avail--
		start = e.scrollStart(avail)
	}
	var before strings.Builder
	if start > 0 {
		before.WriteString("…")
	}
	for i := start; i < e.pos; i++ {
		before.WriteRune(e.text[i])
	}
	used := visibleWidth(before.String())
	var after strings.Builder
	for i := e.pos; i < len(e.text); i++ {
		w := runeCells(e.text[i])
		if used+w > avail {
			after.WriteString("…")
			break
		}
		after.WriteRune(e.text[i])
		used += w
	}
	return before.String(), after.String()
}

func (e *inlineEditor) scrollStart(avail int) int {
	used := 0
	for i := e.pos - 1; i >= 0; i-- {
		w := runeCells(e.text[i])
		if used+w > avail {
			return i + 1
		}
		used += w
	}
	return 0
}

func runeCells(r rune) int {
	if r == 0xfe0f || r == 0x200d || (r >= 0x300 && r <= 0x36f) {
		return 0
	}
	if isWideRune(r) {
		return 2
	}
	return 1
}

// promptText renders a text field inside the shared rounded frame. Esc always
// returns to the caller; Enter commits. allowEmpty controls whether an empty
// Enter is accepted or treated like Esc.
func promptText(title, subtitle, label, initial string, allowEmpty bool) (string, bool) {
	ed := newInlineEditor(initial)
	for {
		inner := uiInnerWidth()
		lead := uiLeadFor(inner)
		fieldWidth := inner - 6
		if fieldWidth < 12 {
			fieldWidth = 12
		}
		before, after := ed.view(fieldWidth)
		var b strings.Builder
		b.WriteString(topFrame(title, subtitle))
		b.WriteString(lead + "  " + muted(label) + "\n")
		b.WriteString(lead + "  " + cyan("▸ ") + ansiWhite + before + ansiBold + ansiCyan + "▌" + ansiReset + ansiWhite + after + ansiReset + "\n")
		b.WriteString(lead + "\n")
		hint := "←/→ 移动光标 · Home/End · Backspace 删除 · 支持直接粘贴"
		if !allowEmpty {
			hint += " · 留空返回"
		}
		b.WriteString(lead + "  " + cyan("Esc") + " 取消   " + cyan("Enter") + " 确认   " + muted(hint) + "\n")
		renderFrame(b.String())

		k := readKey()
		if k.Ctrl && (k.Rune == 22 || k.Rune == 'v' || k.Rune == 'V') {
			ed.insert(readClipboardText())
			continue
		}
		switch k.Code {
		case keyEnter:
			if !allowEmpty && strings.TrimSpace(ed.value()) == "" {
				return "", false
			}
			return ed.value(), true
		case keyEsc:
			return "", false
		case keyBackspace:
			ed.backspace()
		case keyDelete:
			ed.deleteForward()
		case keyLeft:
			ed.left()
		case keyRight:
			ed.right()
		case keyHome:
			ed.home()
		case keyEnd:
			ed.end()
		default:
			if k.Rune >= 32 && k.Rune != 127 {
				ed.insert(string(k.Rune))
			}
		}
	}
}
