package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/dcs"
	tgpeer "github.com/gotd/td/telegram/message/peer"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"

	takapp "telegramarchivekit/internal/app"
)

type OnlineExportResult struct {
	Slug     string `json:"slug"`
	Chat     string `json:"chat"`
	TaskID   string `json:"taskId,omitempty"`
	Messages int    `json:"messages"`
	Media    int    `json:"media"`
	Existed  bool   `json:"existed"`
	UpToDate bool   `json:"upToDate,omitempty"`
}

// ExportProgress is the live state of one history walk. Hashing it out to the
// desktop lets the preview dialog show a moving bar instead of a bare spinner.
type ExportProgress struct {
	Stage    string  `json:"stage"`
	Detail   string  `json:"detail,omitempty"`
	Percent  float64 `json:"percent"`
	Messages int     `json:"messages"`
	Media    int     `json:"media"`
}

type OnlineExportProgress struct {
	Active   bool    `json:"active"`
	Stage    string  `json:"stage,omitempty"`
	Detail   string  `json:"detail,omitempty"`
	Percent  float64 `json:"percent"`
	Messages int     `json:"messages"`
	Media    int     `json:"media"`
}

type OnlineExportPreview struct {
	Peer           string `json:"peer"`
	Chat           string `json:"chat"`
	Token          string `json:"token,omitempty"`
	Existed        bool   `json:"existed"`
	UpToDate       bool   `json:"upToDate,omitempty"`
	BackfillOnly   bool   `json:"backfillOnly,omitempty"`
	Messages       int    `json:"messages"`
	Service        int    `json:"service"`
	Images         int    `json:"images"`
	Videos         int    `json:"videos"`
	Audio          int    `json:"audio"`
	Files          int    `json:"files"`
	Other          int    `json:"other"`
	Media          int    `json:"media"`
	Bytes          int64  `json:"bytes"`
	LocalMessages  int    `json:"localMessages,omitempty"`
	LocalMedia     int    `json:"localMedia,omitempty"`
	LocalUpdatedAt string `json:"localUpdatedAt,omitempty"`
	LocalMissing   int    `json:"localMissing,omitempty"`
	MissingBytes   int64  `json:"missingBytes,omitempty"`
	FreeBytes      int64  `json:"freeBytes,omitempty"`
	SpaceNeedBytes int64  `json:"spaceNeedBytes,omitempty"`
	SpaceShort     bool   `json:"spaceShort,omitempty"`
}

var floodWaitPattern = regexp.MustCompile(`FLOOD_WAIT[^0-9]*(\d+)`)

// friendlyOnlineError turns rate limiting into an actionable message.
func friendlyOnlineError(err error) error {
	if d, ok := tgerr.AsFloodWait(err); ok {
		seconds := int(d.Seconds())
		if seconds < 1 {
			seconds = 1
		}
		return fmt.Errorf("Telegram 限流，请等待 %d 秒后再试", seconds)
	}
	if m := floodWaitPattern.FindStringSubmatch(err.Error()); m != nil {
		return fmt.Errorf("Telegram 限流，请等待 %s 秒后再试", m[1])
	}
	return err
}

