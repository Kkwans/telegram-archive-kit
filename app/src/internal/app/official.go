package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"telegramarchivekit/internal/archive"
)

type officialIndexedExport struct {
	Meta  OfficialExportMeta `json:"meta"`
	Media map[string][]Media `json:"media"`
}

type officialIndexFile struct {
	Version   int                     `json:"version"`
	UpdatedAt string                  `json:"updated_at"`
	Exports   []officialIndexedExport `json:"exports"`
}

func (a *App) officialIndexPath(slug string) string {
	return filepath.Join(a.workspaceDir(slug), "official-media-index.json")
}

func (a *App) loadOfficialIndex(slug string) (officialIndexFile, error) {
	var idx officialIndexFile
	b, err := os.ReadFile(a.officialIndexPath(slug))
	if err != nil {
		if os.IsNotExist(err) {
			return idx, nil
		}
		return idx, err
	}
	err = json.Unmarshal(b, &idx)
	return idx, err
}

func (a *App) saveOfficialIndex(slug string, idx officialIndexFile) error {
	idx.Version = 1
	idx.UpdatedAt = time.Now().Format(time.RFC3339)
	return writeJSON(a.officialIndexPath(slug), idx)
}

func (a *App) officialMediaByID(slug string) map[string][]Media {
	idx, err := a.loadOfficialIndex(slug)
	if err != nil {
		return nil
	}
	out := map[string][]Media{}
	for _, ex := range idx.Exports {
		for id, files := range ex.Media {
			out[id] = archive.DedupeMedia(append(out[id], files...))
		}
	}
	return out
}

func (a *App) registerOfficialExport(slug, root, mode string) (OfficialExportMeta, error) {
	meta, media, err := archive.AnalyzeOfficialExport(root, a.workspaceDir(slug), mode)
	if err != nil {
		return OfficialExportMeta{}, err
	}
	idx, _ := a.loadOfficialIndex(slug)
	// Replace an existing record pointing to the same root, otherwise append.
	replaced := false
	for i := range idx.Exports {
		if strings.EqualFold(filepath.Clean(idx.Exports[i].Meta.Root), filepath.Clean(meta.Root)) {
			idx.Exports[i] = officialIndexedExport{Meta: meta, Media: media}
			replaced = true
			break
		}
	}
	if !replaced {
		idx.Exports = append(idx.Exports, officialIndexedExport{Meta: meta, Media: media})
	}
	if err := a.saveOfficialIndex(slug, idx); err != nil {
		return OfficialExportMeta{}, err
	}
	wm, _ := a.readWorkspaceMeta(slug)
	wm.OfficialExports = nil
	for _, x := range idx.Exports {
		wm.OfficialExports = append(wm.OfficialExports, x.Meta)
	}
	if wm.Slug == "" {
		wm.Slug = slug
	}
	if wm.Chat.Name == "" {
		wm.Chat.Name = meta.Name
	}
	wm.UpdatedAt = time.Now()
	_ = writeJSON(a.workspaceMetaPath(slug), wm)
	return meta, nil
}

func (a *App) managedOfficialRoot(slug, sourceName string) string {
	name := sanitizePathComponent(sourceName)
	if name == "" {
		name = "TelegramExport"
	}
	return filepath.Join(a.workspaceDir(slug), "official_exports", name)
}

func (a *App) primaryOfficialMessagesRel(slug string) string {
	idx, err := a.loadOfficialIndex(slug)
	if err != nil || len(idx.Exports) == 0 {
		return ""
	}
	ex := idx.Exports[0].Meta
	if ex.Mode == "referenced" {
		return archive.PathToFileURL(filepath.Join(ex.Root, "messages.html"))
	}
	// Root is stored relative to the workspace for managed/copied imports.
	root := filepath.FromSlash(ex.Root)
	if filepath.IsAbs(root) {
		rel, er := filepath.Rel(a.Settings.LibraryRoot, filepath.Join(root, "messages.html"))
		if er == nil {
			return filepath.ToSlash(rel)
		}
		return archive.PathToFileURL(filepath.Join(root, "messages.html"))
	}
	return filepath.ToSlash(filepath.Join("chats", slug, root, "messages.html"))
}
