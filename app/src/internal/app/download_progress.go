package app

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"telegramarchivekit/internal/archive"
)

type downloadPlan struct {
	IDs        map[string]int64  // message id -> expected size when known
	Names      map[string]string // message id -> human-friendly source filename
	Total      int
	KnownBytes int64
	KnownCount int
}

func loadDownloadPlan(path string) (downloadPlan, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return downloadPlan{}, err
	}
	var root map[string]any
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.UseNumber()
	if err := dec.Decode(&root); err != nil {
		return downloadPlan{}, err
	}
	p := downloadPlan{IDs: map[string]int64{}, Names: map[string]string{}}
	arr, _ := root["messages"].([]any)
	for _, x := range arr {
		m, ok := x.(map[string]any)
		if !ok {
			continue
		}
		id := archive.AnyString(m["id"])
		if id == "" || !archive.MessageExpectsMedia(m, archive.AnyString(m["media_type"])) {
			continue
		}
		sz := archive.AnyInt64(m["file_size"])
		if _, seen := p.IDs[id]; !seen {
			p.Total++
		}
		p.IDs[id] = sz
		name := archive.FirstNonEmpty(archive.AnyString(m["file_name"]), archive.AnyString(m["file"]), archive.AnyString(m["photo"]))
		if name != "" {
			name = filepath.Base(filepath.FromSlash(name))
			if !strings.HasPrefix(name, "(") {
				p.Names[id] = name
			}
		}
		if sz > 0 {
			p.KnownBytes += sz
			p.KnownCount++
		}
	}
	return p, nil
}

