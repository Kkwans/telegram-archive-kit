package app

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"telegramarchivekit/internal/transfer"
)

type OperationProgress struct {
	Stage   string
	Detail  string
	Current int64
	Total   int64
	Unit    string
}

type operationResult struct{ err error }

func runOperation(title, subtitle, initial string, fn func(context.Context, func(OperationProgress)) error) error {
	legacyFrameActive = false
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	updates := make(chan OperationProgress, 32)
	result := make(chan operationResult, 1)
	started := time.Now()
	current := OperationProgress{Stage: initial}
	go func() {
		err := fn(ctx, func(p OperationProgress) {
			select {
			case updates <- p:
			default:
				// UI updates are lossy by design; the latest state matters, not every tick.
				select {
				case <-updates:
				default:
				}
				select {
				case updates <- p:
				default:
				}
			}
		})
		result <- operationResult{err: err}
	}()
	spinner := []string{"◐", "◓", "◑", "◒"}
	tick := time.NewTicker(140 * time.Millisecond)
	defer tick.Stop()
	idx := 0
	for {
		select {
		case p := <-updates:
			current = p
		case r := <-result:
			return r.err
		case <-tick.C:
			renderOperationFrame(title, subtitle, current, time.Since(started), spinner[idx%len(spinner)])
			idx++
		default:
			if k, ok := pollKey(45 * time.Millisecond); ok && k.Code == keyEsc {
				cancel()
				// Keep the user informed while the worker unwinds / closes its current file.
				current.Stage = "正在安全停止…"
				current.Detail = "已完成数据会保留；正在关闭当前操作"
				for {
					select {
					case r := <-result:
						if r.err == nil || r.err == context.Canceled {
							return transfer.ErrCancelled
						}
						return r.err
					case p := <-updates:
						current = p
					case <-time.After(120 * time.Millisecond):
						renderOperationFrame(title, subtitle, current, time.Since(started), yellow("◌"))
					}
				}
			}
		}
	}
}

func renderOperationFrame(title, subtitle string, p OperationProgress, elapsed time.Duration, spin string) {
	inner := uiInnerWidth()
	lead := uiLeadFor(inner)
	var b strings.Builder
	b.WriteString(topFrame(title, subtitle))
	b.WriteString(lead + "  " + cyan(spin) + "  " + bold(fallback(strings.TrimSpace(p.Stage), "正在处理")) + "\n")
	if strings.TrimSpace(p.Detail) != "" {
		b.WriteString(lead + "     " + muted(truncatePlain(p.Detail, inner-7)) + "\n")
	}
	if p.Total > 0 {
		pct := float64(p.Current) * 100 / float64(p.Total)
		b.WriteString("\n")
		b.WriteString(lead + "  " + progressBar(int(p.Current), int(p.Total), min(72, max(24, inner-28))) + "  " + cyan(fmt.Sprintf("%5.1f%%", pct)) + "\n")
		unit := strings.TrimSpace(p.Unit)
		if unit == "" {
			unit = "项"
		}
		b.WriteString(lead + "     " + muted(fmt.Sprintf("%d / %d %s", p.Current, p.Total, unit)) + "\n")
	}
	b.WriteString("\n" + lead + "  " + muted("已用时  ") + formatDuration(elapsed) + "\n")
	b.WriteString("\n" + lead + muted("  Esc 取消 · 已完成数据不会回滚") + "\n")
	renderFrame(b.String())
}

func runDirectoryTransferUI(title, subtitle, src, dst string, move bool) (transfer.Result, error) {
	var final transfer.Result
	var latest transfer.Progress
	started := time.Now()
	err := runOperation(title, subtitle, "准备文件迁移", func(ctx context.Context, update func(OperationProgress)) error {
		res, err := transfer.DirIncremental(ctx, src, dst, move, func(tp transfer.Progress) {
			latest = tp
			detail := tp.Current
			if detail != "" {
				detail = filepath.ToSlash(detail)
			}
			if tp.Stage == "正在扫描源目录" {
				update(OperationProgress{Stage: tp.Stage, Detail: fmt.Sprintf("已扫描 %d 个文件 · 当前累计 %s · %s", tp.FilesDone, humanBytes(tp.BytesDone), detail)})
				return
			}
			if tp.BytesTotal > 0 {
				eta := transfer.ETA(tp)
				extra := fmt.Sprintf("%d/%d 文件 · %s / %s · %s", tp.FilesDone, tp.FilesTotal, humanBytes(tp.BytesDone), humanBytes(tp.BytesTotal), humanRate(transfer.Speed(tp)))
				if eta > 0 {
					extra += " · 预计剩余 " + formatHumanDuration(eta)
				}
				if detail != "" {
					extra += " · " + detail
				}
				update(OperationProgress{Stage: tp.Stage, Detail: extra, Current: tp.BytesDone, Total: tp.BytesTotal, Unit: "字节"})
			} else {
				update(OperationProgress{Stage: tp.Stage, Detail: detail, Current: int64(tp.FilesDone), Total: int64(tp.FilesTotal), Unit: "文件"})
			}
		})
		final = res
		return err
	})
	_ = latest
	_ = started
	return final, err
}

func formatHumanDuration(d time.Duration) string {
	if d <= 0 {
		return "--"
	}
	d = d.Round(time.Second)
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	s := int(d.Seconds()) % 60
	if h > 0 {
		return fmt.Sprintf("%d小时%02d分", h, m)
	}
	if m > 0 {
		return fmt.Sprintf("%d分%02d秒", m, s)
	}
	return fmt.Sprintf("%d秒", s)
}

func (a *App) buildWorkspaceInteractive(slug, chatName string) (*Archive, error) {
	var arc *Archive
	err := runOperation("构建归档页面", chatName, "正在生成可浏览时间线", func(ctx context.Context, update func(OperationProgress)) error {
		update(OperationProgress{Stage: "正在整理消息与媒体索引", Detail: "生成 messages*.html、搜索索引和完整性报告"})
		var er error
		arc, er = a.buildWorkspaceModeWithProgressCtx(ctx, slug, true, update)
		if er == nil && arc != nil {
			update(OperationProgress{Stage: "构建完成", Detail: fmt.Sprintf("%d 条消息 · %d 个媒体 · 缺失媒体 %d · 待补封面：图片 %d / 视频 %d", arc.Stats.Messages, arc.Stats.MediaFiles, arc.Stats.MissingMedia, arc.Stats.MissingImagePreviews, arc.Stats.MissingVideoPreviews)})
		}
		return er
	})
	return arc, err
}

func (a *App) buildLibraryInteractive(subtitle string) error {
	return runOperation("刷新归档库", subtitle, "正在更新多聊天导航", func(ctx context.Context, update func(OperationProgress)) error {
		update(OperationProgress{Stage: "正在更新 Library 导航与统计", Detail: a.Settings.LibraryRoot})
		return a.buildLibrary()
	})
}
