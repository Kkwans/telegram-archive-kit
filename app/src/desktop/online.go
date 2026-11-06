package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/dcs"
	"github.com/gotd/td/telegram/query/dialogs"
	"github.com/gotd/td/tg"

	takapp "telegramarchivekit/internal/app"
)

// OnlineChat is one Telegram dialog as seen through the existing tdl session.
// Avatars are intentionally not embedded here: fetching hundreds of photos
// would be slow and rate-limited, so the list uses deterministic initials.
type OnlineChat struct {
	Peer            string `json:"peer"`
	ID              int64  `json:"id"`
	Type            string `json:"type"`
	Name            string `json:"name"`
	Username        string `json:"username,omitempty"`
	HasPhoto        bool   `json:"hasPhoto"`
	Avatar          string `json:"avatar,omitempty"`
	LastMessage     string `json:"lastMessage,omitempty"`
	LastKind        string `json:"lastKind,omitempty"`
	LastMessageID   int    `json:"lastMessageId,omitempty"`
	LastDate        int64  `json:"lastDate,omitempty"`
	Unread          int    `json:"unread,omitempty"`
	Pinned          bool   `json:"pinned,omitempty"`
	Archived        bool   `json:"archived,omitempty"`
	LocalSlug       string `json:"localSlug,omitempty"`
	LocalMessages   int    `json:"localMessages,omitempty"`
	LocalMedia      int    `json:"localMedia,omitempty"`
	LocalUpdatedAt  string `json:"localUpdatedAt,omitempty"`
	ArchivedLocally bool   `json:"archivedLocally,omitempty"`
}

type OnlineChatsDTO struct {
	Chats     []OnlineChat `json:"chats"`
	FetchedAt int64        `json:"fetchedAt"`
	Source    string       `json:"source,omitempty"`
	Error     string       `json:"error,omitempty"`
}

type avatarRef struct {
	peer    tg.InputPeerClass
	photoID int64
}

type onlineEnvelope struct {
	Chats     []OnlineChat `json:"chats"`
	FetchedAt int64        `json:"fetchedAt"`
}

// OnlineService reads the tdl bbolt session without writing it back. It is
// deliberately read-only: tdl remains the sole owner of the auth key.
type OnlineService struct {
	dir    string
	mu     sync.Mutex
	refs   map[string]avatarRef
	refsNS string
	chats  map[string]OnlineChat
}

func NewOnlineService(configDir string) *OnlineService {
	return &OnlineService{dir: configDir, refs: make(map[string]avatarRef), chats: make(map[string]OnlineChat)}
}

func (s *OnlineService) path(ns string) string {
	return filepath.Join(s.dir, "online-chats-"+profileKey(ns)+".json")
}

func (s *OnlineService) Chat(peer string) (OnlineChat, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	chat, ok := s.chats[peer]
	return chat, ok
}

func (s *OnlineService) Cached(ns string) *OnlineChatsDTO {
	b, err := os.ReadFile(s.path(ns))
	if err != nil {
		return nil
	}
	var env onlineEnvelope
	if json.Unmarshal(b, &env) != nil || env.Chats == nil {
		return nil
	}
	return &OnlineChatsDTO{Chats: env.Chats, FetchedAt: env.FetchedAt, Source: "cache"}
}

func (s *OnlineService) saveCache(ns string, dto OnlineChatsDTO) {
	if s.dir == "" {
		return
	}
	if err := os.MkdirAll(s.dir, 0755); err != nil {
		return
	}
	b, err := json.MarshalIndent(onlineEnvelope{Chats: dto.Chats, FetchedAt: dto.FetchedAt}, "", "  ")
	if err != nil {
		return
	}
	tmp := s.path(ns) + ".tmp"
	if os.WriteFile(tmp, b, 0600) == nil {
		_ = os.Rename(tmp, s.path(ns))
	}
}

