package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/dcs"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
	"go.etcd.io/bbolt"
	xproxy "golang.org/x/net/proxy"
)

var (
	errProfileBusy = errors.New("tdl 正在使用会话文件")
	errProfileNone = errors.New("当前 namespace 没有会话文件")
)

// AccountProfile is the live Telegram profile behind the local tdl session.
type AccountProfile struct {
	Name      string `json:"name"`
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
	Username  string `json:"username"`
	Phone     string `json:"phone"`
	UserID    int64  `json:"userId"`
	Avatar    string `json:"avatar,omitempty"`
	CheckedAt int64  `json:"checkedAt"`
}

type profileEnvelope struct {
	Profile AccountProfile `json:"profile"`
	App     string         `json:"app"`
}

// ProfileService reads the tdl session and performs one direct users.getUsers
// call. It never writes the session back: tdl remains the only owner.
type ProfileService struct {
	dir string
	mu  sync.Mutex
}

func NewProfileService(configDir string) *ProfileService {
	return &ProfileService{dir: configDir}
}

func profileKey(ns string) string {
	var b strings.Builder
	for _, r := range ns {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "default"
	}
	return b.String()
}

func (s *ProfileService) path(ns string) string {
	return filepath.Join(s.dir, "account-profile-"+profileKey(ns)+".json")
}

func (s *ProfileService) Cached(ns string) *AccountProfile {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked(ns)
}

func (s *ProfileService) readLocked(ns string) *AccountProfile {
	b, err := os.ReadFile(s.path(ns))
	if err != nil {
		return nil
	}
	var env profileEnvelope
	if json.Unmarshal(b, &env) != nil || env.Profile.UserID == 0 {
		return nil
	}
	return &env.Profile
}

func (s *ProfileService) Clear(ns string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = os.Remove(s.path(ns))
}

func (s *ProfileService) save(ns, app string, p AccountProfile) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if os.MkdirAll(s.dir, 0755) != nil {
		return
	}
	b, err := json.MarshalIndent(profileEnvelope{Profile: p, App: app}, "", "  ")
	if err != nil {
		return
	}
	tmp := s.path(ns) + ".tmp"
	if os.WriteFile(tmp, b, 0600) == nil {
		_ = os.Rename(tmp, s.path(ns))
	}
}

func tdlSessionPath(ns string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".tdl", "data", ns)
}

func readTdlSession(ns string) (blob []byte, app string, err error) {
	path := tdlSessionPath(ns)
	if path == "" {
		return nil, "", errProfileNone
	}
	if _, statErr := os.Stat(path); statErr != nil {
		return nil, "", errProfileNone
	}
	// tdl keeps the bbolt file exclusively locked while a download is running;
	// opening the live file read-only waits for the lock and then fails. Read a
	// snapshot instead: bbolt is copy-on-write, so a plain file copy usually
	// holds a committed state, and opening the copy never touches tdl's lock.
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			if os.IsNotExist(readErr) {
				return nil, "", errProfileNone
			}
			return nil, "", fmt.Errorf("读取 tdl 会话失败: %w", readErr)
		}
		blob, app, lastErr = readTdlSessionBytes(data, ns)
		if lastErr == nil {
			return blob, app, nil
		}
		time.Sleep(time.Duration(60+attempt*40) * time.Millisecond)
	}
	return nil, "", fmt.Errorf("%w：tdl 正在写入会话文件，请稍后重试", errProfileBusy)
}

