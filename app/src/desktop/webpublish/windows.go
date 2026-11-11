//go:build windows

package webpublish

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func DiscoverWindows(ctx context.Context) Network {
	var out Network
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		out.Adapters, out.LANError = localAdapters()
	}()
	go func() {
		defer wg.Done()
		out.TailIPs, out.TailError = tailscaleAddresses(ctx)
	}()
	wg.Wait()
	return out
}

func hiddenOutput(ctx context.Context, exe string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Output()
}

func localAdapters() ([]Adapter, string) {
	var size uint32 = 15 << 10
	var buf []byte
	for range 4 {
		if size == 0 || size > 1<<20 {
			return nil, "无法读取本机网卡"
		}
		buf = make([]byte, size)
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, windows.GAA_FLAG_SKIP_ANYCAST|windows.GAA_FLAG_SKIP_MULTICAST|windows.GAA_FLAG_SKIP_DNS_SERVER, 0, (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])), &size)
		switch err {
		case nil:
			return readLocalAdapters(buf)
		case windows.ERROR_BUFFER_OVERFLOW:
		default:
			return nil, "无法读取本机网卡"
		}
	}
	return nil, "无法读取本机网卡"
}

func readLocalAdapters(buf []byte) ([]Adapter, string) {
	result := []Adapter{}
	for a := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])); a != nil; a = a.Next {
		if a.OperStatus != windows.IfOperStatusUp || (a.IfType != windows.IF_TYPE_ETHERNET_CSMACD && a.IfType != windows.IF_TYPE_IEEE80211) {
			continue
		}
		// HardwareInterface is the first bit in MIB_IF_ROW2. A VPN and
		// other virtual interfaces do not participate in automatic LAN access.
		row := windows.MibIfRow2{InterfaceLuid: a.Luid}
		if windows.GetIfEntry2Ex(windows.MibIfEntryNormalWithoutStatistics, &row) != nil || row.InterfaceAndOperStatusFlags&1 == 0 {
			continue
		}
		adapter := Adapter{ID: strings.Trim(windows.BytePtrToString(a.AdapterName), "{}"), Name: windows.UTF16PtrToString(a.FriendlyName)}
		var life4, life6 uint32
		for u := a.FirstUnicastAddress; u != nil; u = u.Next {
			if u.DadState != windows.IpDadStatePreferred {
				continue
			}
			ip, ok := netip.AddrFromSlice(u.Address.IP())
			if !ok {
				continue
			}
			ip = ip.Unmap()
			bits := int(u.OnLinkPrefixLength)
			prefix := netip.PrefixFrom(ip, bits).Masked()
			if ip.Is4() && ip.IsPrivate() && bits >= 8 && prefix.IsValid() && (adapter.IP == "" || u.PreferredLifetime > life4) {
				adapter.IP, adapter.LAN, life4 = ip.String(), prefix, u.PreferredLifetime
			}
			// Link-local IPv6 requires a zone identifier, which cannot be
			// shared as a usable browser URL across different devices.
			if ip.Is6() && ip.IsGlobalUnicast() && !tailV6.Contains(ip) && bits >= 48 && bits < 128 && prefix.IsValid() && (adapter.IPv6 == "" || u.PreferredLifetime > life6) {
				adapter.IPv6, adapter.LAN6, life6 = ip.String(), prefix, u.PreferredLifetime
			}
		}
		if adapter.ID != "" && (adapter.IP != "" || adapter.IPv6 != "") {
			result = append(result, adapter)
		}
	}
	runtime.KeepAlive(buf)
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	if len(result) == 0 {
		return nil, "没有找到已连接且可用于部署的 Wi-Fi 或以太网网卡"
	}
	return result, ""
}

func tailscaleAddresses(ctx context.Context) ([]netip.Addr, string) {
	exe, err := exec.LookPath("tailscale.exe")
	if err != nil {
		exe = filepath.Join(os.Getenv("ProgramFiles"), "Tailscale", "tailscale.exe")
		if _, err = os.Stat(exe); err != nil {
			return nil, "未检测到 Tailscale 客户端"
		}
	}
	b, err := hiddenOutput(ctx, exe, "status", "--json", "--peers=false")
	if err != nil {
		return nil, "无法读取 Tailscale 状态，请检查客户端是否已连接"
	}
	var state struct {
		BackendState string
		Self         struct{ TailscaleIPs []string }
	}
	if json.Unmarshal(b, &state) != nil || state.BackendState != "Running" {
		return nil, "Tailscale 尚未连接"
	}
	local := map[netip.Addr]bool{}
	ifaces, _ := net.Interfaces()
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		addresses, _ := iface.Addrs()
		for _, addr := range addresses {
			if ip, err := netip.ParsePrefix(addr.String()); err == nil {
				local[ip.Addr().Unmap()] = true
			}
		}
	}
	var result []netip.Addr
	for _, address := range state.Self.TailscaleIPs {
		ip, err := netip.ParseAddr(address)
		if err == nil && local[ip] && (tailV4.Contains(ip) || tailV6.Contains(ip)) {
			result = append(result, ip)
		}
	}
	if len(result) == 0 {
		return nil, "Tailscale 正在等待本机网卡地址"
	}
	return result, ""
}

const startupName = "TelegramArchiveKit.WebPublication"

func setWindowsStartup(dir string, enabled bool) error {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	if !enabled {
		if err := key.DeleteValue(startupName); err != nil && err != registry.ErrNotExist {
			return err
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	command := windows.EscapeArg(exe) + " --restore-web-publication " + windows.EscapeArg(dir)
	if len([]rune(command)) > 260 || strings.ContainsRune(exe, '"') {
		return fmt.Errorf("程序路径太长，无法写入登录启动项")
	}
	return key.SetStringValue(startupName, command)
}