func (s *OnlineService) Fetch(ctx context.Context, ns, proxy string, timeout time.Duration) (OnlineChatsDTO, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	blob, app, err := readTdlSession(ns)
	if err != nil {
		return OnlineChatsDTO{}, err
	}
	storage := &session.StorageMemory{}
	if err := storage.StoreSession(ctx, blob); err != nil {
		return OnlineChatsDTO{}, err
	}
	if timeout < 10*time.Second {
		timeout = 30 * time.Second
	}
	if timeout > 60*time.Second {
		timeout = 60 * time.Second
	}
	appID, appHash := appCredentials(app)
	client := telegram.NewClient(appID, appHash, telegram.Options{
		SessionStorage: storage,
		Resolver:       dcs.Plain(dcs.PlainOptions{Dial: proxyDialer(proxy)}),
		NoUpdates:      true,
		DialTimeout:    8 * time.Second,
	})

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	seen := make(map[string]bool)
	chats := make([]OnlineChat, 0, 256)
	refs := make(map[string]avatarRef, 64)
	err = client.Run(runCtx, func(ctx context.Context) error {
		for _, folder := range []int{0, 1} {
			iter := dialogs.NewQueryBuilder(client.API()).
				GetDialogs().
				BatchSize(100).
				FolderID(folder).
				Iter()
			for iter.Next(ctx) {
				dto, ref, ok := mapDialog(iter.Value())
				if !ok || seen[dto.Peer] {
					continue
				}
				seen[dto.Peer] = true
				if ref.peer != nil {
					refs[dto.Peer] = ref
				}
				chats = append(chats, dto)
				if len(chats) >= 2000 {
					break
				}
			}
			if err := iter.Err(); err != nil {
				return err
			}
		}
		sort.SliceStable(chats, func(i, j int) bool {
			if chats[i].Pinned != chats[j].Pinned {
				return chats[i].Pinned
			}
			return chats[i].LastDate > chats[j].LastDate
		})
		return nil
	})
	if err != nil {
		return OnlineChatsDTO{}, err
	}
	s.refs = refs
	s.refsNS = ns
	s.chats = make(map[string]OnlineChat, len(chats))
	for _, chat := range chats {
		s.chats[chat.Peer] = chat
	}
	return OnlineChatsDTO{Chats: chats, FetchedAt: time.Now().UnixMilli(), Source: "live"}, nil
}

// FetchAvatars downloads a small set of profile photos in parallel. The list
// renders immediately with initials, then the first screenful gets real photos.
func (s *OnlineService) FetchAvatars(ctx context.Context, ns, proxy string, peers []string, timeout time.Duration) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string, len(peers))
	if len(peers) == 0 || s.refsNS != ns {
		return out, nil
	}
	refs := make(map[string]avatarRef, len(peers))
	for _, peer := range peers {
		if ref, ok := s.refs[peer]; ok {
			refs[peer] = ref
		}
	}
	if len(refs) == 0 {
		return out, nil
	}
	blob, app, err := readTdlSession(ns)
	if err != nil {
		return out, err
	}
	storage := &session.StorageMemory{}
	if err := storage.StoreSession(ctx, blob); err != nil {
		return out, err
	}
	if timeout < 10*time.Second {
		timeout = 30 * time.Second
	}
	if timeout > 60*time.Second {
		timeout = 60 * time.Second
	}
	appID, appHash := appCredentials(app)
	client := telegram.NewClient(appID, appHash, telegram.Options{
		SessionStorage: storage,
		Resolver:       dcs.Plain(dcs.PlainOptions{Dial: proxyDialer(proxy)}),
		NoUpdates:      true,
		DialTimeout:    8 * time.Second,
	})
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var mu sync.Mutex
	sem := make(chan struct{}, 6)
	var wg sync.WaitGroup
	err = client.Run(runCtx, func(ctx context.Context) error {
		for peer, ref := range refs {
			wg.Add(1)
			go func(peer string, ref avatarRef) {
				defer wg.Done()
				select {
				case sem <- struct{}{}:
					defer func() { <-sem }()
				case <-ctx.Done():
					return
				}
				if avatar := downloadAvatar(ctx, client, ref); avatar != "" {
					mu.Lock()
					out[peer] = avatar
					mu.Unlock()
				}
			}(peer, ref)
		}
		wg.Wait()
		return nil
	})
	if err != nil {
		return out, err
	}
	if cached := s.Cached(ns); cached != nil && len(out) > 0 {
		for i := range cached.Chats {
			if avatar, ok := out[cached.Chats[i].Peer]; ok {
				cached.Chats[i].Avatar = avatar
			}
		}
		s.saveCache(ns, *cached)
	}
	return out, nil
}