var dlMsgRe = regexp.MustCompile(`\):(\d+)\s+->`)
var dlSpeedRe = regexp.MustCompile(`(?i)([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB)/s`)
var dlPercentRe = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)%`)
var dlTransferredRe = regexp.MustCompile(`(?i)\[([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB)\s+in `)
var dlETARe = regexp.MustCompile(`(?i)~ETA:\s*([^;\]]+)`)

type progressCapture struct {
	mu          sync.Mutex
	tail        string
	recent      []string
	done        map[string]bool
	doneBytes   map[string]int64
	active      map[string]bool
	speeds      map[string]float64
	transferred map[string]int64
	percents    map[string]float64
	lastMove    time.Time
	log         io.Writer
	rawTail     string
	taskStart   map[string]time.Time
	lastLine    map[string]string
	completed   []taskView
}

func newProgressCapture(log io.Writer) *progressCapture {
	return &progressCapture{
		done: map[string]bool{}, doneBytes: map[string]int64{}, active: map[string]bool{},
		speeds: map[string]float64{}, transferred: map[string]int64{}, percents: map[string]float64{},
		lastMove: time.Now(), log: log, taskStart: map[string]time.Time{}, lastLine: map[string]string{},
	}
}
func (c *progressCapture) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.log != nil {
		_, _ = c.log.Write(p)
	}
	c.rawTail += string(p)
	if len(c.rawTail) > 96*1024 {
		c.rawTail = c.rawTail[len(c.rawTail)-96*1024:]
	}
	s := c.tail + string(p)
	s = strings.ReplaceAll(s, "\r", "\n")
	parts := strings.Split(s, "\n")
	c.tail = parts[len(parts)-1]
	for _, line := range parts[:len(parts)-1] {
		c.consume(line)
	}
	// Long progress updates may arrive without newline. Surface them as a live snapshot.
	if len(c.tail) > 32 {
		c.consumeSnapshot(c.tail)
	}
	return len(p), nil
}
func (c *progressCapture) consumeSnapshot(line string) {
	clean := strings.TrimSpace(ansiRE.ReplaceAllString(line, ""))
	if clean == "" {
		return
	}
	if strings.Contains(clean, "->") {
		c.updateTask(clean, false)
	}
}
func (c *progressCapture) consume(line string) {
	clean := strings.TrimSpace(ansiRE.ReplaceAllString(line, ""))
	if clean == "" {
		return
	}
	if strings.Contains(clean, "->") {
		c.updateTask(clean, true)
	}
}

func (c *progressCapture) updateTask(clean string, keep bool) {
	m := dlMsgRe.FindStringSubmatch(clean)
	id := ""
	if len(m) == 2 {
		id = m[1]
	}
	if id != "" {
		if _, ok := c.taskStart[id]; !ok {
			c.taskStart[id] = time.Now()
		}
		c.lastLine[id] = clean
	}
	if strings.Contains(clean, "done!") && id != "" {
		if c.done[id] {
			return
		}
		c.done[id] = true
		c.lastMove = time.Now()
		if tm := dlTransferredRe.FindStringSubmatch(clean); len(tm) == 3 {
			c.doneBytes[id] = parseUnitNumber(tm[1], tm[2])
		}
		delete(c.active, id)
		delete(c.speeds, id)
		delete(c.transferred, id)
		delete(c.percents, id)
		elapsed := time.Since(c.taskStart[id])
		if elapsed < time.Second {
			elapsed = time.Second
		}
		c.completed = append(c.completed, taskView{ID: id, Done: true, Elapsed: formatDuration(elapsed), Name: "", Transferred: humanBytes(c.doneBytes[id]), Percent: "完成"})
		if len(c.completed) > 5 {
			c.completed = c.completed[len(c.completed)-5:]
		}
		delete(c.taskStart, id)
		delete(c.lastLine, id)
	} else if id != "" {
		c.active[id] = true
		if tm := dlTransferredRe.FindStringSubmatch(clean); len(tm) == 3 {
			v := parseUnitNumber(tm[1], tm[2])
			if v > c.transferred[id] {
				c.transferred[id] = v
				c.lastMove = time.Now()
			}
		}
		if pm := dlPercentRe.FindStringSubmatch(clean); len(pm) == 2 {
			if v, e := strconv.ParseFloat(pm[1], 64); e == nil && v > c.percents[id] {
				c.percents[id] = v
				c.lastMove = time.Now()
			}
		}
		if sm := dlSpeedRe.FindStringSubmatch(clean); len(sm) == 3 {
			if v, e := strconv.ParseFloat(sm[1], 64); e == nil {
				c.speeds[id] = v * unitBytes(sm[2])
			}
		}
	}
	if keep || len(c.recent) == 0 || c.recent[len(c.recent)-1] != clean {
		c.pushRecent(clean)
	}
}
func (c *progressCapture) pushRecent(s string) {
	if len(s) > 160 {
		s = s[:157] + "…"
	}
	c.recent = append(c.recent, s)
	if len(c.recent) > 5 {
		c.recent = c.recent[len(c.recent)-5:]
	}
}
func (c *progressCapture) snapshot() (map[string]bool, map[string]float64, []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	d := map[string]bool{}
	for k, v := range c.done {
		d[k] = v
	}
	sp := map[string]float64{}
	for k, v := range c.speeds {
		sp[k] = v
	}
	r := append([]string(nil), c.recent...)
	return d, sp, r
}
func (c *progressCapture) doneSizeSnapshot() map[string]int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := map[string]int64{}
	for k, v := range c.doneBytes {
		out[k] = v
	}
	return out
}

func (c *progressCapture) activeSnapshot() map[string]bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	a := map[string]bool{}
	for k, v := range c.active {
		a[k] = v
	}
	return a
}

func (c *progressCapture) rawSnapshot() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.rawTail
}

func (c *progressCapture) movementAge() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastMove.IsZero() {
		return 0
	}
	return time.Since(c.lastMove)
}

func (c *progressCapture) activeIDs() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.active))
	for id := range c.active {
		out = append(out, id)
	}
	return out
}

// dashboardTasks is a semantic snapshot: active tasks are separate from a
// bounded history of completed tasks. No raw tdl console line is shown in UI.
func (c *progressCapture) dashboardTasks(plan downloadPlan) (active, completed []taskView) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	ids := make([]string, 0, len(c.active))
	for id := range c.active {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		a, _ := strconv.ParseInt(ids[i], 10, 64)
		b, _ := strconv.ParseInt(ids[j], 10, 64)
		return a < b
	})
	for _, id := range ids {
		v := parseTdlTaskLine(c.lastLine[id], plan)
		if v.ID == "" {
			v.ID = id
		}
		if t, has := c.taskStart[id]; has {
			v.Elapsed = formatDuration(now.Sub(t))
		}
		if now.Sub(c.lastMove) > 3*time.Second {
			v.Speed = "0 B/s"
		}
		active = append(active, v)
	}
	for i := len(c.completed) - 1; i >= 0; i-- {
		v := c.completed[i]
		v.Name = plan.Names[v.ID]
		if v.Name == "" {
			v.Name = "媒体文件"
		}
		completed = append(completed, v)
	}
	return
}

func unitBytes(u string) float64 {
	switch strings.ToUpper(u) {
	case "GB":
		return 1024 * 1024 * 1024
	case "MB":
		return 1024 * 1024
	case "KB":
		return 1024
	default:
		return 1
	}
}

func (a *App) downloadExistingSnapshot(slug string, plan downloadPlan) (completed map[string]bool, bytes int64) {
	completed = map[string]bool{}
	totals := make(map[string][]int64, min(plan.Total, 4096))
	_ = filepath.WalkDir(a.mediaDir(slug), func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		base := d.Name()
		id := archive.MessageIDFromFilename(base)
		if _, wanted := plan.IDs[id]; !wanted {
			return nil
		}
		info, er := d.Info()
		if er != nil || info.Size() <= 0 {
			return nil
		}
		totals[id] = append(totals[id], info.Size())
		return nil
	})
	for id, files := range a.officialMediaByID(slug) {
		if _, wanted := plan.IDs[id]; !wanted {
			continue
		}
		for _, m := range files {
			if m.Size > 0 {
				totals[id] = append(totals[id], m.Size)
			}
		}
	}
	for id, expected := range plan.IDs {
		sizes := totals[id]
		var representative int64
		matched := false
		for _, sz := range sizes {
			if sz > representative {
				representative = sz
			}
			if expected > 0 && sz == expected {
				matched = true
			}
		}
		if expected > 0 {
			if matched {
				completed[id] = true
				bytes += expected
			}
		} else if representative > 0 {
			completed[id] = true
			bytes += representative
		}
	}
	return completed, bytes
}

func progressFromBaseline(plan downloadPlan, baseline map[string]bool, baselineBytes int64, parsedDone map[string]bool, parsedDoneBytes map[string]int64) (done int, bytes int64) {
	done = len(baseline)
	bytes = baselineBytes
	for id := range parsedDone {
		if baseline[id] {
			continue
		}
		done++
		if sz := parsedDoneBytes[id]; sz > 0 {
			bytes += sz
		} else if expected := plan.IDs[id]; expected > 0 {
			bytes += expected
		}
	}
	if done > plan.Total {
		done = plan.Total
	}
	return done, bytes
}

func (a *App) downloadProgressState(slug string, plan downloadPlan, parsedDone map[string]bool) (done int, bytes int64) {
	baseline, baselineBytes := a.downloadExistingSnapshot(slug, plan)
	return progressFromBaseline(plan, baseline, baselineBytes, parsedDone, nil)
}

func humanRate(v float64) string { return humanBytes(int64(v)) + "/s" }
func humanBytes(n int64) string {
	if n < 0 {
		n = 0
	}
	f := float64(n)
	u := []string{"B", "KB", "MB", "GB", "TB"}
	i := 0
	for f >= 1024 && i < len(u)-1 {
		f /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d %s", n, u[i])
	}
	if f >= 100 {
		return fmt.Sprintf("%.0f %s", f, u[i])
	}
	if f >= 10 {
		return fmt.Sprintf("%.1f %s", f, u[i])
	}
	return fmt.Sprintf("%.2f %s", f, u[i])
}
func progressBar(done, total, width int) string {
	if width < 10 {
		width = 10
	}
	if total <= 0 {
		return strings.Repeat("░", width)
	}
	f := float64(done) / float64(total)
	if f < 0 {
		f = 0
	}
	if f > 1 {
		f = 1
	}
	n := int(f*float64(width) + 0.5)
	return green(strings.Repeat("█", n)) + muted(strings.Repeat("░", width-n))
}

func compactProgressLines(lines []string, limit int) []string {
	if limit <= 0 {
		limit = 4
	}
	seen := map[string]bool{}
	var rev []string
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		key := line
		if m := dlMsgRe.FindStringSubmatch(line); len(m) == 2 {
			key = "msg:" + m[1]
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		rev = append(rev, line)
		if len(rev) >= limit {
			break
		}
	}
	out := make([]string, len(rev))
	for i := range rev {
		out[len(rev)-1-i] = rev[i]
	}
	return out
}

func estimateOverallETA(plan downloadPlan, done int, bytes int64, speed float64, elapsed time.Duration) time.Duration {
	if done <= 0 || plan.Total <= done || elapsed < 8*time.Second {
		return 0
	}
	// file_size coverage is often very high in Telegram JSON. Extrapolate the unknown
	// tail from the known average, then use smoothed aggregate throughput.
	if speed > 0 && plan.KnownCount > 0 && plan.KnownBytes > 0 {
		avg := float64(plan.KnownBytes) / float64(plan.KnownCount)
		estTotal := float64(plan.KnownBytes) + float64(plan.Total-plan.KnownCount)*avg
		remaining := estTotal - float64(bytes)
		if remaining > 0 {
			eta := time.Duration(remaining/speed) * time.Second
			if eta > 0 && eta < 30*24*time.Hour {
				return eta
			}
		}
	}
	// Fallback to completed-item cadence. This is less precise for mixed image/video
	// archives but still more useful than no estimate; UI marks it as approximate.
	if done >= 3 {
		perItem := elapsed / time.Duration(done)
		eta := perItem * time.Duration(plan.Total-done)
		if eta > 0 && eta < 30*24*time.Hour {
			return eta
		}
	}
	return 0
}

func parseUnitNumber(v, u string) int64 {
	f, _ := strconv.ParseFloat(v, 64)
	return int64(f * unitBytes(u))
}

type taskView struct {
	ID          string
	Name        string
	Percent     string
	Transferred string
	Speed       string
	ETA         string
	Elapsed     string
	Done        bool
}

func parseTdlTaskLine(line string, plan downloadPlan) taskView {
	clean := strings.TrimSpace(line)
	m := dlMsgRe.FindStringSubmatch(clean)
	if len(m) != 2 {
		return taskView{Name: truncatePlain(clean, 100)}
	}
	id := m[1]
	v := taskView{ID: id, Name: strings.TrimSpace(plan.Names[id]), Done: strings.Contains(clean, "done!")}
	if v.Name == "" {
		v.Name = "媒体文件"
	}
	if pm := dlPercentRe.FindStringSubmatch(clean); len(pm) == 2 {
		v.Percent = pm[1] + "%"
	}
	if tm := dlTransferredRe.FindStringSubmatch(clean); len(tm) == 3 {
		transferred := parseUnitNumber(tm[1], tm[2])
		if expected := plan.IDs[id]; expected > 0 {
			v.Transferred = humanBytes(transferred) + " / " + humanBytes(expected)
		} else {
			v.Transferred = humanBytes(transferred)
		}
	}
	if sm := dlSpeedRe.FindStringSubmatch(clean); len(sm) == 3 {
		n, _ := strconv.ParseFloat(sm[1], 64)
		rate := n * unitBytes(sm[2])
		if rate > 0 {
			v.Speed = humanRate(rate)
		}
	}
	if em := dlETARe.FindStringSubmatch(clean); len(em) == 2 {
		if d, err := time.ParseDuration(strings.TrimSpace(em[1])); err == nil {
			v.ETA = "剩余约 " + formatHumanDuration(d)
		}
	}
	return v
}

func formatTdlTaskLine(line string, plan downloadPlan) string {
	v := parseTdlTaskLine(line, plan)
	if v.ID == "" {
		return v.Name
	}
	parts := []string{"Message #" + v.ID}
	if v.Name != "" {
		parts = append(parts, v.Name)
	}
	if v.Percent != "" {
		parts = append(parts, v.Percent)
	}
	if v.Transferred != "" {
		parts = append(parts, v.Transferred)
	}
	if v.Speed != "" {
		parts = append(parts, v.Speed)
	}
	if v.ETA != "" {
		parts = append(parts, v.ETA)
	}
	if v.Done {
		parts = append(parts, "完成")
	}
	return strings.Join(parts, "  ·  ")
}

func renderTaskView(v taskView, inner int) []string {
	if v.ID == "" {
		return []string{"  " + truncatePlain(v.Name, inner-2)}
	}
	id := "Message #" + v.ID
	nameWidth := max(18, inner-visibleWidth(id)-5)
	line1 := "  " + cyan(id) + "  " + ansiWhite + truncatePlain(v.Name, nameWidth) + ansiReset

	progress := fallback(v.Percent, "—")
	amount := fallback(v.Transferred, "等待数据")
	speed := fallback(v.Speed, "0 B/s")
	eta := fallback(v.ETA, "—")
	if v.Done {
		progress = green("完成")
		speed = green("完成")
		eta = ""
	}
	statsLead := "  " + strings.Repeat(" ", min(12, visibleWidth(id)+1))
	line2 := statsLead +
		padVisible(progress, 10) + "  " +
		padVisible(amount, 24) + "  " +
		padVisible(speed, 13)
	if eta != "" {
		line2 += "  " + eta
	}
	return []string{line1, line2}
}

func (a *App) renderDownloadDashboard(chat string, pass int, plan downloadPlan, done int, bytes int64, speed float64, elapsed time.Duration, recent []string, effectiveConcurrent, effectiveThreads int) {
	a.renderDownloadDashboardState(chat, pass, plan, done, bytes, speed, elapsed, recent, "正在下载", "", 0, effectiveConcurrent, effectiveThreads)
}

// renderDownloadDashboardState renders a single in-place TUI frame. No output is
// appended to scrollback while the download is active.
func (a *App) renderDownloadDashboardState(chat string, pass int, plan downloadPlan, done int, bytes int64, speed float64, elapsed time.Duration, recent []string, state, detail string, retryIn time.Duration, effectiveConcurrent, effectiveThreads int) {
	a.renderDownloadDashboardDetailed(chat, pass, plan, done, bytes, speed, elapsed, state, detail, retryIn, effectiveConcurrent, effectiveThreads, nil, nil)
}

func (a *App) renderDownloadDashboardDetailed(chat string, pass int, plan downloadPlan, done int, bytes int64, speed float64, elapsed time.Duration, state, detail string, retryIn time.Duration, concurrent, threads int, active, completed []taskView) {
	inner := uiInnerWidth()
	lead := uiLeadFor(inner)
	width := inner - 4
	if width < 30 {
		width = 30
	}
	percent := 0.0
	if plan.Total > 0 {
		percent = 100 * float64(done) / float64(plan.Total)
	}
	var b strings.Builder
	b.WriteString(topFrame("媒体同步 · 第 "+fmt.Sprint(pass)+" 轮", chat))
	b.WriteString(lead + cyan("● ") + bold(state) + "   " + muted(fmt.Sprintf("本轮 %d 文件并发 / 每文件 %d 线程", concurrent, threads)) + "\n\n")
	b.WriteString(lead + bold("同步进度") + "\n")
	b.WriteString(lead + "  " + padVisible("归档完成", 12) + green(fmt.Sprintf("%d / %d", done, plan.Total)) + "    " + cyan(fmt.Sprintf("%.1f%%", percent)) + "\n")
	b.WriteString(lead + "  " + progressBar(done, plan.Total, inner-2) + "\n\n")
	b.WriteString(lead + "  " + kvText("本地已归档", humanBytes(bytes), 13) + "\n")
	b.WriteString(lead + "  " + kvText("已知媒体体积", humanBytes(plan.KnownBytes)+fmt.Sprintf("  (%d/%d 项含大小)", plan.KnownCount, plan.Total), 13) + "\n")
	b.WriteString(lead + "  " + kvText("当前总速度", cyan(humanRate(speed)), 13) + "\n")
	eta := time.Duration(0)
	if speed > 0 && done < plan.Total {
		eta = estimateOverallETA(plan, done, bytes, speed, elapsed)
	}
	etaText := "计算中"
	if eta > 0 {
		etaText = "≈ " + formatHumanDuration(eta)
	}
	b.WriteString(lead + "  " + kvText("已用时", formatDuration(elapsed), 13) + "    " + kvText("预计剩余", cyan(etaText), 9) + "\n")
	b.WriteString(lead + "  " + kvText("下载策略", fmt.Sprintf("普通会话 · %d 文件 × %d 线程", concurrent, threads), 13) + "\n")
	if concurrent == 1 && a.Settings.Concurrent > 1 {
		b.WriteString(lead + "  " + kvText("当前队列", yellow("仅剩单个疑难文件；暂时只有 1 个文件任务"), 13) + "\n")
	}
	if speed == 0 && state == "正在下载" {
		b.WriteString(lead + "  " + kvText("无进展保护", yellow(fmt.Sprintf("%d 秒后暂缓当前文件，继续队列", a.Settings.StallTimeoutSeconds)), 13) + "\n")
	}
	b.WriteString("\n")
	if detail != "" {
		b.WriteString("\n" + lead + yellow("! ") + truncatePlain(detail, inner-3) + "\n")
	}
	if retryIn > 0 {
		b.WriteString(lead + muted("下次重试：") + yellow(formatRetryDelay(retryIn)) + "\n")
	}

	// One user-visible section per concept, consistent fixed-width two-line task rows.
	b.WriteString("\n" + lead + bold("正在下载") + "   " + muted(fmt.Sprintf("%d 个活动任务", len(active))) + "\n")
	if len(active) == 0 {
		b.WriteString(lead + "  " + muted("暂无活动文件 · 正在准备或等待下一轮") + "\n")
	}
	for _, v := range active {
		id := "#" + v.ID
		name := fallback(v.Name, "媒体文件")
		b.WriteString(lead + "  " + cyan(padVisible(id, 8)) + " " + padVisible(truncatePlain(name, max(12, inner-17)), max(12, inner-17)) + "\n")
		detail1 := padVisible(fallback(v.Percent, "0%"), 8) + "  " + padVisible(fallback(v.Transferred, "等待数据"), 25) + "  " + padVisible(fallback(v.Speed, "0 B/s"), 13)
		b.WriteString(lead + "           " + detail1 + "\n")
		b.WriteString(lead + "           " + muted("耗时 "+fallback(v.Elapsed, "00:00")+" · "+fallback(v.ETA, "等待数据")) + "\n")
	}
	b.WriteString("\n" + lead + bold("最近完成") + "   " + muted(fmt.Sprintf("显示最近 %d 项", len(completed))) + "\n")
	if len(completed) == 0 {
		b.WriteString(lead + "  " + muted("本轮尚未完成新文件；历史完成数已计入上方总体进度") + "\n")
	}
	for _, v := range completed {
		name := truncatePlain(fallback(v.Name, "媒体文件"), max(16, inner-36))
		row := "  " + green("✓") + "  " + cyan(padVisible("#"+v.ID, 8)) + padVisible(name, max(16, inner-36)) + "  " + muted("完成耗时 "+fallback(v.Elapsed, "—"))
		b.WriteString(lead + row + "\n")
	}
	b.WriteString("\n")
	b.WriteString(lead + yellow("Esc") + "  中止   " + muted("已完成媒体不会删除 · 失败项会写入报告") + "\n")
	renderFrame(b.String())
}

func formatRetryDelay(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	return fmt.Sprintf("%ds", int(d.Round(time.Second).Seconds()))
}
func formatDuration(d time.Duration) string {
	d = d.Round(time.Second)
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	s := int(d.Seconds()) % 60
	if h > 0 {
		return fmt.Sprintf("%02d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%02d:%02d", m, s)
}
