package app

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func validWorkspaceSlug(slug string) bool {
	return slug != "" && slug != "." && slug != ".." &&
		slug == strings.TrimSpace(slug) && !strings.HasSuffix(slug, ".") &&
		!strings.ContainsAny(slug, `/\:`) && filepath.IsLocal(slug)
}

func checkedWorkspaceDir(libraryRoot, slug string) (string, error) {
	if libraryRoot == "" || !validWorkspaceSlug(slug) {
		return "", errors.New("无效的聊天标识")
	}
	chats := filepath.Join(libraryRoot, "chats")
	if err := checkWorkspaceDirectory(chats); err != nil {
		return "", err
	}
	root := filepath.Join(chats, slug)
	return root, checkWorkspaceDirectory(root)
}

func checkWorkspaceDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode().Type() != os.ModeDir {
		return errors.New("工作区路径必须是实际目录")
	}
	return nil
}

func cleanWorkspaceFile(rel string) (string, bool) {
	rel = strings.TrimSpace(strings.ReplaceAll(rel, "\\", "/"))
	if strings.ContainsRune(rel, ':') || hasParentSegment(rel) || !filepath.IsLocal(filepath.FromSlash(rel)) {
		return "", false
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(rel)))
	for _, part := range strings.Split(clean, "/") {
		if strings.TrimRight(part, ". ") != part {
			return "", false
		}
	}
	return clean, true
}

// Check each directory without following links. A scan may reuse the result
// for paths in the same directory. Opening an individual file checks again.
func checkWorkspaceParents(root, dir string, checked map[string]error) error {
	if dir == "." {
		return nil
	}
	if err, ok := checked[dir]; ok {
		return err
	}
	err := checkWorkspaceParents(root, filepath.Dir(dir), checked)
	if err == nil {
		err = checkWorkspaceDirectory(filepath.Join(root, dir))
	}
	if checked != nil {
		checked[dir] = err
	}
	return err
}

func checkedWorkspaceFile(root, rel string, checked map[string]error) (string, string, error) {
	clean, ok := cleanWorkspaceFile(rel)
	if !ok {
		return "", "", errors.New("无效的媒体路径")
	}
	if err := checkWorkspaceParents(root, filepath.Dir(filepath.FromSlash(clean)), checked); err != nil {
		return "", "", err
	}
	abs := filepath.Join(root, filepath.FromSlash(clean))
	info, err := os.Lstat(abs)
	if err != nil {
		return "", "", err
	}
	if !info.Mode().IsRegular() {
		return "", "", os.ErrNotExist
	}
	return abs, clean, nil
}
