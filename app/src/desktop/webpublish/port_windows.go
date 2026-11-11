package webpublish

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	getTCPTable       = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")
	isProcessCritical = windows.NewLazySystemDLL("kernel32.dll").NewProc("IsProcessCritical")
)

type PortOwner struct {
	PID       uint32   `json:"pid"`
	Name      string   `json:"name"`
	Path      string   `json:"path,omitempty"`
	Started   string   `json:"started,omitempty"`
	Addresses []string `json:"addresses"`
	CanEnd    bool     `json:"canEnd"`
	Reason    string   `json:"reason,omitempty"`
}

func CheckPort(port int) ([]PortOwner, error) {
	listeners, err := portListeners(port)
	if err != nil {
		return nil, err
	}
	owners := make([]PortOwner, 0, len(listeners))
	for pid, addresses := range listeners {
		owner := PortOwner{PID: pid, Name: "未知程序", Addresses: addresses, Reason: "无法读取程序信息"}
		if pid <= 4 {
			owner.Name, owner.Reason = "Windows 系统", "系统进程"
			owners = append(owners, owner)
			continue
		}
		if handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid); err == nil {
			owner = inspectPortOwner(handle, owner)
			windows.CloseHandle(handle)
		}
		if owner.CanEnd {
			handle, err := openForTermination(pid)
			if err != nil {
				owner.CanEnd, owner.Reason = false, "当前用户没有结束此程序的权限"
			} else {
				windows.CloseHandle(handle)
			}
		}
		owners = append(owners, owner)
	}
	slices.SortFunc(owners, func(a, b PortOwner) int {
		if a.PID < b.PID {
			return -1
		}
		if a.PID > b.PID {
			return 1
		}
		return 0
	})
	return owners, nil
}

func EndPortOwner(port int, pid uint32, started string) error {
	if port < 1 || port > 65535 || pid <= 4 || started == "" {
		return errors.New("请重新检查端口并选择要结束的程序")
	}
	handle, err := openForTermination(pid)
	if err != nil {
		return fmt.Errorf("无法打开进程 PID %d：%w", pid, err)
	}
	defer windows.CloseHandle(handle)
	owner := inspectPortOwner(handle, PortOwner{PID: pid, Reason: "无法读取程序信息"})
	if owner.Started != started {
		return errors.New("该进程已退出或更换，请重新检查端口")
	}
	if !owner.CanEnd {
		return errors.New(owner.Reason)
	}
	listeners, err := portListeners(port)
	if err != nil {
		return err
	}
	if len(listeners[pid]) == 0 {
		return errors.New("该程序已停止监听此端口")
	}
	if err := windows.TerminateProcess(handle, 1); err != nil {
		return fmt.Errorf("无法结束 %s：%w", owner.Name, err)
	}
	if state, err := windows.WaitForSingleObject(handle, 2500); err != nil || state != windows.WAIT_OBJECT_0 {
		return fmt.Errorf("%s 正在退出，请重新检查端口", owner.Name)
	}
	return nil
}

func openForTermination(pid uint32) (windows.Handle, error) {
	return windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
}

