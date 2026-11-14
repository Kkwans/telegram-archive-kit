package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	credentialGeneric      = 1
	credentialLocalMachine = 2
	maxCredentialBlobSize  = 2560
)

var (
	credentialDLL = windows.NewLazySystemDLL("advapi32.dll")
	credRead      = credentialDLL.NewProc("CredReadW")
	credWrite     = credentialDLL.NewProc("CredWriteW")
	credDelete    = credentialDLL.NewProc("CredDeleteW")
	credFree      = credentialDLL.NewProc("CredFree")
)

// Layout of the Win32 CREDENTIALW structure.
type windowsCredential struct {
	flags, kind             uint32
	target, comment         *uint16
	lastWritten             windows.Filetime
	blobSize                uint32
	blob                    *byte
	persist, attributeCount uint32
	attributes              unsafe.Pointer
	alias, user             *uint16
}

func (s *remoteConnections) credentialTarget(c savedRemoteConnection) string {
	if c.SSHHost == "" {
		return ""
	}
	identity := strings.Join([]string{strings.ToLower(s.file), c.ID, strings.ToLower(c.SSHHost), c.SSHUser, strconv.Itoa(c.SSHPort), c.SSHKey}, "\x00")
	return fmt.Sprintf("TelegramArchiveKit/SSH/%x", sha256.Sum256([]byte(identity)))
}

func readSSHPassword(target string) (string, error) {
	name, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return "", err
	}
	var credential *windowsCredential
	ok, _, err := credRead.Call(uintptr(unsafe.Pointer(name)), credentialGeneric, 0, uintptr(unsafe.Pointer(&credential)))
	if ok == 0 {
		return "", err
	}
	defer credFree.Call(uintptr(unsafe.Pointer(credential)))
	if credential.blob == nil || credential.blobSize == 0 || credential.blobSize > maxCredentialBlobSize {
		return "", windows.ERROR_NOT_FOUND
	}
	blob := unsafe.Slice(credential.blob, int(credential.blobSize))
	defer clear(blob)
	return string(blob), nil
}

func writeSSHPassword(target, password string) error {
	if len(password) == 0 || len(password) > maxCredentialBlobSize {
		return errors.New("SSH 密码长度超出 Windows 凭据管理器支持的范围")
	}
	name, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	blob := []byte(password)
	defer clear(blob)
	credential := windowsCredential{kind: credentialGeneric, target: name, persist: credentialLocalMachine, blob: &blob[0], blobSize: uint32(len(blob))}
	if ok, _, err := credWrite.Call(uintptr(unsafe.Pointer(&credential)), 0); ok == 0 {
		return fmt.Errorf("Windows 凭据管理器无法保存 SSH 密码：%w", err)
	}
	return nil
}

func deleteSSHPassword(target string) error {
	name, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	if ok, _, err := credDelete.Call(uintptr(unsafe.Pointer(name)), credentialGeneric, 0); ok == 0 && !errors.Is(err, windows.ERROR_NOT_FOUND) {
		return fmt.Errorf("Windows 凭据管理器无法移除 SSH 密码：%w", err)
	}
	return nil
}
