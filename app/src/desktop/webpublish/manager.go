package webpublish

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Scope            Scope  `json:"scope"`
	Adapter          string `json:"adapter"`
	Tailscale        bool   `json:"tailscale"`
	Port             int    `json:"port"`
	Auto             bool   `json:"auto"`
	KeepOnExit       bool   `json:"keepOnExit"`
	RestartOnFailure bool   `json:"restartOnFailure"`
	RestartLimit     int    `json:"restartLimit"`
}

type savedConfig struct {
	Config
	Library string `json:"library"`
	Resume  bool   `json:"resume"`
}

type Adapter struct {
	ID   string       `json:"id"`
	Name string       `json:"name"`
	IP   string       `json:"ip"`
	LAN  netip.Prefix `json:"-"`
}

type Network struct {
	Adapters  []Adapter
	TailIPs   []netip.Addr
	LANError  string
	TailError string
}

type Endpoint struct {
	Kind  string `json:"kind"`
	URL   string `json:"url,omitempty"`
	Error string `json:"error,omitempty"`
}

type Status struct {
	Config       Config     `json:"config"`
	Library      string     `json:"library"`
	Requested    bool       `json:"requested"`
	Phase        string     `json:"phase"`
	Message      string     `json:"message,omitempty"`
	ChatError    string     `json:"chatError,omitempty"`
	LANError     string     `json:"lanError,omitempty"`
	TailError    string     `json:"tailError,omitempty"`
	Published    int        `json:"published"`
	CatalogReady bool       `json:"catalogReady"`
	NetworkReady bool       `json:"networkReady"`
	Chats        []Chat     `json:"chats"`
	Adapters     []Adapter  `json:"adapters"`
	Endpoints    []Endpoint `json:"endpoints"`
}

type listener struct {
	server   *http.Server
	endpoint Endpoint
	binding  binding
}

type Manager struct {
	path         string
	current      func() string
	discover     func(context.Context) Network
	startup      func(bool) error
	ctx          context.Context
	cancel       context.CancelFunc
	wake         chan struct{}
	commands     sync.Mutex
	mu           sync.Mutex
	saved        savedConfig
	requested    bool
	closed       bool
	catalog      Catalog
	loadedRoot   string
	chatError    string
	network      Network
	networkReady bool
	endpoints    []Endpoint
	message      string
	published    int
	site         *Site
	listeners    map[string]listener
	loadAt       time.Time
	failure      chan error
}

func NewManager(dir string, current func() string, discover func(context.Context) Network, startup func(bool) error) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{path: filepath.Join(dir, "web-publication.json"), current: current, discover: discover, startup: startup,
		ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1), listeners: make(map[string]listener)}
	m.saved = readConfig(m.path)
	go m.run()
	return m
}

func readConfig(path string) savedConfig {
	defaults := savedConfig{Config: Config{Port: 8780, RestartLimit: 3}}
	data, err := os.ReadFile(path)
	if err != nil {
		return defaults
	}
	saved := defaults
	if json.Unmarshal(data, &saved) != nil || saved.Port < 1 || saved.Port > 65535 {
		return defaults
	}
	if saved.RestartLimit < 1 || saved.RestartLimit > 10 {
		saved.RestartLimit = 3
	}
	return saved
}

func (m *Manager) reloadIdle() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.requested {
		m.saved = readConfig(m.path)
	}
}

func (m *Manager) Status(refresh bool) Status {
	root := m.current()
	m.mu.Lock()
	defer m.mu.Unlock()
	if refresh && (m.loadedRoot != root || time.Since(m.loadAt) > 10*time.Second) {
		m.signal()
	}
	phase := "stopped"
	if m.requested {
		switch {
		case len(m.listeners) == 0 && len(m.endpoints) == 0 && m.message == "":
			phase = "starting"
		case len(m.listeners) == 0:
			phase = "waiting"
		default:
			phase = "running"
		}
	}
	cfg := m.saved.Config
	if m.saved.Library != "" && !sameRoot(root, m.saved.Library) && !m.requested {
		cfg.Scope = Scope{}
	}
	out := Status{Config: cfg, Library: root, Requested: m.requested, Phase: phase, Message: m.message,
		LANError: m.network.LANError, TailError: m.network.TailError, Published: m.published,
		CatalogReady: root == "" || sameRoot(root, m.loadedRoot), NetworkReady: m.networkReady,
		Adapters: append([]Adapter{}, m.network.Adapters...), Endpoints: append([]Endpoint{}, m.endpoints...), Chats: []Chat{}}
	if sameRoot(root, m.loadedRoot) {
		out.Chats = append(out.Chats, m.catalog.Chats...)
		out.ChatError = m.chatError
	}
	return out
}

func sameRoot(a, b string) bool {
	return a != "" && b != "" && strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func (m *Manager) Requested() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.requested
}

func (m *Manager) SwitchLibrary(change func() error) error {
	m.commands.Lock()
	defer m.commands.Unlock()
	if m.Requested() {
		return errors.New("请先停止网页部署，再切换档案库")
	}
	err := change()
	m.signal()
	return err
}

