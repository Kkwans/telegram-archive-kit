package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type RemoteToolsDTO struct {
	Rclone        bool     `json:"rclone"`
	WinFsp        bool     `json:"winFsp"`
	SSHFS         bool     `json:"sshfs"`
	Winget        bool     `json:"winget"`
	PowerShell    bool     `json:"powerShell"`
	OpenSSH       bool     `json:"openSSH"`
	SSHAliases    []string `json:"sshAliases,omitempty"`
	RcloneRemotes []string `json:"rcloneRemotes,omitempty"`
}

func fileExists(path string) bool {
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

func programFilesDir() string {
	if p := os.Getenv("ProgramFiles"); p != "" {
		return p
	}
	return `C:\Program Files`
}

func programFilesX86Dir() string {
	if p := os.Getenv("ProgramFiles(x86)"); p != "" {
		return p
	}
	return `C:\Program Files (x86)`
}

func findRclone() string {
	if p, err := exec.LookPath("rclone"); err == nil {
		return p
	}
	localApp := os.Getenv("LOCALAPPDATA")
	for _, p := range []string{
		filepath.Join(programFilesDir(), "rclone", "rclone.exe"),
		filepath.Join(localApp, "Microsoft", "WinGet", "Links", "rclone.exe"),
	} {
		if fileExists(p) {
			return p
		}
	}
	return ""
}

func findSSHFS() string {
	if p, err := exec.LookPath("sshfs"); err == nil {
		return p
	}
	for _, base := range []string{programFilesDir(), programFilesX86Dir()} {
		if p := filepath.Join(base, "SSHFS-Win", "bin", "sshfs.exe"); fileExists(p) {
			return p
		}
	}
	return ""
}

func hasWinFsp() bool {
	return fileExists(filepath.Join(programFilesDir(), "WinFsp")) || fileExists(filepath.Join(programFilesX86Dir(), "WinFsp"))
}

func (b *Bridge) RemoteTools() RemoteToolsDTO {
	_, sshErr := exec.LookPath("ssh.exe")
	out := RemoteToolsDTO{
		Rclone:     findRclone() != "",
		WinFsp:     hasWinFsp(),
		SSHFS:      findSSHFS() != "",
		Winget:     hiddenCommand("winget", "--version").Run() == nil,
		PowerShell: hiddenCommand("powershell", "-NoProfile", "-Command", "exit 0").Run() == nil,
		OpenSSH:    sshErr == nil,
		SSHAliases: sshAliases(),
	}
	if exe := findRclone(); exe != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		if raw, err := hiddenCommandContext(ctx, exe, "listremotes").Output(); err == nil {
			for _, line := range strings.Split(string(raw), "\n") {
				name := strings.TrimSpace(line)
				if name != "" {
					out.RcloneRemotes = append(out.RcloneRemotes, strings.TrimSuffix(name, ":"))
				}
			}
		}
	}
	return out
}
