//go:build windows

package main

import (
	"context"
	"fmt"
	"io"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// conptySession runs tdl on a Windows pseudo console. tdl's interactive prompts
// (phone, code, 2FA) use a terminal UI library and fail on plain pipes, so the
// desktop client needs a real console underneath while rendering the mirror in
// the app window.
type conptySession struct {
	in         windows.Handle // write side: our input to the console
	out        windows.Handle // read side: console output
	consoleIn  windows.Handle // pipe end passed to CreatePseudoConsole
	consoleOut windows.Handle
	hpc        windows.Handle
	pi         windows.ProcessInformation
	once       sync.Once
}

func (c *conptySession) Read(p []byte) (int, error) {
	var n uint32
	err := windows.ReadFile(c.out, p, &n, nil)
	if err != nil {
		return 0, err
	}
	if n == 0 {
		return 0, io.EOF
	}
	return int(n), nil
}

func (c *conptySession) Write(p []byte) (int, error) {
	var n uint32
	if err := windows.WriteFile(c.in, p, &n, nil); err != nil {
		return int(n), err
	}
	return int(n), nil
}

func (c *conptySession) Close() error {
	c.once.Do(func() {
		if c.hpc != 0 {
			windows.ClosePseudoConsole(c.hpc)
		}
		if c.in != 0 {
			windows.CloseHandle(c.in)
		}
		if c.out != 0 {
			windows.CloseHandle(c.out)
		}
		if c.consoleIn != 0 {
			windows.CloseHandle(c.consoleIn)
		}
		if c.consoleOut != 0 {
			windows.CloseHandle(c.consoleOut)
		}
		if c.pi.Process != 0 {
			windows.CloseHandle(c.pi.Process)
		}
	})
	return nil
}

// newConPTYLauncher returns a factory compatible with app.Facade.SetLoginLauncher.
func newConPTYLauncher() func(ctx context.Context, exe string, args []string) (io.ReadWriteCloser, func() error, error) {
	return func(ctx context.Context, exe string, args []string) (io.ReadWriteCloser, func() error, error) {
		var sa windows.SecurityAttributes
		sa.Length = uint32(unsafe.Sizeof(sa))

		var inRead, inWrite, outRead, outWrite windows.Handle
		if err := windows.CreatePipe(&inRead, &inWrite, &sa, 0); err != nil {
			return nil, nil, fmt.Errorf("创建控制台输入管道失败: %w", err)
		}
		fail := func(err error) (io.ReadWriteCloser, func() error, error) {
			for _, h := range []windows.Handle{inRead, inWrite, outRead, outWrite} {
				if h != 0 {
					windows.CloseHandle(h)
				}
			}
			return nil, nil, err
		}
		if err := windows.CreatePipe(&outRead, &outWrite, &sa, 0); err != nil {
			windows.CloseHandle(inRead)
			windows.CloseHandle(inWrite)
			return nil, nil, fmt.Errorf("创建控制台输出管道失败: %w", err)
		}

		var hpc windows.Handle
		if err := windows.CreatePseudoConsole(windows.Coord{X: 140, Y: 50}, inRead, outWrite, 0, &hpc); err != nil {
			return fail(fmt.Errorf("创建伪控制台失败: %w", err))
		}

		attrs, err := windows.NewProcThreadAttributeList(1)
		if err != nil {
			windows.ClosePseudoConsole(hpc)
			return fail(fmt.Errorf("初始化进程属性失败: %w", err))
		}
		defer attrs.Delete()
		// UpdateProcThreadAttribute wants the HPCON value itself as lpValue, not
		// a pointer to it; x/sys's typed wrapper cannot express that, so call the
		// API directly.
		updateProc := windows.NewLazySystemDLL("kernel32.dll").NewProc("UpdateProcThreadAttribute")
		ret, _, callErr := updateProc.Call(
			uintptr(unsafe.Pointer(attrs.List())),
			0,
			uintptr(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE),
			uintptr(hpc),
			unsafe.Sizeof(hpc),
			0,
			0,
		)
		if ret == 0 {
			windows.ClosePseudoConsole(hpc)
			return fail(fmt.Errorf("绑定伪控制台失败: %v", callErr))
		}

		si := &windows.StartupInfoEx{
			StartupInfo:             windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfoEx{}))},
			ProcThreadAttributeList: attrs.List(),
		}
		si.StartupInfo.Flags |= windows.STARTF_USESTDHANDLES
		exe16, err := windows.UTF16PtrFromString(exe)
		if err != nil {
			windows.ClosePseudoConsole(hpc)
			return fail(fmt.Errorf("无效的 tdl 路径: %w", err))
		}
		cmdline := windows.ComposeCommandLine(append([]string{exe}, args...))
		cmd16, err := windows.UTF16PtrFromString(cmdline)
		if err != nil {
			windows.ClosePseudoConsole(hpc)
			return fail(fmt.Errorf("无效的命令行: %w", err))
		}
		var pi windows.ProcessInformation
		if err := windows.CreateProcess(exe16, cmd16, nil, nil, false, windows.EXTENDED_STARTUPINFO_PRESENT, nil, nil, &si.StartupInfo, &pi); err != nil {
			windows.ClosePseudoConsole(hpc)
			return fail(fmt.Errorf("启动 tdl 失败: %w", err))
		}
		// The pseudo console keeps using these ends for the process lifetime.
		windows.CloseHandle(pi.Thread)

		c := &conptySession{in: inWrite, out: outRead, consoleIn: inRead, consoleOut: outWrite, hpc: hpc, pi: pi}
		go func() {
			<-ctx.Done()
			_ = windows.TerminateProcess(pi.Process, 1)
		}()
		waitFn := func() error {
			_, _ = windows.WaitForSingleObject(pi.Process, windows.INFINITE)
			var code uint32
			_ = windows.GetExitCodeProcess(pi.Process, &code)
			if code != 0 {
				return fmt.Errorf("tdl 退出码 %d", code)
			}
			return nil
		}
		return c, waitFn, nil
	}
}
