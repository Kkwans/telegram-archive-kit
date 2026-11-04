package app

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type loginLauncher func(ctx context.Context, exe string, args []string) (io.ReadWriteCloser, func() error, error)

// SetLoginLauncher lets the desktop host run tdl on a pseudo console so
// interactive prompts (phone, code, 2FA) see a real terminal.
func (f *Facade) SetLoginLauncher(fn loginLauncher) {
	f.mu.Lock()
	f.loginLaunch = fn
	f.mu.Unlock()
}

// LoginStateDTO is polled by the account page. Screen is the terminal-mirrored
// login UI with ANSI color blocks converted to visible glyphs, so the QR code
// stays scannable inside the app instead of requiring a console window.
type LoginStateDTO struct {
	ID      string   `json:"id"`
	Kind    string   `json:"kind"`
	State   string   `json:"state"` // starting|waiting|success|failed|cancelled
	Screen  []string `json:"screen"`
	QR      []string `json:"qr,omitempty"`
	Prompt  string   `json:"prompt,omitempty"`
	Message string   `json:"message,omitempty"`
	Seq     int64    `json:"seq"`
}

type loginSession struct {
	id, kind string
	cancel   context.CancelFunc
	stdin    io.WriteCloser

	mu        sync.Mutex
	state     string
	screen    []string
	prompt    string
	message   string
	seq       int64
	inputAt   time.Time
	lastInput string
	qrCapture bool
	qrLines   []string
}

func (s *loginSession) snapshot() LoginStateDTO {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := LoginStateDTO{ID: s.id, Kind: s.kind, State: s.state, Prompt: s.prompt, Message: s.message, Seq: s.seq}
	out.Screen = append([]string{}, s.screen...)
	out.QR = append([]string{}, s.qrLines...)
	return out
}

func (s *loginSession) push(line string) {
	plain := stripTerminal(strings.TrimRight(line, string(rune(13))))
	if isBlockLine(line) {
		if !s.qrCapture {
			s.qrLines = nil
		}
		s.qrCapture = true
		s.qrLines = append(s.qrLines, plain)
		if len(s.qrLines) > 60 {
			s.qrLines = s.qrLines[len(s.qrLines)-60:]
		}
	} else if s.qrCapture {
		if strings.TrimSpace(plain) == "" {
			s.qrLines = append(s.qrLines, plain)
			if len(s.qrLines) > 60 {
				s.qrLines = s.qrLines[len(s.qrLines)-60:]
			}
		} else if qrLikeLine(plain) {
			s.qrLines = append(s.qrLines, plain)
			if len(s.qrLines) > 60 {
				s.qrLines = s.qrLines[len(s.qrLines)-60:]
			}
		} else {
			s.qrCapture = false
		}
	}
	line = strings.TrimRight(line, "\r")
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	masked := s.lastInput != "" && strings.Contains(line, s.lastInput)
	if masked {
		s.prompt = "输入已提交，等待 Telegram 响应"
		s.screen = append(s.screen, "••••••（输入已隐藏）")
	} else {
		if strings.TrimSpace(line) != "" {
			clean := strings.TrimSpace(stripTerminal(line))
			if clean != "" && !isBlockLine(line) {
				s.prompt = truncatePlain(clean, 120)
			}
		}
		s.screen = append(s.screen, visualizeTerminalLine(line))
	}
	if len(s.screen) > 30 {
		s.screen = s.screen[len(s.screen)-30:]
	}
}

func (s *loginSession) setState(state, message string) {
	s.mu.Lock()
	s.state = state
	if message != "" {
		s.message = message
	}
	s.seq++
	s.mu.Unlock()
}

// setPartial keeps prompts such as "Enter phone number: " that tdl writes
// without a trailing newline visible while the process waits for input.
func (s *loginSession) setPartial(text string) {
	clean := strings.TrimSpace(stripTerminal(text))
	if clean == "" || isBlockLine(text) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastInput != "" && strings.Contains(text, s.lastInput) {
		if s.prompt != "输入已提交，等待 Telegram 响应" {
			s.prompt = "输入已提交，等待 Telegram 响应"
			s.seq++
		}
		return
	}
	if clean != s.prompt {
		s.prompt = truncatePlain(clean, 120)
		s.seq++
	}
}

