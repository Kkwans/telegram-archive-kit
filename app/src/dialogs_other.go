//go:build !windows

package main

import "strings"

func selectJSONFiles() ([]string, error) {
	showCursor()
	defer hideCursor()
	p := readLinePrompt("请输入 result.json 路径")
	if p == "" {
		return nil, nil
	}
	return []string{strings.Trim(p, `"`)}, nil
}

func selectFolder(title, initial string) (string, error) {
	showCursor()
	defer hideCursor()
	p := readLinePrompt(title + "（默认 " + initial + "）")
	if strings.TrimSpace(p) == "" {
		return initial, nil
	}
	return strings.Trim(p, `"`), nil
}
