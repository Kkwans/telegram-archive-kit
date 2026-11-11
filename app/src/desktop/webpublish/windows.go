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
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func DiscoverWindows(ctx context.Context) Network {
	var out Network
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		out.Adapters, out.LANError = privateAdapters(ctx)
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

const privateNetworksScript = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$profiles=@(Get-NetConnectionProfile | Where-Object NetworkCategory -eq Private)
$adapters=@(Get-NetAdapter -IncludeHidden)
$result=@(foreach($p in $profiles){
  $a=$adapters | Where-Object { $_.ifIndex -eq $p.InterfaceIndex } | Select-Object -First 1
  if(!$a -or !$a.InterfaceGuid -or $a.Status -ne 'Up'){continue}
  foreach($ip in @(Get-NetIPAddress -InterfaceIndex $p.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue)){
    if($ip.AddressState -eq 'Preferred' -and !$ip.SkipAsSource){
      [pscustomobject]@{id=$a.InterfaceGuid.ToString();name=$p.InterfaceAlias;ip=$ip.IPAddress;bits=$ip.PrefixLength}
    }
  }
})
ConvertTo-Json -InputObject $result -Compress`

func privateAdapters(ctx context.Context) ([]Adapter, string) {
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	b, err := hiddenOutput(ctx, ps, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", privateNetworksScript)
	if err != nil {
		return nil, "无法读取 Windows 网络配置，请重新检测"
	}
	var rows []struct {
		ID, Name, IP string
		Bits         int
	}
	if json.Unmarshal(b, &rows) != nil {
		return nil, "无法识别 Windows 网络配置"
	}
	result := []Adapter{}
	for _, row := range rows {
		ip, err := netip.ParseAddr(row.IP)
		if err != nil || !ip.Is4() || !ip.IsPrivate() || row.Bits < 8 || row.Bits > 32 || row.ID == "" {
			continue
		}
		result = append(result, Adapter{ID: row.ID, Name: row.Name, IP: ip.String(), LAN: netip.PrefixFrom(ip, row.Bits).Masked()})
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Name == result[j].Name {
			return result[i].IP < result[j].IP
		}
		return result[i].Name < result[j].Name
	})
	// One address per adapter makes a DHCP change retain its selection.
	seen := map[string]bool{}
	unique := result[:0]
	for _, adapter := range result {
		if !seen[adapter.ID] {
			seen[adapter.ID] = true
			unique = append(unique, adapter)
		}
	}
	if len(unique) == 0 {
		return nil, "没有可用的 Windows 专用网络 IPv4 地址"
	}
	return unique, ""
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