func readLoginStream(r io.Reader, sess *loginSession) {
	type chunk struct {
		data []byte
		err  error
	}
	ch := make(chan chunk, 16)
	go func() {
		br := bufio.NewReaderSize(r, 4096)
		buf := make([]byte, 4096)
		for {
			n, err := br.Read(buf)
			if n > 0 {
				ch <- chunk{data: append([]byte(nil), buf[:n]...)}
			}
			if err != nil {
				ch <- chunk{err: err}
				return
			}
		}
	}()

	var buf []byte
	for {
		select {
		case c := <-ch:
			for _, b := range c.data {
				if b == '\n' {
					sess.push(strings.TrimRight(string(buf), "\r"))
					buf = buf[:0]
					continue
				}
				buf = append(buf, b)
				if len(buf) > 1<<20 {
					buf = buf[len(buf)-(1<<20):]
				}
			}
			if c.err != nil {
				if len(buf) > 0 {
					sess.setPartial(string(buf))
				}
				return
			}
		case <-time.After(150 * time.Millisecond):
			if len(buf) > 0 {
				sess.setPartial(string(buf))
			}
		}
	}
}

func isBlockLine(line string) bool {
	plain := stripTerminal(line)
	return strings.ContainsAny(plain, "█▀▄")
}

func qrAllBlocks(line string) bool {
	return line != "" && strings.Trim(line, "█") == ""
}

func qrLikeLine(plain string) bool {
	if len(plain) < 15 {
		return false
	}
	for _, r := range plain {
		if r != '█' && r != '▀' && r != '▄' && r != ' ' {
			return false
		}
	}
	return strings.ContainsAny(plain, "█▀▄")
}

// skipEscape returns the index after the ANSI escape sequence starting at i.
// Unterminated sequences are dropped to the end of the chunk.
func skipEscape(s string, i int) int {
	j := i + 1
	if j >= len(s) {
		return j
	}
	switch s[j] {
	case '[':
		j++
		for j < len(s) {
			if s[j] >= 0x40 && s[j] <= 0x7e {
				return j + 1
			}
			j++
		}
		return j
	case ']':
		j++
		for j < len(s) {
			if s[j] == 0x07 {
				return j + 1
			}
			if s[j] == 0x1b && j+1 < len(s) && s[j+1] == '\\' {
				return j + 2
			}
			j++
		}
		return j
	default:
		return j + 1
	}
}

func stripTerminal(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		c := s[i]
		if c == 0x1b {
			i = skipEscape(s, i)
			continue
		}
		if c == '\r' || c == 0x07 {
			i++
			continue
		}
		if c >= 0x20 {
			b.WriteByte(c)
		}
		i++
	}
	return b.String()
}

// visualizeTerminalLine keeps half-block glyphs and turns color-coded blank
// cells (qrterminal draws white modules as background-coloured spaces) into
// visible blocks. The page renders the result white-on-black, so the QR keeps
// its original contrast. Cursor/erase sequences from the pseudo console are
// dropped.
func visualizeTerminalLine(line string) string {
	var b strings.Builder
	bgLight := false
	i := 0
	for i < len(line) {
		if line[i] == 0x1b {
			next := skipEscape(line, i)
			if i+1 < len(line) && line[i+1] == '[' && next-1 < len(line) && line[next-1] == 'm' {
				for _, p := range strings.Split(line[i+2:next-1], ";") {
					switch p {
					case "0", "":
						bgLight = false
					case "47", "107", "7":
						bgLight = true
					case "40", "100", "49":
						bgLight = false
					}
				}
			}
			i = next
			continue
		}
		switch line[i] {
		case ' ':
			if bgLight {
				b.WriteRune('█')
			} else {
				b.WriteByte(' ')
			}
		case '\r', 0x07:
		default:
			if line[i] >= 0x20 {
				b.WriteByte(line[i])
			}
		}
		i++
	}
	return strings.TrimRight(b.String(), " ")
}