// waitFlood keeps short rate limits invisible to the user by pausing the
// current history walk instead of failing the whole archive.
func waitFlood(ctx context.Context, err error) (bool, error) {
	d, ok := tgerr.AsFloodWait(err)
	if !ok {
		return false, err
	}
	if d > 90*time.Second {
		return false, friendlyOnlineError(err)
	}
	if d < time.Second {
		d = time.Second
	}
	select {
	case <-time.After(d + time.Second):
		return true, nil
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

// ExportMessages reads a complete (or limited) history through gotd and turns
// it into Telegram Desktop-compatible result.json messages. The downloader and
// renderer then use the same pipeline as a manually imported export.
func (s *OnlineService) Prepare(ns, peer string, chat OnlineChat, messages []map[string]any, media int) string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	token := hex.EncodeToString(buf)
	s.prepMu.Lock()
	defer s.prepMu.Unlock()
	now := time.Now()
	for key, item := range s.prepared {
		if now.Sub(item.createdAt) > 15*time.Minute {
			delete(s.prepared, key)
		}
	}
	s.prepared[token] = preparedExport{
		ns: ns, peer: peer, chat: chat, messages: messages, media: media, createdAt: now,
	}
	return token
}

func (s *OnlineService) TakePrepared(ns, peer, token string) (preparedExport, bool) {
	if token == "" {
		return preparedExport{}, false
	}
	s.prepMu.Lock()
	defer s.prepMu.Unlock()
	item, ok := s.prepared[token]
	if !ok {
		return preparedExport{}, false
	}
	delete(s.prepared, token)
	if item.ns != ns || item.peer != peer || time.Since(item.createdAt) > 15*time.Minute {
		return preparedExport{}, false
	}
	return item, true
}

func (s *OnlineService) DropPrepared(token string) {
	if token == "" {
		return
	}
	s.prepMu.Lock()
	delete(s.prepared, token)
	s.prepMu.Unlock()
}

func (s *OnlineService) ExportMessages(ctx context.Context, ns, proxy string, chat OnlineChat, timeout time.Duration, minID, limit int) (OnlineChat, []map[string]any, int, error) {
	return s.exportMessages(ctx, ns, proxy, chat, timeout, minID, limit, nil)
}

func (s *OnlineService) ExportMessagesProgress(ctx context.Context, ns, proxy string, chat OnlineChat, timeout time.Duration, minID, limit int, report func(ExportProgress)) (OnlineChat, []map[string]any, int, error) {
	return s.exportMessages(ctx, ns, proxy, chat, timeout, minID, limit, report)
}

func (s *OnlineService) exportMessages(ctx context.Context, ns, proxy string, chat OnlineChat, timeout time.Duration, minID, limit int, report func(ExportProgress)) (OnlineChat, []map[string]any, int, error) {
	baseID := minID
	reportExport(report, ExportProgress{Stage: "连接 Telegram", Percent: 2})
	ref := peerInputFromChat(chat)
	if ref == nil {
		return OnlineChat{}, nil, 0, errors.New("该会话缺少访问凭据，请刷新在线列表后重试")
	}
	blob, app, err := readTdlSession(ns)
	if err != nil {
		return OnlineChat{}, nil, 0, err
	}
	storage := &session.StorageMemory{}
	if err := storage.StoreSession(ctx, blob); err != nil {
		return OnlineChat{}, nil, 0, err
	}
	if timeout < 20*time.Second {
		timeout = 180 * time.Second
	}
	if timeout > 300*time.Second {
		timeout = 300 * time.Second
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

	out := make([]map[string]any, 0, 256)
	mediaCount := 0
	scanned := 0
	highID := chat.LastMessageID
	totalEstimate := 0
	lastPercent := 2.0
	err = client.Run(runCtx, func(ctx context.Context) error {
		offset := 0
		pages := 0
		for {
			var res tg.MessagesMessagesClass
			for {
				var err error
				res, err = client.API().MessagesGetHistory(ctx, &tg.MessagesGetHistoryRequest{
					Peer:     ref,
					OffsetID: offset,
					MinID:    minID,
					Limit:    100,
				})
				if err == nil {
					break
				}
				if d, ok := tgerr.AsFloodWait(err); ok {
					seconds := int(d.Seconds())
					if seconds < 1 {
						seconds = 1
					}
					reportExport(report, ExportProgress{
						Stage:   fmt.Sprintf("Telegram 限流，等待 %d 秒", seconds),
						Detail:  fmt.Sprintf("已读取 %d 条消息 · %d 个媒体", scanned, mediaCount),
						Percent: lastPercent, Messages: scanned, Media: mediaCount,
					})
				}
				retry, waitErr := waitFlood(ctx, err)
				if !retry {
					return waitErr
				}
			}
			msgs := historyMessages(res)
			if len(msgs) == 0 {
				break
			}
			entities := historyEntities(res)
			pageLowID := 0
			for _, msg := range msgs {
				id := messageID(msg)
				if id == 0 {
					continue
				}
				if id > highID {
					highID = id
				}
				if pageLowID == 0 || id < pageLowID {
					pageLowID = id
				}
				raw, hasMedia, ok := convertOnlineMessage(msg, chat, entities)
				if !ok {
					continue
				}
				out = append(out, raw)
				if hasMedia {
					mediaCount++
				}
				if limit > 0 && len(out) >= limit {
					break
				}
			}
			scanned += len(msgs)
			if baseID > 0 {
				if highID > baseID {
					totalEstimate = highID - baseID
				}
			} else if totalEstimate == 0 {
				if count := historyCount(res); count > 0 {
					totalEstimate = count
				}
			}
			if limit > 0 {
				lastPercent = float64(len(out)) * 100 / float64(limit)
			} else if totalEstimate > 0 {
				processed := scanned
				if baseID > 0 {
					processed = highID - pageLowID
				}
				if processed < 0 {
					processed = 0
				}
				lastPercent = float64(processed) * 100 / float64(totalEstimate)
			} else {
				// Private chats do not always expose a total count. Use a bounded,
				// monotonic page progress instead of pretending the absolute message
				// ID range is a message count (which produced 1% → 2% → 99%).
				lastPercent = 4 + float64(pages+1)*4
				if lastPercent > 92 {
					lastPercent = 92
				}
			}
			if lastPercent > 99 {
				lastPercent = 99
			}
			reportExport(report, ExportProgress{
				Stage:   "读取历史消息",
				Detail:  fmt.Sprintf("已读取 %d 条消息 · 发现 %d 个媒体", scanned, mediaCount),
				Percent: lastPercent, Messages: scanned, Media: mediaCount,
			})
			if limit > 0 && len(out) >= limit {
				break
			}
			if len(msgs) < 100 || pageLowID == 0 {
				break
			}
			offset = pageLowID
			pages++
			if pages%5 == 0 {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(120 * time.Millisecond):
				}
			}
		}
		return nil
	})
	if err != nil {
		return OnlineChat{}, nil, 0, err
	}
	sort.SliceStable(out, func(i, j int) bool {
		ai, _ := strconv.Atoi(fmt.Sprint(out[i]["id"]))
		aj, _ := strconv.Atoi(fmt.Sprint(out[j]["id"]))
		return ai < aj
	})
	reportExport(report, ExportProgress{
		Stage: "整理消息与媒体", Detail: fmt.Sprintf("已读取 %d 条消息 · 发现 %d 个媒体", scanned, mediaCount),
		Percent: 100, Messages: scanned, Media: mediaCount,
	})
	return chat, out, mediaCount, nil
}

func reportExport(report func(ExportProgress), p ExportProgress) {
	if report != nil {
		report(p)
	}
}

func historyCount(res tg.MessagesMessagesClass) int {
	switch page := res.(type) {
	case *tg.MessagesMessagesSlice:
		return page.Count
	case *tg.MessagesChannelMessages:
		return page.Count
	default:
		return 0
	}
}

func historyEntities(res tg.MessagesMessagesClass) tgpeer.Entities {
	var users tg.UserClassArray
	var chats tg.ChatClassArray
	switch page := res.(type) {
	case *tg.MessagesMessages:
		users, chats = page.Users, page.Chats
	case *tg.MessagesMessagesSlice:
		users, chats = page.Users, page.Chats
	case *tg.MessagesChannelMessages:
		users, chats = page.Users, page.Chats
	}
	return tgpeer.NewEntities(users.UserToMap(), chats.ChatToMap(), chats.ChannelToMap())
}

func historyMessages(res tg.MessagesMessagesClass) []tg.MessageClass {
	switch page := res.(type) {
	case *tg.MessagesMessages:
		return page.Messages
	case *tg.MessagesMessagesSlice:
		return page.Messages
	case *tg.MessagesChannelMessages:
		return page.Messages
	default:
		return nil
	}
}

func messageID(msg tg.MessageClass) int {
	switch m := msg.(type) {
	case *tg.Message:
		return m.ID
	case *tg.MessageService:
		return m.ID
	default:
		return 0
	}
}

func convertOnlineMessage(msg tg.MessageClass, chat OnlineChat, entities tgpeer.Entities) (map[string]any, bool, bool) {
	switch m := msg.(type) {
	case *tg.Message:
		raw := map[string]any{
			"id":            strconv.Itoa(m.ID),
			"type":          "message",
			"date":          localDate(m.Date),
			"date_unixtime": strconv.FormatInt(int64(m.Date), 10),
			"text":          m.Message,
			"from":          senderName(m, chat, entities),
			"from_id":       senderID(m, chat, entities),
			"media_type":    "",
			"file_size":     int64(0),
		}
		if m.PostAuthor != "" {
			raw["from"] = m.PostAuthor
		}
		if reply, ok := m.GetReplyTo(); ok {
			if head, ok := reply.(*tg.MessageReplyHeader); ok && head.ReplyToMsgID != 0 {
				raw["reply_to_message_id"] = strconv.Itoa(head.ReplyToMsgID)
			}
		}
		if fwd, ok := m.GetFwdFrom(); ok {
			name := fwd.FromName
			if name == "" {
				if p, ok := fwd.GetFromID(); ok {
					name = entityName(p, entities)
				}
			}
			if name != "" {
				raw["forwarded_from"] = name
			}
		}
		if m.ViaBotID != 0 {
			raw["via_bot"] = strconv.FormatInt(m.ViaBotID, 10)
		}
		if m.GroupedID != 0 {
			raw["grouped_id"] = strconv.FormatInt(m.GroupedID, 10)
		}
		if m.Views > 0 {
			raw["views"] = int64(m.Views)
		}
		if m.EditDate > 0 {
			raw["edited"] = localDate(m.EditDate)
			raw["edited_unixtime"] = strconv.FormatInt(int64(m.EditDate), 10)
		}
		if entities := textEntities(m.Message, m.Entities); len(entities) > 0 {
			raw["text_entities"] = entities
		}
		hasMedia := false
		if m.Media != nil {
			if kind, file, name, size, width, height, ok := mapOnlineMedia(m.Media); ok {
				hasMedia = true
				raw["media_type"] = kind
				if size > 0 {
					raw["file_size"] = size
				}
				if width > 0 && height > 0 {
					raw["width"] = width
					raw["height"] = height
				}
				if kind == "photo" {
					raw["photo"] = file
				} else {
					raw["file"] = file
					raw["file_name"] = name
				}
			}
		}
		if !hasMedia && m.Message == "" && m.Media != nil {
			raw["text"] = mediaFallback(m.Media)
		}
		return raw, hasMedia, true
	case *tg.MessageService:
		raw := map[string]any{
			"id":            strconv.Itoa(m.ID),
			"type":          "service",
			"date":          localDate(m.Date),
			"date_unixtime": strconv.FormatInt(int64(m.Date), 10),
			"text":          serviceText(m.Action),
			"from":          senderName(m, chat, entities),
			"from_id":       senderID(m, chat, entities),
		}
		return raw, false, true
	default:
		return nil, false, false
	}
}

func textEntities(text string, entities []tg.MessageEntityClass) []map[string]any {
	if text == "" || len(entities) == 0 {
		return nil
	}
	units := utf16.Encode([]rune(text))
	type span struct {
		offset, length int
		typ, href      string
	}
	spans := make([]span, 0, len(entities))
	for _, e := range entities {
		offset, length, typ, href, ok := entitySpan(e)
		if !ok || offset < 0 || length <= 0 || offset+length > len(units) {
			continue
		}
		spans = append(spans, span{offset: offset, length: length, typ: typ, href: href})
	}
	sort.SliceStable(spans, func(i, j int) bool {
		if spans[i].offset != spans[j].offset {
			return spans[i].offset < spans[j].offset
		}
		return spans[i].length > spans[j].length
	})
	out := make([]map[string]any, 0, len(spans)*2+1)
	cursor := 0
	for _, s := range spans {
		if s.offset < cursor {
			continue
		}
		if s.offset > cursor {
			out = append(out, map[string]any{"type": "plain", "text": string(utf16.Decode(units[cursor:s.offset]))})
		}
		segment := map[string]any{"type": s.typ, "text": string(utf16.Decode(units[s.offset : s.offset+s.length]))}
		if s.href != "" {
			segment["href"] = s.href
		}
		out = append(out, segment)
		cursor = s.offset + s.length
	}
	if cursor < len(units) {
		out = append(out, map[string]any{"type": "plain", "text": string(utf16.Decode(units[cursor:]))})
	}
	return out
}

func entitySpan(e tg.MessageEntityClass) (offset, length int, typ, href string, ok bool) {
	switch v := e.(type) {
	case *tg.MessageEntityBold:
		return v.Offset, v.Length, "bold", "", true
	case *tg.MessageEntityItalic:
		return v.Offset, v.Length, "italic", "", true
	case *tg.MessageEntityUnderline:
		return v.Offset, v.Length, "underline", "", true
	case *tg.MessageEntityStrike:
		return v.Offset, v.Length, "strikethrough", "", true
	case *tg.MessageEntitySpoiler:
		return v.Offset, v.Length, "spoiler", "", true
	case *tg.MessageEntityCode:
		return v.Offset, v.Length, "code", "", true
	case *tg.MessageEntityPre:
		return v.Offset, v.Length, "pre", "", true
	case *tg.MessageEntityBlockquote:
		return v.Offset, v.Length, "blockquote", "", true
	case *tg.MessageEntityTextURL:
		return v.Offset, v.Length, "text_link", v.URL, true
	case *tg.MessageEntityURL:
		return v.Offset, v.Length, "link", "", true
	case *tg.MessageEntityEmail:
		return v.Offset, v.Length, "email", "", true
	case *tg.MessageEntityMention:
		return v.Offset, v.Length, "mention", "", true
	case *tg.MessageEntityHashtag:
		return v.Offset, v.Length, "hashtag", "", true
	case *tg.MessageEntityCashtag:
		return v.Offset, v.Length, "hashtag", "", true
	case *tg.MessageEntityBotCommand:
		return v.Offset, v.Length, "bot_command", "", true
	case *tg.MessageEntityPhone:
		return v.Offset, v.Length, "phone", "", true
	default:
		return 0, 0, "", "", false
	}
}

func mediaFallback(media tg.MessageMediaClass) string {
	switch media.(type) {
	case *tg.MessageMediaGeo, *tg.MessageMediaGeoLive:
		return "[位置]"
	case *tg.MessageMediaContact:
		return "[联系人]"
	case *tg.MessageMediaPoll:
		return "[投票]"
	case *tg.MessageMediaDice:
		return "[骰子]"
	case *tg.MessageMediaVenue:
		return "[地点]"
	case *tg.MessageMediaWebPage:
		return "[链接]"
	default:
		return "[媒体]"
	}
}

func localDate(seconds int) string {
	return time.Unix(int64(seconds), 0).Local().Format("2006-01-02T15:04:05")
}

func senderName(m interface{ GetFromID() (tg.PeerClass, bool) }, chat OnlineChat, entities tgpeer.Entities) string {
	from, ok := m.GetFromID()
	if !ok {
		return chat.Name
	}
	return entityName(from, entities)
}

func senderID(m interface{ GetFromID() (tg.PeerClass, bool) }, chat OnlineChat, entities tgpeer.Entities) string {
	from, ok := m.GetFromID()
	if !ok {
		return "channel" + strconv.FormatInt(chat.ID, 10)
	}
	switch p := from.(type) {
	case *tg.PeerUser:
		return "user" + strconv.FormatInt(p.UserID, 10)
	case *tg.PeerChat:
		return "chat" + strconv.FormatInt(p.ChatID, 10)
	case *tg.PeerChannel:
		return "channel" + strconv.FormatInt(p.ChannelID, 10)
	default:
		return ""
	}
}

func entityName(peer tg.PeerClass, entities tgpeer.Entities) string {
	switch p := peer.(type) {
	case *tg.PeerUser:
		if u, ok := entities.User(p.UserID); ok {
			if name := strings.TrimSpace(strings.TrimSpace(u.FirstName) + " " + strings.TrimSpace(u.LastName)); name != "" {
				return name
			}
			if u.Username != "" {
				return "@" + u.Username
			}
			return strconv.FormatInt(u.ID, 10)
		}
	case *tg.PeerChat:
		if c, ok := entities.Chat(p.ChatID); ok {
			return c.Title
		}
	case *tg.PeerChannel:
		if c, ok := entities.Channel(p.ChannelID); ok {
			return c.Title
		}
	}
	return ""
}

func mapOnlineMedia(media tg.MessageMediaClass) (kind, file, name string, size int64, width, height int, ok bool) {
	switch m := media.(type) {
	case *tg.MessageMediaPhoto:
		photo, ok := m.Photo.(*tg.Photo)
		if !ok {
			return "", "", "", 0, 0, 0, false
		}
		width, height = photoDimensions(photo)
		return "photo", "photo.jpg", "photo.jpg", photoBytes(photo), width, height, true
	case *tg.MessageMediaDocument:
		doc, ok := m.Document.(*tg.Document)
		if !ok {
			return "", "", "", 0, 0, 0, false
		}
		kind = "file"
		fileName := ""
		round := false
		for _, attr := range doc.Attributes {
			switch a := attr.(type) {
			case *tg.DocumentAttributeFilename:
				fileName = a.FileName
			case *tg.DocumentAttributeVideo:
				width, height = a.W, a.H
				if a.RoundMessage {
					kind = "video_message"
					round = true
				} else {
					kind = "video_file"
				}
			case *tg.DocumentAttributeAudio:
				if a.Voice {
					kind = "voice_message"
				} else {
					kind = "audio_file"
				}
			case *tg.DocumentAttributeSticker:
				kind = "sticker"
			case *tg.DocumentAttributeAnimated:
				kind = "animation"
			}
		}
		_ = round
		ext := extensionForMime(doc.MimeType, kind)
		if fileName == "" {
			fileName = "media" + ext
		}
		fileName = filepath.Base(fileName)
		return kind, fileName, fileName, doc.Size, width, height, true
	default:
		return "", "", "", 0, 0, 0, false
	}
}

func photoDimensions(photo *tg.Photo) (width, height int) {
	for _, raw := range photo.Sizes {
		switch s := raw.(type) {
		case *tg.PhotoSize:
			if s.W*s.H > width*height {
				width, height = s.W, s.H
			}
		case *tg.PhotoSizeProgressive:
			if s.W*s.H > width*height {
				width, height = s.W, s.H
			}
		}
	}
	return width, height
}

// photoBytes returns the largest size Telegram advertises for a photo, which
// is the file the downloader will actually fetch.
func photoBytes(photo *tg.Photo) int64 {
	var size int64
	for _, raw := range photo.Sizes {
		switch s := raw.(type) {
		case *tg.PhotoSize:
			if int64(s.Size) > size {
				size = int64(s.Size)
			}
		case *tg.PhotoSizeProgressive:
			if len(s.Sizes) > 0 {
				if last := int64(s.Sizes[len(s.Sizes)-1]); last > size {
					size = last
				}
			}
		}
	}
	return size
}

func extensionForMime(mime, kind string) string {
	switch {
	case strings.HasPrefix(mime, "video/"):
		return ".mp4"
	case strings.HasPrefix(mime, "audio/"):
		return ".mp3"
	case strings.HasPrefix(mime, "image/"):
		return ".jpg"
	}
	switch kind {
	case "video_file", "video_message":
		return ".mp4"
	case "voice_message", "audio_file":
		return ".mp3"
	case "sticker":
		return ".webp"
	case "animation":
		return ".gif"
	default:
		return ""
	}
}

func serviceText(action tg.MessageActionClass) string {
	switch a := action.(type) {
	case *tg.MessageActionChatEditTitle:
		return "群组更名为「" + a.Title + "」"
	case *tg.MessageActionChatAddUser:
		return "有新成员加入群组"
	case *tg.MessageActionChatDeleteUser:
		return "有成员离开群组"
	case *tg.MessageActionPinMessage:
		return "置顶了一条消息"
	case *tg.MessageActionChannelCreate:
		return "创建了频道"
	case *tg.MessageActionChatJoinedByLink:
		return "通过链接加入群组"
	case *tg.MessageActionPhoneCall:
		return "通话记录"
	case *tg.MessageActionGroupCall:
		return "语音聊天"
	default:
		return "服务消息"
	}
}

type localOnlineArchive struct {
	slug      string
	dir       string
	existed   bool
	messages  int
	media     int
	updatedAt string
}

func (b *Bridge) localOnlineArchive(chat OnlineChat) localOnlineArchive {
	return b.localWorkspaceByID(strconv.FormatInt(chat.ID, 10))
}

func (b *Bridge) localWorkspaceByID(id string) localOnlineArchive {
	if id == "" {
		return localOnlineArchive{}
	}
	for _, c := range b.facade.ListChats() {
		if c.ID == id {
			return localOnlineArchive{
				slug: c.Slug, dir: c.Dir, existed: true,
				messages: c.Messages, media: c.Media, updatedAt: c.UpdatedAt,
			}
		}
	}
	return localOnlineArchive{}
}

func (b *Bridge) localWorkspaceBySlug(slug string) localOnlineArchive {
	if slug == "" {
		return localOnlineArchive{}
	}
	for _, c := range b.facade.ListChats() {
		if c.Slug == slug {
			return localOnlineArchive{
				slug: c.Slug, dir: c.Dir, existed: true,
				messages: c.Messages, media: c.Media, updatedAt: c.UpdatedAt,
			}
		}
	}
	return localOnlineArchive{}
}

func normalizeChatTitle(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// matchOnlineChatByName resolves an official ChatExport workspace, which carries
// only a title. Exact (case-insensitive) titles win; otherwise spacing and
// punctuation are ignored. More than one candidate is reported as ambiguous.
func matchOnlineChatByName(chats []OnlineChat, name string) (OnlineChat, int) {
	name = strings.TrimSpace(name)
	if name == "" {
		return OnlineChat{}, 0
	}
	var exact, normalized []OnlineChat
	wantNorm := normalizeChatTitle(name)
	for _, chat := range chats {
		if strings.EqualFold(strings.TrimSpace(chat.Name), name) {
			exact = append(exact, chat)
			continue
		}
		if wantNorm != "" && normalizeChatTitle(chat.Name) == wantNorm {
			normalized = append(normalized, chat)
		}
	}
	if len(exact) == 1 {
		return exact[0], 1
	}
	if len(exact) > 1 {
		return OnlineChat{}, len(exact)
	}
	if len(normalized) == 1 {
		return normalized[0], 1
	}
	return OnlineChat{}, len(normalized)
}

func findOnlineChatByID(chats []OnlineChat, id int64) (OnlineChat, bool) {
	for _, chat := range chats {
		if chat.ID == id {
			return chat, true
		}
	}
	return OnlineChat{}, false
}

// OnlineChatForSlug maps a local workspace back to its live Telegram dialog so
// the chat detail page can reuse the same preview/statistics pipeline as the
// online-chat page. Official ChatExports have no numeric id, so a title match
// against the live dialog list is used instead.
func (b *Bridge) OnlineChatForSlug(slug string) (OnlineChat, error) {
	var idText, localName string
	for _, chat := range b.facade.ListChats() {
		if chat.Slug == slug {
			idText = strings.TrimSpace(chat.ID)
			localName = strings.TrimSpace(chat.Name)
			break
		}
	}
	info := b.facade.AccountInfo()
	if !info.HasSessionFile {
		return OnlineChat{}, errors.New("尚未登录 Telegram，请先在账号管理完成登录")
	}
	var id int64
	if idText != "" {
		parsed, err := strconv.ParseInt(idText, 10, 64)
		if err != nil || parsed == 0 {
			return OnlineChat{}, errors.New("该聊天的 Chat ID 无法识别，无法在线更新")
		}
		id = parsed
	}
	live := b.online.Chats()
	if id > 0 {
		if chat, ok := findOnlineChatByID(live, id); ok {
			return chat, nil
		}
		if cached := b.online.Cached(info.Namespace); cached != nil {
			if chat, ok := findOnlineChatByID(cached.Chats, id); ok {
				return chat, nil
			}
		}
	} else {
		if chat, n := matchOnlineChatByName(live, localName); n == 1 {
			return chat, nil
		} else if n > 1 {
			return OnlineChat{}, fmt.Errorf("在线会话中有 %d 个同名聊天「%s」，无法自动确定；请先在“在线聊天”页确认目标聊天", n, localName)
		}
		if cached := b.online.Cached(info.Namespace); cached != nil {
			if chat, n := matchOnlineChatByName(cached.Chats, localName); n == 1 {
				return chat, nil
			} else if n > 1 {
				return OnlineChat{}, fmt.Errorf("在线会话中有 %d 个同名聊天「%s」，无法自动确定；请先在“在线聊天”页确认目标聊天", n, localName)
			}
		}
	}
	settings := b.facade.GetSettings()
	fetched, err := b.online.Fetch(context.Background(), info.Namespace, settings.Proxy, 45*time.Second)
	if err != nil {
		return OnlineChat{}, friendlyOnlineError(fmt.Errorf("无法读取在线会话：%w", err))
	}
	if id > 0 {
		if chat, ok := findOnlineChatByID(fetched.Chats, id); ok {
			return chat, nil
		}
		return OnlineChat{}, errors.New("该聊天不在当前 Telegram 会话列表中，请先到在线聊天页刷新")
	}
	if chat, n := matchOnlineChatByName(fetched.Chats, localName); n == 1 {
		return chat, nil
	} else if n > 1 {
		return OnlineChat{}, fmt.Errorf("在线会话中有 %d 个同名聊天「%s」，无法自动确定；请先在“在线聊天”页确认目标聊天", n, localName)
	}
	return OnlineChat{}, fmt.Errorf("在线会话中没有找到「%s」。请确认当前账号仍在该聊天中，或先在“在线聊天”页刷新列表", localName)
}

// resolveOnlineChat accepts cached peers and fetches the live dialog list only
// when the peer or its access hash is missing.
func (b *Bridge) resolveOnlineChat(peerKey string, timeout time.Duration) (OnlineChat, error) {
	info := b.facade.AccountInfo()
	settings := b.facade.GetSettings()
	chat, ok := b.online.Chat(peerKey)
	if !ok {
		if cached, found := b.online.CachedChat(info.Namespace, peerKey); found {
			chat = cached
			ok = true
		}
	}
	needsAccessHash := strings.HasPrefix(peerKey, "user:") || strings.HasPrefix(peerKey, "channel:")
	// A cached snapshot carries access hashes, so exporting while the list is
	// refreshing must not trigger a second full getDialogs request.
	if ok && (!needsAccessHash || chat.AccessHash != 0) {
		return chat, nil
	}
	if _, err := b.online.Fetch(context.Background(), info.Namespace, settings.Proxy, timeout); err != nil {
		if !ok {
			return OnlineChat{}, friendlyOnlineError(fmt.Errorf("无法读取在线会话：%w", err))
		}
		return OnlineChat{}, friendlyOnlineError(fmt.Errorf("该会话缺少访问凭据，请在网络恢复后刷新在线列表：%w", err))
	}
	if chat, ok = b.online.Chat(peerKey); ok {
		if needsAccessHash && chat.AccessHash == 0 {
			return OnlineChat{}, errors.New("该会话缺少访问凭据，请重新登录或稍后刷新在线列表")
		}
		return chat, nil
	}
	if cached, found := b.online.CachedChat(info.Namespace, peerKey); found {
		if needsAccessHash && cached.AccessHash == 0 {
			return OnlineChat{}, errors.New("该会话缺少访问凭据，请重新登录或稍后刷新在线列表")
		}
		return cached, nil
	}
	return OnlineChat{}, errors.New("该会话已不在当前账号的在线列表中，请刷新在线聊天页后重试")
}

func onlineStats(messages []map[string]any) (service, images, videos, audio, files, other, media int, size int64) {
	for _, raw := range messages {
		if raw["type"] == "service" {
			service++
			continue
		}
		kind, _ := raw["media_type"].(string)
		if kind == "" {
			continue
		}
		media++
		switch kind {
		case "photo":
			images++
		case "video_file", "video_message", "animation":
			videos++
		case "voice_message", "audio_file":
			audio++
		case "file", "sticker":
			files++
		default:
			other++
		}
		if n, ok := raw["file_size"].(int64); ok && n > 0 {
			size += n
		}
	}
	return
}

// OnlineExportPreview counts what an archive run would add and keeps the
// fetched messages so confirmation does not read the same history twice.
func (b *Bridge) OnlineExportPreview(peerKey string, timeout, limit int, targetSlug string) (OnlineExportPreview, error) {
	info := b.facade.AccountInfo()
	settings := b.facade.GetSettings()
	if targetSlug != "" {
		// Official-only workspaces gain a normalized source on first preview so the
		// local message ceiling is known before walking Telegram history.
		if err := b.facade.EnsureOfficialSource(targetSlug); err != nil {
			return OnlineExportPreview{}, err
		}
	}
	exportTimeout := time.Duration(timeout) * time.Second
	if exportTimeout <= 0 {
		exportTimeout = 180 * time.Second
	}
	ctx, cancel := context.WithCancel(context.Background())
	b.previewMu.Lock()
	if b.previewCancel != nil {
		b.previewCancel()
	}
	b.previewCancel = cancel
	b.previewMu.Unlock()
	defer func() {
		cancel()
		b.previewMu.Lock()
		b.previewCancel = nil
		b.previewMu.Unlock()
	}()
	b.setPreviewProgress(OnlineExportProgress{Active: true, Stage: "解析在线会话", Percent: 1})
	chat, err := b.resolveOnlineChat(peerKey, exportTimeout)
	if err != nil {
		return OnlineExportPreview{}, err
	}
	local := b.localOnlineArchive(chat)
	if targetSlug != "" && !local.existed {
		local = b.localWorkspaceBySlug(targetSlug)
	}
	var backfill takapp.BackfillPreviewDTO
	if local.existed && local.slug != "" {
		if p, e := b.facade.PreviewBackfill(local.slug); e == nil {
			backfill = p
		}
	}
	minID := 0
	if local.existed && local.dir != "" {
		minID = localMaxMessageID(local.dir)
	}
	b.setPreviewProgress(OnlineExportProgress{Active: true, Stage: "读取历史消息", Percent: 3})
	_, messages, media, err := b.online.ExportMessagesProgress(ctx, info.Namespace, settings.Proxy, chat, exportTimeout, minID, limit, func(p ExportProgress) {
		b.setPreviewProgress(OnlineExportProgress{
			Active: true, Stage: p.Stage, Detail: p.Detail,
			Percent: p.Percent, Messages: p.Messages, Media: p.Media,
		})
	})
	if err != nil {
		return OnlineExportPreview{}, friendlyOnlineError(err)
	}
	out := OnlineExportPreview{
		Peer: peerKey, Chat: chat.Name, Existed: local.existed,
		LocalMessages: local.messages, LocalMedia: local.media, LocalUpdatedAt: local.updatedAt,
		LocalMissing: backfill.Missing, MissingBytes: backfill.KnownBytes, FreeBytes: backfill.FreeBytes,
	}
	if len(messages) == 0 {
		if minID > 0 {
			if backfill.Missing > 0 {
				// result.json already holds the newest messages, but files from a
				// stopped download are still missing; offer to finish them.
				out.BackfillOnly = true
				out.Media = backfill.Missing
				out.Images = backfill.Images
				out.Videos = backfill.Videos
				out.Audio = backfill.Audio
				out.Files = backfill.Files
				out.Other = backfill.Other
				out.Bytes = backfill.KnownBytes
				out.SpaceNeedBytes = backfill.KnownBytes
				out.SpaceShort = backfill.SpaceShort
				return out, nil
			}
			out.UpToDate = true
			return out, nil
		}
		return OnlineExportPreview{}, errors.New("该会话没有可导出的消息")
	}
	service, images, videos, audio, files, other, _, size := onlineStats(messages)
	out.Messages = len(messages)
	out.Service = service
	out.Images = images
	out.Videos = videos
	out.Audio = audio
	out.Files = files
	out.Other = other
	out.Media = media
	out.Bytes = size
	out.SpaceNeedBytes = size + backfill.KnownBytes
	out.SpaceShort = backfill.FreeBytes > 0 && out.SpaceNeedBytes > 0 && backfill.FreeBytes < out.SpaceNeedBytes+onlineSpaceReserve
	out.Token = b.online.Prepare(info.Namespace, peerKey, chat, messages, media)
	return out, nil
}

const onlineSpaceReserve = int64(256 << 20)

func (b *Bridge) setPreviewProgress(p OnlineExportProgress) {
	b.previewMu.Lock()
	b.previewProgress = p
	b.previewMu.Unlock()
}

func (b *Bridge) OnlineExportPreviewProgress() OnlineExportProgress {
	b.previewMu.Lock()
	defer b.previewMu.Unlock()
	return b.previewProgress
}

func (b *Bridge) OnlineExportPreviewCancel() {
	b.previewMu.Lock()
	cancel := b.previewCancel
	if b.previewProgress.Active {
		b.previewProgress.Stage = "正在取消统计"
		b.previewProgress.Detail = "正在停止历史读取"
	}
	b.previewMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (b *Bridge) OnlineExportDiscard(token string) {
	b.online.DropPrepared(token)
}

// OnlineExport merges a gotd export into the current library and starts the
// normal media download + page build pipeline.
func (b *Bridge) OnlineExport(peerKey string, timeout, limit int, token, targetSlug string) (OnlineExportResult, error) {
	info := b.facade.AccountInfo()
	settings := b.facade.GetSettings()
	exportTimeout := time.Duration(timeout) * time.Second
	if exportTimeout <= 0 {
		exportTimeout = 180 * time.Second
	}
	chat, err := b.resolveOnlineChat(peerKey, exportTimeout)
	if err != nil {
		return OnlineExportResult{}, err
	}
	var messages []map[string]any
	var media int
	if prepared, ok := b.online.TakePrepared(info.Namespace, peerKey, token); ok {
		chat = prepared.chat
		messages = prepared.messages
		media = prepared.media
	}
	idText := strconv.FormatInt(chat.ID, 10)
	if targetSlug != "" {
		// Official ChatExports have no id. Persist a normalized source and the
		// resolved Telegram identity first so ImportJSONFiles merges only the new
		// history into that workspace by strong id instead of creating a duplicate.
		if err := b.facade.EnsureOfficialSource(targetSlug); err != nil {
			return OnlineExportResult{}, err
		}
		if err := b.facade.BindChatIdentity(targetSlug, idText, chat.Name, desktopChatType(chat)); err != nil {
			return OnlineExportResult{}, err
		}
	}
	local := b.localOnlineArchive(chat)
	existingSlug := local.slug
	existed := local.existed
	if targetSlug != "" && existingSlug == "" {
		existingSlug = targetSlug
		existed = true
	}
	var backfill takapp.BackfillPreviewDTO
	if existingSlug != "" {
		if p, e := b.facade.PreviewBackfill(existingSlug); e == nil {
			backfill = p
		}
	}
	if len(messages) == 0 {
		minID := 0
		if existed && local.dir != "" {
			minID = localMaxMessageID(local.dir)
		}
		_, messages, media, err = b.online.ExportMessages(context.Background(), info.Namespace, settings.Proxy, chat, exportTimeout, minID, limit)
		if err != nil {
			return OnlineExportResult{}, friendlyOnlineError(err)
		}
		if len(messages) == 0 {
			if minID > 0 {
				if backfill.Missing > 0 {
					// Nothing new to read, but a stopped download left files
					// missing; finish them from the local result.json.
					taskID, err := b.facade.StartOneClick(existingSlug)
					if err != nil {
						return OnlineExportResult{}, err
					}
					return OnlineExportResult{
						Slug: existingSlug, Chat: chat.Name, TaskID: taskID,
						Media: backfill.Missing, Existed: true,
					}, nil
				}
				return OnlineExportResult{Chat: chat.Name, Slug: existingSlug, Existed: true, UpToDate: true}, nil
			}
			return OnlineExportResult{}, errors.New("该会话没有可导出的消息")
		}
	}
	root := map[string]any{
		"name":     chat.Name,
		"type":     desktopChatType(chat),
		"id":       chat.ID,
		"messages": messages,
	}
	dir := filepath.Join(b.facade.ConfigDir(), "online-export")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return OnlineExportResult{}, err
	}
	tmp, err := os.CreateTemp(dir, "online-*.json")
	if err != nil {
		return OnlineExportResult{}, err
	}
	enc := json.NewEncoder(tmp)
	enc.SetIndent("", "  ")
	if err := enc.Encode(root); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return OnlineExportResult{}, err
	}
	tmp.Close()
	defer os.Remove(tmp.Name())

	chats, err := b.facade.ImportJSONFiles([]string{tmp.Name()})
	if err != nil {
		return OnlineExportResult{}, err
	}
	slug := existingSlug
	for _, c := range chats {
		if c.ID == idText {
			slug = c.Slug
			break
		}
	}
	if slug == "" {
		return OnlineExportResult{}, errors.New("导入完成但找不到对应聊天")
	}
	taskID, err := b.facade.StartOneClick(slug)
	if err != nil {
		return OnlineExportResult{}, err
	}
	return OnlineExportResult{
		Slug: slug, Chat: chat.Name, TaskID: taskID,
		Messages: len(messages), Media: media, Existed: existed,
	}, nil
}

func localMaxMessageID(workspace string) int {
	b, err := os.ReadFile(filepath.Join(workspace, "source", "result.json"))
	if err != nil {
		return 0
	}
	var root struct {
		Messages []map[string]any `json:"messages"`
	}
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.UseNumber()
	if dec.Decode(&root) != nil {
		return 0
	}
	maxID := 0
	for _, m := range root.Messages {
		if id, err := strconv.Atoi(fmt.Sprint(m["id"])); err == nil && id > maxID {
			maxID = id
		}
	}
	return maxID
}

func peerInputFromChat(chat OnlineChat) tg.InputPeerClass {
	switch {
	case strings.HasPrefix(chat.Peer, "user:"):
		return &tg.InputPeerUser{UserID: chat.ID, AccessHash: chat.AccessHash}
	case strings.HasPrefix(chat.Peer, "channel:"):
		return &tg.InputPeerChannel{ChannelID: chat.ID, AccessHash: chat.AccessHash}
	case strings.HasPrefix(chat.Peer, "chat:"):
		return &tg.InputPeerChat{ChatID: chat.ID}
	default:
		return nil
	}
}

func desktopChatType(chat OnlineChat) string {
	switch chat.Type {
	case "group":
		if chat.Username != "" {
			return "public_group"
		}
		return "private_group"
	case "channel":
		if chat.Username != "" {
			return "public_channel"
		}
		return "private_channel"
	default:
		return "personal_chat"
	}
}
