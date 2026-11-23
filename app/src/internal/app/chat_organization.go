package app

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"telegramarchivekit/internal/model"
)

const chatOrganizationVersion = 1

// Organization is separate from workspace.json: background imports can update
// the original chat metadata without overwriting a user's display settings.
type chatGroupFile struct {
	Version int                         `json:"version"`
	Groups  []model.ChatGroup           `json:"groups"`
	Chats   map[string]chatPresentation `json:"chats,omitempty"`
}

type chatPresentation struct {
	Version     int    `json:"version"`
	DisplayName string `json:"display_name,omitempty"`
	GroupID     string `json:"group_id,omitempty"`
}

type ChatOrganizationEdit struct {
	LibraryKey string
	Action     string
	GroupID    string
	Name       string
	Slug       string
	Slugs      []string
}

type ChatOrganizationResult struct {
	Applied int `json:"applied"`
}

var chatOrganizationMu sync.Mutex
var libraryProjectionMu sync.Mutex

func readOrganizationJSON(path string, out any) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || info.Size() > 16<<20 {
		return false, errors.New("聊天整理数据不是可读取的普通文件")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(data, out); err != nil {
		return false, errors.New("聊天整理数据格式无效")
	}
	return true, nil
}

func readChatGroups(root string) ([]model.ChatGroup, error) {
	file, err := readChatOrganization(root)
	if err != nil {
		return nil, err
	}
	return file.Groups, nil
}

func readChatOrganization(root string) (chatGroupFile, error) {
	file := chatGroupFile{Version: chatOrganizationVersion, Groups: []model.ChatGroup{}, Chats: map[string]chatPresentation{}}
	dir := filepath.Join(root, "chat-organization-history")
	entries, dirErr := os.ReadDir(dir)
	if dirErr != nil && !errors.Is(dirErr, os.ErrNotExist) {
		return file, dirErr
	}
	hadSnapshots := false
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "snapshot-") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		hadSnapshots = true
		candidate := chatGroupFile{}
		if ok, err := readOrganizationJSON(filepath.Join(dir, entry.Name()), &candidate); err == nil && ok && validateChatOrganization(&candidate) == nil {
			return candidate, nil
		}
	}
	present, err := readOrganizationJSON(filepath.Join(root, "chat-groups.json"), &file)
	if err == nil && present {
		if err = validateChatOrganization(&file); err == nil {
			return file, nil
		}
	}
	if err == nil && !present && !hadSnapshots {
		return file, nil
	}
	if err == nil && hadSnapshots {
		err = errors.New("聊天整理快照不可读取")
	}
	// Older versions could leave an empty settings file on a mounted drive.
	// Recover only from an existing, valid library projection; never erase it.
	var manifest model.LibraryManifest
	if ok, projectionErr := readOrganizationJSON(filepath.Join(root, "library.json"), &manifest); projectionErr == nil && ok && len(manifest.Groups) > 0 {
		file = chatGroupFile{Version: chatOrganizationVersion, Groups: manifest.Groups, Chats: map[string]chatPresentation{}}
		for _, chat := range manifest.Chats {
			if chat.GroupID != "" || chat.DisplayName != "" {
				file.Chats[chat.Slug] = chatPresentation{Version: chatOrganizationVersion, GroupID: chat.GroupID, DisplayName: chat.DisplayName}
			}
		}
		if validateChatOrganization(&file) == nil {
			return file, nil
		}
	}
	return file, fmt.Errorf("聊天整理数据损坏且没有可恢复的网页索引：%w", err)
}

func validateChatOrganization(file *chatGroupFile) error {
	if file.Version != chatOrganizationVersion {
		return errors.New("不支持的聊天分组数据版本")
	}
	ids := make(map[string]bool, len(file.Groups))
	names := make(map[string]bool, len(file.Groups))
	for _, group := range file.Groups {
		name := strings.ToLower(strings.TrimSpace(group.Name))
		if group.ID == "" || name == "" || ids[group.ID] || names[name] {
			return errors.New("聊天分组数据包含重复或无效的分组")
		}
		ids[group.ID], names[name] = true, true
	}
	if file.Groups == nil {
		file.Groups = []model.ChatGroup{}
	}
	if file.Chats == nil {
		file.Chats = map[string]chatPresentation{}
	}
	return nil
}

func readChatPresentation(root, slug string) (chatPresentation, error) {
	var result chatPresentation
	organization, err := readChatOrganization(root)
	if err != nil {
		return result, err
	}
	return readChatPresentationFrom(root, slug, organization)
}

func readChatPresentationFrom(root, slug string, organization chatGroupFile) (chatPresentation, error) {
	var result chatPresentation
	if item, ok := organization.Chats[slug]; ok {
		return item, nil
	}
	dir, err := checkedWorkspaceDir(root, slug)
	if err != nil {
		return result, err
	}
	path := filepath.Join(dir, ".tak-presentation.json")
	if info, statErr := os.Lstat(path); statErr == nil && info.Mode().IsRegular() && info.Size() == 0 {
		return result, nil
	}
	present, err := readOrganizationJSON(path, &result)
	if err != nil {
		return result, err
	}
	if present && result.Version != chatOrganizationVersion {
		return result, errors.New("不支持的聊天显示设置版本")
	}
	return result, nil
}

func writeOrganizationJSON(root string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	dir := filepath.Join(root, "chat-organization-history")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	path := filepath.Join(dir, fmt.Sprintf("snapshot-%020d-%s.json", time.Now().UnixNano(), hex.EncodeToString(random[:])))
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	written, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if !bytes.Equal(written, data) {
		return errors.New("远程档案库未完整保存聊天整理数据，原设置已保留")
	}
	return nil
}