func (f *Facade) StartLogin(kind string) (LoginStateDTO, error) {
	if kind != "qr" && kind != "code" {
		return LoginStateDTO{}, fmt.Errorf("不支持的登录方式")
	}
	exe := f.a.resolveTdl()
	if exe == "" {
		return LoginStateDTO{}, fmt.Errorf("未安装 tdl：请先在「账号」页安装 / 更新 tdl")
	}
	if isTdlRunning() {
		return LoginStateDTO{}, fmt.Errorf("检测到 tdl.exe 正在运行，请先结束它再登录")
	}
	f.mu.Lock()
	if f.op != nil {
		f.mu.Unlock()
		return LoginStateDTO{}, ErrOperationRunning
	}
	if f.login != nil && f.login.snapshot().State == "waiting" {
		f.mu.Unlock()
		return LoginStateDTO{}, fmt.Errorf("已有登录会话正在进行")
	}
	launcher := f.loginLaunch
	ctx, cancel := context.WithCancel(context.Background())
	sess := &loginSession{id: fmt.Sprintf("login-%d", time.Now().UnixNano()), kind: kind, state: "starting", cancel: cancel}
	f.login = sess
	f.mu.Unlock()

	args := append(f.a.tdlBaseArgs(), "login", "-T", kind)
	if launcher != nil {
		term, waitFn, lerr := launcher(ctx, exe, args)
		if lerr != nil {
			sess.setState("failed", lerr.Error())
			return sess.snapshot(), nil
		}
		sess.mu.Lock()
		sess.stdin = term
		sess.mu.Unlock()
		sess.setState("waiting", "")
		readDone := make(chan struct{})
		go func() {
			readLoginStream(term, sess)
			close(readDone)
		}()
		go func() {
			waitErr := waitFn()
			time.Sleep(150 * time.Millisecond)
			_ = term.Close()
			select {
			case <-readDone:
			case <-time.After(2 * time.Second):
			}
			finishLogin(sess, ctx, waitErr)
		}()
		return sess.snapshot(), nil
	}

	cmd := exec.CommandContext(ctx, exe, args...)
	in, err := cmd.StdinPipe()
	if err != nil {
		sess.setState("failed", err.Error())
		return sess.snapshot(), nil
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		sess.setState("failed", err.Error())
		return sess.snapshot(), nil
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		sess.setState("failed", err.Error())
		return sess.snapshot(), nil
	}
	if err := cmd.Start(); err != nil {
		sess.setState("failed", err.Error())
		return sess.snapshot(), nil
	}
	sess.mu.Lock()
	sess.stdin = in
	sess.mu.Unlock()

	scan := func(r io.Reader) { readLoginStream(r, sess) }
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); scan(stdout) }()
	go func() { defer wg.Done(); scan(stderr) }()
	sess.setState("waiting", "")
	go func() {
		wg.Wait()
		waitErr := cmd.Wait()
		finishLogin(sess, ctx, waitErr)
	}()
	return sess.snapshot(), nil
}

func finishLogin(sess *loginSession, ctx context.Context, waitErr error) {
	if ctx.Err() != nil {
		sess.setState("cancelled", "未完成登录，会话文件未被修改")
		return
	}
	if waitErr == nil && hasTdlSessionData() {
		sess.setState("success", "Telegram 已授权，会话已保存")
		return
	}
	msg := "登录未完成，会话文件未被修改"
	if waitErr != nil {
		msg = waitErr.Error()
	}
	if p := sess.snapshot().Prompt; p != "" {
		msg = msg + " · " + p
	}
	sess.setState("failed", msg)
}

func (f *Facade) LoginState(id string) LoginStateDTO {
	f.mu.Lock()
	sess := f.login
	f.mu.Unlock()
	if sess == nil || sess.id != id {
		return LoginStateDTO{ID: id, State: "missing"}
	}
	return sess.snapshot()
}

func (f *Facade) LoginInput(id, text string) error {
	f.mu.Lock()
	sess := f.login
	f.mu.Unlock()
	if sess == nil || sess.id != id {
		return fmt.Errorf("登录会话不存在")
	}
	sess.mu.Lock()
	in := sess.stdin
	trimmed := strings.TrimSpace(text)
	sess.inputAt = time.Now()
	sess.lastInput = trimmed
	sess.mu.Unlock()
	if in == nil {
		return fmt.Errorf("当前登录方式不需要输入")
	}
	_, err := io.WriteString(in, strings.TrimSpace(text)+"\n")
	return err
}

func (f *Facade) LoginCancel(id string) bool {
	f.mu.Lock()
	sess := f.login
	f.mu.Unlock()
	if sess == nil || sess.id != id {
		return false
	}
	sess.cancel()
	_ = killAllTdl()
	return true
}
