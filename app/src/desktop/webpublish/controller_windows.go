package webpublish

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Controller uses the local manager only for configuration and discovery when
// the worker is stopped. Public listeners always belong to the worker.
type Controller struct {
	dir      string
	current  func() string
	idle     *Manager
	commands sync.Mutex
}

func NewController(dir string, current func() string) *Controller {
	return &Controller{dir: dir, current: current, idle: NewManager(dir, current, DiscoverWindows, func(on bool) error { return setWindowsStartup(dir, on) })}
}

func (c *Controller) Close() { c.idle.Close() }

func (c *Controller) Status(refresh bool) Status {
	if status, err := callWorker(c.dir, controlRequest{Action: "status"}); err == nil {
		return status
	}
	c.idle.reloadIdle()
	status := c.idle.Status(refresh)
	if c.pending() {
		status.Requested, status.Phase = true, "waiting"
		status.ControlLocked = true
		status.Message = "部署进程未连接。若自动恢复未能启动服务，可停止后重新启动。"
		if failure, err := os.ReadFile(failureMarker(c.dir)); err == nil && workerRequested(c.dir, string(failure)) {
			status.Message = "已达到故障重启上限。停止后可重新启动部署。"
		}
	}
	return status
}

func (c *Controller) Refresh() {
	if _, err := callWorker(c.dir, controlRequest{Action: "refresh"}); errors.Is(err, errWorkerOffline) {
		c.idle.signal()
	}
}

func (c *Controller) pending() bool {
	if !readConfig(c.idle.path).Resume {
		return false
	}
	_, err := os.Stat(workerMarker(c.dir))
	return err == nil
}

func (c *Controller) Requested() bool {
	return c.Status(false).Requested
}

func (c *Controller) HasAddress(address string) bool {
	for _, endpoint := range c.Status(false).Endpoints {
		if endpoint.URL != "" && endpoint.URL == address {
			return true
		}
	}
	return false
}

func (c *Controller) Save(cfg Config, start bool) error {
	c.commands.Lock()
	defer c.commands.Unlock()
	root := c.current()
	if _, err := callWorker(c.dir, controlRequest{Action: "save", Config: cfg, Library: root}); !errors.Is(err, errWorkerOffline) {
		return err
	}
	if c.pending() {
		return errors.New("请先停止当前部署，再修改设置或重新启动")
	}
	c.idle.reloadIdle()
	if !start {
		return c.idle.Save(cfg, false)
	}
	if err := c.idle.save(cfg, true, true); err != nil {
		return err
	}
	token, err := startWorkerRun(c.dir)
	if err != nil {
		_ = c.idle.Stop()
		return err
	}
	if err := launchWorker(c.dir, token, readConfig(c.idle.path).Config); err != nil {
		_ = stopWorkerRun(c.dir)
		_ = c.idle.Stop()
		return fmt.Errorf("无法启动部署后台进程：%w", err)
	}
	// The pipe is opened before NAS and network discovery. Wait for that handoff
	// so an immediate exit can still stop the worker reliably.
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := callWorker(c.dir, controlRequest{Action: "status"}); err == nil {
			return nil
		}
		time.Sleep(80 * time.Millisecond)
	}
	return nil
}

func (c *Controller) Stop() error {
	c.commands.Lock()
	defer c.commands.Unlock()
	_, err := callWorker(c.dir, controlRequest{Action: "stop"})
	if err == nil {
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := callWorker(c.dir, controlRequest{Action: "status"}); errors.Is(err, errWorkerOffline) {
				break
			}
			time.Sleep(60 * time.Millisecond)
		}
		return nil
	}
	if !errors.Is(err, errWorkerOffline) {
		return err
	}
	c.idle.reloadIdle()
	if err := c.idle.Stop(); err != nil {
		return err
	}
	return stopWorkerRun(c.dir)
}

func (c *Controller) SwitchLibrary(change func() error) error {
	c.commands.Lock()
	defer c.commands.Unlock()
	if c.Requested() {
		return errors.New("请先停止网页部署，再切换档案库")
	}
	return c.idle.SwitchLibrary(change)
}

func (c *Controller) Quit() error {
	c.commands.Lock()
	defer c.commands.Unlock()
	saved := readConfig(filepath.Join(c.dir, "web-publication.json"))
	if saved.KeepOnExit || !saved.Resume {
		return nil
	}
	_, err := callWorker(c.dir, controlRequest{Action: "close"})
	if !errors.Is(err, errWorkerOffline) {
		return err
	}
	if c.pending() {
		// Revoke the current run while preserving the next sign-in intent.
		return stopWorkerRun(c.dir)
	}
	return nil
}