func downloadAvatar(ctx context.Context, client *telegram.Client, ref avatarRef) string {
	if ref.peer == nil || ref.photoID == 0 {
		return ""
	}
	var buf bytes.Buffer
	loc := &tg.InputPeerPhotoFileLocation{
		Peer:    ref.peer,
		PhotoID: ref.photoID,
	}
	if _, err := client.Download(loc).Stream(ctx, &buf); err != nil || buf.Len() < 256 {
		return ""
	}
	data := buf.Bytes()
	mime := http.DetectContentType(data)
	if !strings.HasPrefix(mime, "image/") {
		return ""
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}

func mapDialog(elem dialogs.Elem) (OnlineChat, avatarRef, bool) {
	dialog, ok := elem.Dialog.(*tg.Dialog)
	if !ok {
		return OnlineChat{}, avatarRef{}, false
	}
	out := OnlineChat{
		Pinned: dialog.Pinned,
		Unread: dialog.UnreadCount,
	}
	if folder, ok := dialog.GetFolderID(); ok && folder == 1 {
		out.Archived = true
	}
	out.LastMessageID = dialog.TopMessage

	var ref avatarRef
	switch peer := elem.Peer.(type) {
	case *tg.InputPeerUser:
		user, ok := elem.Entities.User(peer.UserID)
		if !ok {
			return OnlineChat{}, avatarRef{}, false
		}
		out.Peer = "user:" + strconv.FormatInt(user.ID, 10)
		out.ID = user.ID
		out.Type = "private"
		if user.Bot {
			out.Type = "bot"
		}
		out.Name = strings.TrimSpace(strings.TrimSpace(user.FirstName) + " " + strings.TrimSpace(user.LastName))
		if out.Name == "" {
			out.Name = strings.TrimSpace(user.Username)
		}
		if out.Name == "" {
			out.Name = "用户 " + strconv.FormatInt(user.ID, 10)
		}
		out.Username = user.Username
		switch photo := user.Photo.(type) {
		case *tg.UserProfilePhoto:
			out.HasPhoto = true
			ref = avatarRef{peer: peer, photoID: photo.PhotoID}
		}
	case *tg.InputPeerChat:
		chat, ok := elem.Entities.Chat(peer.ChatID)
		if !ok {
			return OnlineChat{}, avatarRef{}, false
		}
		out.Peer = "chat:" + strconv.FormatInt(chat.ID, 10)
		out.ID = chat.ID
		out.Type = "group"
		out.Name = strings.TrimSpace(chat.Title)
		if out.Name == "" {
			out.Name = "群组 " + strconv.FormatInt(chat.ID, 10)
		}
		switch photo := chat.Photo.(type) {
		case *tg.ChatPhoto:
			out.HasPhoto = true
			ref = avatarRef{peer: peer, photoID: photo.PhotoID}
		}
	case *tg.InputPeerChannel:
		ch, ok := elem.Entities.Channel(peer.ChannelID)
		if !ok {
			return OnlineChat{}, avatarRef{}, false
		}
		out.Peer = "channel:" + strconv.FormatInt(ch.ID, 10)
		out.ID = ch.ID
		out.Type = "group"
		if ch.Broadcast {
			out.Type = "channel"
		}
		out.Name = strings.TrimSpace(ch.Title)
		if out.Name == "" {
			out.Name = "频道 " + strconv.FormatInt(ch.ID, 10)
		}
		out.Username = ch.Username
		switch photo := ch.Photo.(type) {
		case *tg.ChatPhoto:
			out.HasPhoto = true
			ref = avatarRef{peer: peer, photoID: photo.PhotoID}
		}
	default:
		return OnlineChat{}, avatarRef{}, false
	}

	out.LastMessage, out.LastKind, out.LastDate = summarizeLast(elem.Last)
	return out, ref, true
}

func summarizeLast(m tg.NotEmptyMessage) (text, kind string, date int64) {
	switch msg := m.(type) {
	case *tg.Message:
		date = int64(msg.Date)
		text = collapse(msg.Message)
		kind = "text"
		if msg.Media != nil {
			kind = mediaKind(msg.Media)
			if text == "" {
				text = mediaLabel(kind)
			}
		}
		if text == "" {
			text = "空消息"
		}
	case *tg.MessageService:
		date = int64(msg.Date)
		text = "服务消息"
		kind = "service"
	}
	if utf8.RuneCountInString(text) > 140 {
		runes := []rune(text)
		text = string(runes[:140]) + "…"
	}
	return text, kind, date
}

func collapse(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func mediaKind(media tg.MessageMediaClass) string {
	switch m := media.(type) {
	case *tg.MessageMediaPhoto:
		return "image"
	case *tg.MessageMediaDocument:
		doc, ok := m.Document.(*tg.Document)
		if !ok {
			return "file"
		}
		var hasVideo, hasVoice, hasAudio, hasSticker, hasAnimated bool
		for _, attr := range doc.Attributes {
			switch a := attr.(type) {
			case *tg.DocumentAttributeVideo:
				hasVideo = true
			case *tg.DocumentAttributeAudio:
				if a.Voice {
					hasVoice = true
				} else {
					hasAudio = true
				}
			case *tg.DocumentAttributeSticker:
				hasSticker = true
			case *tg.DocumentAttributeAnimated:
				hasAnimated = true
			}
		}
		switch {
		case hasVoice:
			return "voice"
		case hasVideo:
			return "video"
		case hasAudio:
			return "audio"
		case hasSticker:
			return "sticker"
		case hasAnimated:
			return "gif"
		default:
			return "file"
		}
	case *tg.MessageMediaGeo, *tg.MessageMediaGeoLive:
		return "location"
	case *tg.MessageMediaContact:
		return "contact"
	case *tg.MessageMediaPoll:
		return "poll"
	case *tg.MessageMediaWebPage:
		return "link"
	default:
		return "file"
	}
}

func mediaLabel(kind string) string {
	switch kind {
	case "image":
		return "[图片]"
	case "video":
		return "[视频]"
	case "audio":
		return "[音频]"
	case "voice":
		return "[语音]"
	case "sticker":
		return "[贴纸]"
	case "gif":
		return "[动图]"
	case "location":
		return "[位置]"
	case "contact":
		return "[联系人]"
	case "poll":
		return "[投票]"
	case "link":
		return "[链接]"
	default:
		return "[文件]"
	}
}

// OnlineChats fetches the live list, annotates it with local archive state and
// falls back to the last successful snapshot when Telegram is unreachable.
func (b *Bridge) OnlineChats(timeout int) (OnlineChatsDTO, error) {
	info := b.facade.AccountInfo()
	ns := info.Namespace
	settings := b.facade.GetSettings()
	if b.facade.Running() {
		if cached := b.online.Cached(ns); cached != nil {
			cached.Error = "下载任务正在运行，显示上次在线快照"
			b.annotateOnlineLocal(cached)
			return *cached, nil
		}
		return OnlineChatsDTO{}, errors.New("下载任务正在运行，请稍后刷新在线列表")
	}
	if !info.HasSessionFile {
		if cached := b.online.Cached(ns); cached != nil {
			cached.Error = "当前 namespace 没有会话，显示上次在线快照"
			b.annotateOnlineLocal(cached)
			return *cached, nil
		}
		return OnlineChatsDTO{}, errors.New("当前没有 Telegram 会话，请先登录")
	}
	dto, err := b.online.Fetch(context.Background(), ns, settings.Proxy, time.Duration(timeout)*time.Second)
	if err != nil {
		if cached := b.online.Cached(ns); cached != nil {
			_, message := classifyProfileError(err)
			cached.Error = "在线列表刷新失败，显示上次快照：" + message
			b.annotateOnlineLocal(cached)
			return *cached, nil
		}
		return OnlineChatsDTO{}, err
	}
	// Reuse profile photos from the last snapshot so the first screen does
	// not pay the network cost again on every visit.
	if cached := b.online.Cached(ns); cached != nil {
		avatars := make(map[string]string, len(cached.Chats))
		for _, c := range cached.Chats {
			if c.Avatar != "" {
				avatars[c.Peer] = c.Avatar
			}
		}
		for i := range dto.Chats {
			if dto.Chats[i].Avatar == "" {
				dto.Chats[i].Avatar = avatars[dto.Chats[i].Peer]
			}
		}
	}
	b.annotateOnlineLocal(&dto)
	b.online.saveCache(ns, dto)
	return dto, nil
}

func (b *Bridge) OnlineChatsCached() *OnlineChatsDTO {
	cached := b.online.Cached(b.facade.AccountInfo().Namespace)
	if cached == nil {
		return nil
	}
	b.annotateOnlineLocal(cached)
	return cached
}

func (b *Bridge) OnlineAvatars(peers []string, timeout int) (map[string]string, error) {
	info := b.facade.AccountInfo()
	settings := b.facade.GetSettings()
	return b.online.FetchAvatars(context.Background(), info.Namespace, settings.Proxy, peers, time.Duration(timeout)*time.Second)
}

func (b *Bridge) annotateOnlineLocal(dto *OnlineChatsDTO) {
	if dto == nil {
		return
	}
	byID := make(map[string]takapp.ChatDTO, len(dto.Chats))
	for _, c := range b.facade.ListChats() {
		if c.ID != "" {
			byID[c.ID] = c
		}
	}
	for i := range dto.Chats {
		c, ok := byID[strconv.FormatInt(dto.Chats[i].ID, 10)]
		if !ok {
			continue
		}
		dto.Chats[i].LocalSlug = c.Slug
		dto.Chats[i].LocalMessages = c.Messages
		dto.Chats[i].LocalMedia = c.Media
		dto.Chats[i].LocalUpdatedAt = c.UpdatedAt
		dto.Chats[i].ArchivedLocally = true
	}
}