func organizationName(value string, allowEmpty bool, limit int) (string, error) {
	value = strings.TrimSpace(value)
	if (!allowEmpty && value == "") || utf8.RuneCountInString(value) > limit || strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return "", fmt.Errorf("名称需为 %d 个字符以内的单行文本", limit)
	}
	return value, nil
}

func groupExists(groups []model.ChatGroup, id string) bool {
	for _, group := range groups {
		if group.ID == id {
			return true
		}
	}
	return false
}

// EditChatOrganization writes only organization metadata in the selected
// library, then refreshes the existing library projections for both viewers.
func (f *Facade) EditChatOrganization(edit ChatOrganizationEdit) (ChatOrganizationResult, error) {
	chatOrganizationMu.Lock()
	defer chatOrganizationMu.Unlock()

	f.mu.Lock()
	currentRoot := strings.TrimSpace(f.a.Settings.LibraryRoot)
	a := appAtLibrary(f.a, currentRoot)
	f.mu.Unlock()
	root := strings.TrimSpace(a.Settings.LibraryRoot)
	if currentRoot == "" || edit.LibraryKey == "" || libraryFingerprint(root) != edit.LibraryKey {
		return ChatOrganizationResult{}, errors.New("档案库已切换，请重新打开聊天整理")
	}
	if err := a.guardWritable(); err != nil {
		return ChatOrganizationResult{}, err
	}
	organization, err := readChatOrganization(root)
	if err != nil {
		return ChatOrganizationResult{}, fmt.Errorf("无法读取聊天分组：%w", err)
	}
	groups := organization.Groups
	result := ChatOrganizationResult{}
	changed := false
	saveGroups := func() error {
		organization.Groups = groups
		return writeOrganizationJSON(root, organization)
	}
	switch edit.Action {
	case "create", "rename":
		name, err := organizationName(edit.Name, false, 80)
		if err != nil {
			return result, err
		}
		for _, group := range groups {
			if (edit.Action == "create" || group.ID != edit.GroupID) && strings.EqualFold(group.Name, name) {
				return result, errors.New("已经存在同名分组")
			}
		}
		if edit.Action == "create" {
			var id [16]byte
			if _, err := rand.Read(id[:]); err != nil {
				return result, err
			}
			groups = append(groups, model.ChatGroup{ID: hex.EncodeToString(id[:]), Name: name})
			changed = true
		} else {
			found := false
			for i := range groups {
				if groups[i].ID == edit.GroupID {
					found = true
					changed = groups[i].Name != name
					groups[i].Name = name
					break
				}
			}
			if !found {
				return result, errors.New("分组不存在，请刷新后重试")
			}
		}
		if changed {
			if err := saveGroups(); err != nil {
				return result, err
			}
			result.Applied = 1
		}
	case "delete":
		if !groupExists(groups, edit.GroupID) {
			return result, errors.New("分组不存在，请刷新后重试")
		}
		remaining := make([]model.ChatGroup, 0, len(groups)-1)
		for _, group := range groups {
			if group.ID != edit.GroupID {
				remaining = append(remaining, group)
			}
		}
		groups = remaining
		if err := saveGroups(); err != nil {
			return result, err
		}
		changed, result.Applied = true, 1
	case "alias", "assign":
		if edit.Action == "alias" {
			edit.Name, err = organizationName(edit.Name, true, 120)
			if err != nil {
				return result, err
			}
			edit.Slugs = []string{edit.Slug}
		} else if edit.GroupID != "" && !groupExists(groups, edit.GroupID) {
			return result, errors.New("目标分组不存在，请刷新后重试")
		}
		if len(edit.Slugs) == 0 {
			return result, errors.New("请先选择聊天")
		}
		seen := make(map[string]bool, len(edit.Slugs))
		ordered := make([]string, 0, len(edit.Slugs))
		for _, slug := range edit.Slugs {
			if seen[slug] {
				continue
			}
			seen[slug] = true
			if _, err := checkedWorkspaceDir(root, slug); err != nil {
				return result, fmt.Errorf("聊天不可用，请刷新后重试：%w", err)
			}
			ordered = append(ordered, slug)
		}
		for _, slug := range ordered {
			presentation, readErr := readChatPresentationFrom(root, slug, organization)
			if readErr != nil {
				err = readErr
				break
			}
			if edit.Action == "alias" {
				if presentation.DisplayName == edit.Name {
					continue
				}
				presentation.DisplayName = edit.Name
			} else {
				if presentation.GroupID == edit.GroupID {
					continue
				}
				presentation.GroupID = edit.GroupID
			}
			presentation.Version = chatOrganizationVersion
			organization.Chats[slug] = presentation
			changed = true
			result.Applied++
		}
		if err == nil && changed {
			err = saveGroups()
		}
		if err != nil {
			return ChatOrganizationResult{}, fmt.Errorf("未能保存聊天整理设置：%w", err)
		}
	default:
		return result, errors.New("未知的聊天整理操作")
	}
	if changed {
		if projectionErr := a.buildLibrary(); projectionErr != nil {
			if err != nil {
				return result, fmt.Errorf("已更新 %d 个聊天，其余未完成：%v；网页索引更新失败：%w", result.Applied, err, projectionErr)
			}
			return result, fmt.Errorf("设置已保存，但网页索引更新失败，请重试：%w", projectionErr)
		}
	}
	if err != nil {
		return result, fmt.Errorf("已更新 %d 个聊天，其余未完成：%w", result.Applied, err)
	}
	return result, nil
}