func inspectPortOwner(handle windows.Handle, owner PortOwner) PortOwner {
	path := make([]uint16, 32768)
	size := uint32(len(path))
	if windows.QueryFullProcessImageName(handle, 0, &path[0], &size) != nil || size == 0 {
		return owner
	}
	owner.Path = windows.UTF16ToString(path[:size])
	owner.Name = filepath.Base(owner.Path)
	var created, exited, kernel, user windows.Filetime
	if windows.GetProcessTimes(handle, &created, &exited, &kernel, &user) != nil {
		return owner
	}
	owner.Started = strconv.FormatUint(uint64(created.HighDateTime)<<32|uint64(created.LowDateTime), 10)
	executable, _ := os.Executable()
	switch {
	case owner.PID == uint32(os.Getpid()), strings.EqualFold(owner.Path, executable),
		strings.EqualFold(owner.Name, "TelegramArchiveKit.exe"), strings.EqualFold(owner.Name, "TelegramArchiveKit-Console.exe"):
		owner.Reason = "当前应用或部署进程"
		return owner
	}
	systemRoot, err := windows.GetWindowsDirectory()
	relative, relErr := filepath.Rel(systemRoot, owner.Path)
	if err != nil || (relErr == nil && relative != ".." && !strings.HasPrefix(relative, `..\`)) {
		owner.Reason = "Windows 系统程序"
		return owner
	}
	var critical int32
	ok, _, _ := isProcessCritical.Call(uintptr(handle), uintptr(unsafe.Pointer(&critical)))
	if ok == 0 || critical != 0 {
		owner.Reason = "Windows 受保护进程"
		return owner
	}
	var token windows.Token
	if windows.OpenProcessToken(handle, windows.TOKEN_QUERY, &token) != nil {
		return owner
	}
	defer token.Close()
	targetUser, targetErr := token.GetTokenUser()
	currentUser, currentErr := windows.GetCurrentProcessToken().GetTokenUser()
	if targetErr != nil || currentErr != nil || !windows.EqualSid(targetUser.User.Sid, currentUser.User.Sid) {
		owner.Reason = "其他 Windows 用户的进程"
		return owner
	}
	owner.CanEnd, owner.Reason = true, ""
	return owner
}

func portListeners(port int) (map[uint32][]string, error) {
	if port < 1 || port > 65535 {
		return nil, errors.New("端口须在 1 到 65535 之间")
	}
	listeners := make(map[uint32][]string)
	for _, family := range []uint32{windows.AF_INET, windows.AF_INET6} {
		table, err := tcpListenerTable(family)
		if err != nil {
			return nil, fmt.Errorf("无法读取 Windows TCP 监听列表：%w", err)
		}
		rowSize, portOffset, pidOffset := 24, 8, 20
		if family == windows.AF_INET6 {
			rowSize, portOffset, pidOffset = 56, 20, 52
		}
		count := int(binary.LittleEndian.Uint32(table))
		if count > (len(table)-4)/rowSize {
			return nil, errors.New("Windows 返回了不完整的 TCP 监听列表")
		}
		for row := range slices.Chunk(table[4:4+count*rowSize], rowSize) {
			if int(binary.BigEndian.Uint16(row[portOffset:])) != port {
				continue
			}
			address := netip.AddrFrom4([4]byte(row[4:8]))
			if family == windows.AF_INET6 {
				address = netip.AddrFrom16([16]byte(row[:16]))
				if scope := binary.LittleEndian.Uint32(row[16:]); scope != 0 {
					address = address.WithZone(strconv.FormatUint(uint64(scope), 10))
				}
			}
			pid := binary.LittleEndian.Uint32(row[pidOffset:])
			listeners[pid] = append(listeners[pid], netip.AddrPortFrom(address, uint16(port)).String())
		}
	}
	for pid, addresses := range listeners {
		slices.Sort(addresses)
		listeners[pid] = slices.Compact(addresses)
	}
	return listeners, nil
}

func tcpListenerTable(family uint32) ([]byte, error) {
	// TCP_TABLE_OWNER_PID_LISTENER is class 3. Windows reports the required buffer size on overflow.
	size := uint32(16384)
	for range 4 {
		if size < 4 || size > 16<<20 {
			break
		}
		table := make([]byte, size)
		code, _, _ := getTCPTable.Call(uintptr(unsafe.Pointer(&table[0])), uintptr(unsafe.Pointer(&size)), 0, uintptr(family), 3, 0)
		switch windows.Errno(code) {
		case 0:
			if size >= 4 && int(size) <= len(table) {
				return table[:size], nil
			}
			return nil, errors.New("TCP 监听列表大小无效")
		case windows.ERROR_INSUFFICIENT_BUFFER:
			continue
		default:
			return nil, windows.Errno(code)
		}
	}
	return nil, errors.New("TCP 监听列表正在变化，请重试")
}