func (m *Manager) HasAddress(address string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, endpoint := range m.endpoints {
		if endpoint.URL != "" && endpoint.URL == address {
			return true
		}
	}
	return false
}

// Save applies scope and network changes immediately. The port stays fixed
// while running so the remaining published addresses keep working.
func (m *Manager) Save(cfg Config, start bool) error {
	return m.save(cfg, start, false)
}

func (m *Manager) save(cfg Config, start, prepare bool) error {
	m.commands.Lock()
	defer m.commands.Unlock()
	root := m.current()
	if root == "" {
		return errors.New("请先打开档案库")
	}
	if cfg.Port < 1 || cfg.Port > 65535 {
		return errors.New("端口必须在 1 到 65535 之间")
	}
	if cfg.RestartLimit == 0 && !cfg.RestartOnFailure {
		cfg.RestartLimit = 3
	}
	if cfg.RestartLimit < 1 || cfg.RestartLimit > 10 {
		return errors.New("重启上限须在 1 到 10 次之间")
	}
	if start && cfg.Adapter == "" && !cfg.Tailscale {
		return errors.New("请选择至少一种访问网络")
	}
	if start && !cfg.Scope.All && len(cfg.Scope.Chats) == 0 {
		return errors.New("请选择要发布的聊天")
	}
	if cfg.Scope.All {
		cfg.Scope.Chats = nil
	}
	m.mu.Lock()
	previous, running, closed := m.saved, m.requested, m.closed
	m.mu.Unlock()
	if closed {
		return errors.New("网页部署已关闭")
	}
	if running && (!sameRoot(previous.Library, root) || previous.Port != cfg.Port) {
		return errors.New("请先停止部署，再更换档案库或端口")
	}
	if running && cfg.Adapter == "" && !cfg.Tailscale {
		return errors.New("请使用「停止部署」关闭所有访问地址")
	}
	if running && (previous.RestartOnFailure != cfg.RestartOnFailure || previous.RestartLimit != cfg.RestartLimit) {
		return errors.New("请先停止部署，再修改故障重启设置")
	}
	if cfg.Auto || cfg.Auto != previous.Auto {
		if err := m.startup(cfg.Auto); err != nil {
			return fmt.Errorf("无法更新 Windows 登录启动项：%w", err)
		}
	}
	next := savedConfig{Config: cfg, Library: root, Resume: running || start}
	if err := writeConfig(m.path, next); err != nil {
		if cfg.Auto != previous.Auto {
			_ = m.startup(previous.Auto)
		}
		return fmt.Errorf("无法保存部署设置：%w", err)
	}
	m.mu.Lock()
	m.saved, m.requested = next, next.Resume && !prepare
	if m.site != nil {
		m.published = m.site.Publish(m.catalog, cfg.Scope)
		if m.published > 0 {
			m.reconcile()
		} else {
			m.closeSite()
			m.endpoints = nil
			m.message = "等待所选聊天生成网页"
		}
	}
	m.mu.Unlock()
	m.signal()
	return nil
}

func (m *Manager) Restore() {
	m.resume(true)
}

func (m *Manager) resume(requireAuto bool) {
	m.commands.Lock()
	defer m.commands.Unlock()
	m.mu.Lock()
	if !m.closed && m.saved.Resume && (m.saved.Auto || !requireAuto) {
		m.requested = true
	}
	m.mu.Unlock()
	m.signal()
}

func (m *Manager) Stop() error {
	m.commands.Lock()
	defer m.commands.Unlock()
	m.mu.Lock()
	m.requested = false
	m.saved.Resume = false
	saved := m.saved
	m.closeSite()
	m.endpoints, m.message = nil, ""
	m.mu.Unlock()
	if err := writeConfig(m.path, saved); err != nil {
		if saved.Auto {
			if disableErr := m.startup(false); disableErr == nil {
				m.mu.Lock()
				m.saved.Auto = false
				m.mu.Unlock()
			}
		}
		return fmt.Errorf("网页服务已停止，无法保存停止状态：%w", err)
	}
	return nil
}

func (m *Manager) Close() {
	m.commands.Lock()
	defer m.commands.Unlock()
	m.cancel()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed, m.requested = true, false
	m.closeSite()
}

func (m *Manager) closeSite() {
	for key, bound := range m.listeners {
		_ = bound.server.Close()
		delete(m.listeners, key)
	}
	if m.site != nil {
		m.site.Close()
		m.site = nil
	}
	m.published = 0
}

func (m *Manager) signal() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *Manager) run() {
	ticker := time.NewTicker(8 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-m.wake:
		case <-ticker.C:
			if !m.Requested() {
				continue
			}
		}
		m.refresh()
	}
}

