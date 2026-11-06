package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/dcs"
	tgpeer "github.com/gotd/td/telegram/message/peer"
	"github.com/gotd/td/tg"
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

// ExportMessages reads a complete (or limited) history through gotd and turns
// it into Telegram Desktop-compatible result.json messages. The downloader and
// renderer then use the same pipeline as a manually imported export.
func (s *OnlineService) ExportMessages(ctx context.Context, ns, proxy, peerKey string, timeout time.Duration, minID, limit int) (OnlineChat, []map[string]any, int, error) {
	s.mu.Lock()
	chat, chatOK := s.chats[peerKey]
	ref, refOK := s.refs[peerKey]
	s.mu.Unlock()
	if !chatOK || !refOK {
		return OnlineChat{}, nil, 0, errors.New("在线列表已过期，请刷新后重试")
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
	err = client.Run(runCtx, func(ctx context.Context) error {
		offset := 0
		pages := 0
		for {
			res, err := client.API().MessagesGetHistory(ctx, &tg.MessagesGetHistoryRequest{
				Peer:     ref.peer,
				OffsetID: offset,
				MinID:    minID,
				Limit:    100,
			})
			if err != nil {
				return err
			}
			msgs := historyMessages(res)
			if len(msgs) == 0 {
				break
			}
			entities := historyEntities(res)
			minID := 0
			for _, msg := range msgs {
				id := messageID(msg)
				if id == 0 {
					continue
				}
				if minID == 0 || id < minID {
					minID = id
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
			if limit > 0 && len(out) >= limit {
				break
			}
			if len(msgs) < 100 || minID == 0 {
				break
			}
			offset = minID
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
	return chat, out, mediaCount, nil
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
			if kind, file, name, size, ok := mapOnlineMedia(m.Media); ok {
				hasMedia = true
				raw["media_type"] = kind
				if size > 0 {
					raw["file_size"] = size
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

func mapOnlineMedia(media tg.MessageMediaClass) (kind, file, name string, size int64, ok bool) {
	switch m := media.(type) {
	case *tg.MessageMediaPhoto:
		if _, ok := m.Photo.(*tg.Photo); !ok {
			return "", "", "", 0, false
		}
		return "photo", "photo.jpg", "photo.jpg", 0, true
	case *tg.MessageMediaDocument:
		doc, ok := m.Document.(*tg.Document)
		if !ok {
			return "", "", "", 0, false
		}
		kind = "file"
		fileName := ""
		round := false
		for _, attr := range doc.Attributes {
			switch a := attr.(type) {
			case *tg.DocumentAttributeFilename:
				fileName = a.FileName
			case *tg.DocumentAttributeVideo:
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
		return kind, fileName, fileName, doc.Size, true
	default:
		return "", "", "", 0, false
	}
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

// OnlineExport merges a gotd export into the current library and starts the
// normal media download + page build pipeline.
func (b *Bridge) OnlineExport(peerKey string, timeout, limit int) (OnlineExportResult, error) {
	info := b.facade.AccountInfo()
	settings := b.facade.GetSettings()
	existingSlug := ""
	existed := false
	idText := ""
	localDir := ""
	local := b.facade.ListChats()
	if meta, ok := b.online.Chat(peerKey); ok {
		idText = strconv.FormatInt(meta.ID, 10)
		for _, c := range local {
			if c.ID == idText {
				existingSlug = c.Slug
				localDir = c.Dir
				existed = true
				break
			}
		}
	}
	minID := 0
	if existed && localDir != "" {
		minID = localMaxMessageID(localDir)
	}
	chat, messages, media, err := b.online.ExportMessages(context.Background(), info.Namespace, settings.Proxy, peerKey, time.Duration(timeout)*time.Second, minID, limit)
	if err != nil {
		return OnlineExportResult{}, err
	}
	if len(messages) == 0 {
		if minID > 0 {
			return OnlineExportResult{Chat: chat.Name, Slug: existingSlug, Existed: true, UpToDate: true}, nil
		}
		return OnlineExportResult{}, errors.New("该会话没有可导出的消息")
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