func readTdlSessionBytes(data []byte, ns string) (blob []byte, app string, err error) {
	tmp, err := os.CreateTemp("", "tak-session-*.db")
	if err != nil {
		return nil, "", err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return nil, "", err
	}
	if err := tmp.Close(); err != nil {
		return nil, "", err
	}
	db, openErr := bbolt.Open(name, 0444, &bbolt.Options{ReadOnly: true, Timeout: 200 * time.Millisecond})
	if openErr != nil {
		return nil, "", openErr
	}
	defer db.Close()
	viewErr := db.View(func(tx *bbolt.Tx) error {
		bucket := tx.Bucket([]byte(ns))
		if bucket == nil {
			return errProfileNone
		}
		blob = append([]byte(nil), bucket.Get([]byte("session"))...)
		app = string(bucket.Get([]byte("app")))
		return nil
	})
	if viewErr != nil {
		return nil, "", viewErr
	}
	if len(blob) == 0 {
		return nil, "", errProfileNone
	}
	if app == "" {
		app = "desktop"
	}
	return blob, app, nil
}

func appCredentials(app string) (int, string) {
	if app == "builtin" {
		return 15055931, "021d433426cbb920eeb95164498fe3d3"
	}
	return 2040, "b18441a1ff607e10a989891a5462e627"
}

func proxyDialer(raw string) dcs.DialFunc {
	fallback := xproxy.Direct.DialContext
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return fallback
	}
	switch strings.ToLower(u.Scheme) {
	case "socks5", "socks5h", "socks":
		var auth *xproxy.Auth
		if u.User != nil {
			pass, _ := u.User.Password()
			auth = &xproxy.Auth{User: u.User.Username(), Password: pass}
		}
		d, err := xproxy.SOCKS5("tcp", u.Host, auth, xproxy.Direct)
		if err != nil {
			return fallback
		}
		return func(ctx context.Context, network, addr string) (net.Conn, error) {
			return d.Dial(network, addr)
		}
	case "http", "https":
		return func(ctx context.Context, network, addr string) (net.Conn, error) {
			conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", u.Host)
			if err != nil {
				return nil, err
			}
			req := &http.Request{
				Method: http.MethodConnect,
				URL:    &url.URL{Opaque: addr},
				Host:   addr,
				Header: make(http.Header),
			}
			if u.User != nil {
				pass, _ := u.User.Password()
				token := base64.StdEncoding.EncodeToString([]byte(u.User.Username() + ":" + pass))
				req.Header.Set("Proxy-Authorization", "Basic "+token)
			}
			if err := req.Write(conn); err != nil {
				conn.Close()
				return nil, err
			}
			br := bufio.NewReader(conn)
			resp, err := http.ReadResponse(br, req)
			if err != nil {
				conn.Close()
				return nil, err
			}
			if resp.StatusCode != http.StatusOK {
				conn.Close()
				return nil, fmt.Errorf("代理 CONNECT 失败：%s", resp.Status)
			}
			return &bufferedConn{Conn: conn, r: br}, nil
		}
	default:
		return fallback
	}
}

type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufferedConn) Read(b []byte) (int, error) { return c.r.Read(b) }

// Fetch connects with the existing tdl auth key and returns the Telegram
// profile. It is usually much faster than enumerating every dialog.
func (s *ProfileService) Fetch(ctx context.Context, ns, proxy string, timeout time.Duration) (AccountProfile, error) {
	blob, app, err := readTdlSession(ns)
	if err != nil {
		return AccountProfile{}, err
	}
	if timeout <= 0 || timeout > 20*time.Second {
		timeout = 12 * time.Second
	}
	appID, appHash := appCredentials(app)
	storage := &session.StorageMemory{}
	if err := storage.StoreSession(ctx, blob); err != nil {
		return AccountProfile{}, err
	}
	dial := proxyDialer(proxy)
	client := telegram.NewClient(appID, appHash, telegram.Options{
		SessionStorage: storage,
		Resolver:       dcs.Plain(dcs.PlainOptions{Dial: dial}),
		NoUpdates:      true,
		DialTimeout:    8 * time.Second,
	})
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cached := s.Cached(ns)
	var self *tg.User
	var avatar string
	err = client.Run(runCtx, func(ctx context.Context) error {
		u, err := client.Self(ctx)
		if err != nil {
			return err
		}
		self = u
		if cached != nil && cached.UserID == u.ID && cached.Avatar != "" {
			avatar = cached.Avatar
			return nil
		}
		avatar = fetchProfileAvatar(ctx, client)
		return nil
	})
	if err != nil {
		return AccountProfile{}, err
	}
	if self == nil {
		return AccountProfile{}, errors.New("Telegram 未返回账号资料")
	}
	out := AccountProfile{
		FirstName: self.FirstName,
		LastName:  self.LastName,
		Name:      strings.TrimSpace(self.FirstName + " " + self.LastName),
		Username:  self.Username,
		Phone:     self.Phone,
		UserID:    self.ID,
		CheckedAt: time.Now().UnixMilli(),
	}
	if out.Name == "" {
		out.Name = "Telegram 账号"
	}
	out.Avatar = avatar
	s.save(ns, app, out)
	return out, nil
}