func (m *Manager) refresh() {
	root := m.current()
	var previous Catalog
	m.mu.Lock()
	m.loadAt = time.Now()
	if sameRoot(root, m.loadedRoot) {
		previous = m.catalog
	}
	m.mu.Unlock()
	// Reconcile addresses before reading the library, which can be on a NAS.
	network := m.discover(m.ctx)
	m.mu.Lock()
	m.network = network
	m.networkReady = true
	if m.requested && m.site != nil && sameRoot(root, m.saved.Library) {
		m.reconcile()
	}
	m.mu.Unlock()
	var catalog Catalog
	var err error
	if root == "" {
		err = errors.New("未打开档案库")
	} else {
		catalog, err = readCatalog(m.ctx, root, previous)
	}
	current := m.current()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || current != root {
		return
	}
	m.chatError = ""
	if err != nil {
		m.chatError = "档案库暂不可读或网页索引尚未生成"
	} else {
		m.catalog = catalog
	}
	if !sameRoot(m.loadedRoot, root) && err != nil {
		m.catalog = Catalog{}
	}
	m.loadedRoot = root
	if !m.requested {
		return
	}
	if !sameRoot(root, m.saved.Library) {
		m.closeSite()
		m.endpoints = nil
		m.message = "等待保存的档案库。打开该库后可以恢复部署"
		return
	}
	if err != nil {
		m.message = m.chatError
		return
	}
	m.message = ""
	if m.site == nil {
		m.site = NewSite(root)
	}
	if m.published == 0 || catalog.Version != previous.Version {
		m.published = m.site.Publish(catalog, m.saved.Scope)
	}
	if m.published == 0 {
		m.closeSite()
		m.endpoints = nil
		m.message = "等待所选聊天生成网页"
		return
	}
	m.reconcile()
}

type binding struct {
	kind string
	ip   netip.Addr
	from netip.Prefix
}

func (m *Manager) reconcile() {
	var desired []binding
	var endpoints []Endpoint
	if m.saved.Adapter != "" {
		found := false
		for _, adapter := range m.network.Adapters {
			ip, err := netip.ParseAddr(adapter.IP)
			if adapter.ID == m.saved.Adapter && err == nil && adapter.LAN.Contains(ip) {
				desired = append(desired, binding{"lan", ip, adapter.LAN})
				found = true
				break
			}
		}
		if !found {
			endpoints = append(endpoints, Endpoint{Kind: "lan", Error: "所选专用网络暂不可用"})
		}
	}
	if m.saved.Tailscale {
		for _, ip := range m.network.TailIPs {
			prefix := tailV6
			if ip.Is4() {
				prefix = tailV4
			}
			if prefix.Contains(ip) {
				desired = append(desired, binding{"tailscale", ip, prefix})
			}
		}
		if len(m.network.TailIPs) == 0 {
			msg := m.network.TailError
			if msg == "" {
				msg = "Tailscale 暂未分配本机地址"
			}
			endpoints = append(endpoints, Endpoint{Kind: "tailscale", Error: msg})
		}
	}
	keys := make(map[string]binding, len(desired))
	for _, b := range desired {
		keys[b.ip.String()] = b
	}
	for key, bound := range m.listeners {
		if keys[key] != bound.binding {
			_ = bound.server.Close()
			delete(m.listeners, key)
		}
	}
	for _, b := range desired {
		key := b.ip.String()
		if bound, ok := m.listeners[key]; ok {
			endpoints = append(endpoints, bound.endpoint)
			continue
		}
		addr := net.JoinHostPort(key, strconv.Itoa(m.saved.Port))
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			endpoints = append(endpoints, Endpoint{Kind: b.kind, Error: "无法监听端口 " + strconv.Itoa(m.saved.Port) + "，请检查占用或更换端口"})
			continue
		}
		server := &http.Server{Handler: restrict(m.site, addr, b.from), ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout: 45 * time.Second, MaxHeaderBytes: 32 << 10}
		endpoint := Endpoint{Kind: b.kind, URL: "http://" + addr + "/"}
		m.listeners[key] = listener{server, endpoint, b}
		endpoints = append(endpoints, endpoint)
		go func() {
			err := server.Serve(ln)
			m.mu.Lock()
			if m.listeners[key].server == server {
				delete(m.listeners, key)
				if err != nil && !errors.Is(err, http.ErrServerClosed) && m.failure != nil {
					select {
					case m.failure <- err:
					default:
					}
				}
				m.signal()
			}
			m.mu.Unlock()
		}()
	}
	m.endpoints = endpoints
}

func restrict(site http.Handler, host string, from netip.Prefix) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, err := netip.ParseAddrPort(r.RemoteAddr)
		if err != nil || !from.Contains(peer.Addr().Unmap()) || !strings.EqualFold(r.Host, host) {
			http.Error(w, "此地址仅供所选网络访问", http.StatusForbidden)
			return
		}
		site.ServeHTTP(w, r)
	})
}

var tailV4 = netip.MustParsePrefix("100.64.0.0/10")
var tailV6 = netip.MustParsePrefix("fd7a:115c:a1e0::/48")

func writeConfig(path string, cfg savedConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".web-publication-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(data)
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}
