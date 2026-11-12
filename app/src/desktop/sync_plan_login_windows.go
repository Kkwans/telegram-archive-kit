package main

import (
	"errors"
	"os"
	"slices"

	"golang.org/x/sys/windows/registry"
)

const (
	archiveStartupKey  = `Software\Microsoft\Windows\CurrentVersion\Run`
	archiveStartupName = "TelegramArchiveKit.SyncPlans"
	archiveStartupArg  = "--sync-plans-tray"
)

func archiveStartupCommand() (string, error) {
	exe, err := os.Executable()
	return `"` + exe + `" ` + archiveStartupArg, err
}

func getArchiveLaunchOnLogin() (bool, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, archiveStartupKey, registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer key.Close()
	value, _, err := key.GetStringValue(archiveStartupName)
	if errors.Is(err, registry.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	expected, err := archiveStartupCommand()
	return value == expected, err
}

func setArchiveLaunchOnLogin(enabled bool) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, archiveStartupKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	if !enabled {
		if err := key.DeleteValue(archiveStartupName); !errors.Is(err, registry.ErrNotExist) {
			return err
		}
		return nil
	}
	command, err := archiveStartupCommand()
	if err != nil {
		return err
	}
	return key.SetStringValue(archiveStartupName, command)
}

func archiveStartupInTray(args []string) bool {
	return slices.Contains(args, archiveStartupArg)
}