// fetchProfileAvatar downloads the real profile photo. UserProfilePhoto's
// StrippedThumb is only a 20-byte placeholder token, not an image.
func fetchProfileAvatar(ctx context.Context, client *telegram.Client) string {
	res, err := client.API().PhotosGetUserPhotos(ctx, &tg.PhotosGetUserPhotosRequest{
		UserID: &tg.InputUserSelf{},
		Limit:  1,
	})
	if err != nil {
		return ""
	}
	photos, ok := res.(*tg.PhotosPhotos)
	if !ok || len(photos.Photos) == 0 {
		return ""
	}
	photo, ok := photos.Photos[0].(*tg.Photo)
	if !ok || len(photo.Sizes) == 0 {
		return ""
	}
	thumbSize := ""
	for _, size := range photo.Sizes {
		switch s := size.(type) {
		case *tg.PhotoSize:
			thumbSize = s.Type
		case *tg.PhotoSizeProgressive:
			thumbSize = s.Type
		}
	}
	if thumbSize == "" {
		return ""
	}
	var buf bytes.Buffer
	location := &tg.InputPhotoFileLocation{
		ID: photo.ID, AccessHash: photo.AccessHash,
		FileReference: photo.FileReference, ThumbSize: thumbSize,
	}
	if _, err := client.Download(location).Stream(ctx, &buf); err != nil || buf.Len() < 256 {
		return ""
	}
	data := buf.Bytes()
	mime := http.DetectContentType(data)
	if !strings.HasPrefix(mime, "image/") {
		return ""
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}

func classifyProfileError(err error) (state, message string) {
	if err == nil {
		return "ready", "Telegram 连接正常"
	}
	if errors.Is(err, errProfileNone) {
		return "unauthorized", "当前 namespace 没有本地会话，请先登录"
	}
	if errors.Is(err, errProfileBusy) {
		return "busy", "tdl 正在使用会话文件，暂不能直连检查"
	}
	if tgerr.Is(err, "AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "USER_DEACTIVATED", "USER_DEACTIVATED_BAN") {
		return "unauthorized", "Telegram 已拒绝该会话，授权已失效"
	}
	if tgerr.Is(err, "FLOOD_WAIT") || tgerr.Is(err, "FLOOD") {
		return "check-failed", "Telegram 限流，请稍后再检查"
	}
	low := strings.ToLower(err.Error())
	if strings.Contains(low, "deadline exceeded") || strings.Contains(low, "timeout") || strings.Contains(low, "i/o timeout") {
		return "timeout", "直连 Telegram 超时"
	}
	if strings.Contains(low, "connection") || strings.Contains(low, "no such host") || strings.Contains(low, "network") || strings.Contains(low, "eof") {
		return "network", "网络连接失败，授权状态未改变"
	}
	if strings.Contains(low, "not authorized") || strings.Contains(low, "please login") {
		return "unauthorized", "Telegram 授权已失效或未登录"
	}
	return "check-failed", strings.TrimSpace(err.Error())
}
