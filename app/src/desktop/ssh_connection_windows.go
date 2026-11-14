package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

type sshConnectionInput struct {
	Alias, Host, User, Password, Key, Path string
	Drive, Label                           string
	Port                                   int
	UseRoot                                bool
	VerifySudo                             bool
}

type sshDirectory struct {
	Path    string   `json:"path"`
	Folders []string `json:"folders"`
	Library bool     `json:"library"`
}

func normalizePasswordEndpoint(e remoteEndpoint) (remoteEndpoint, error) {
	host := strings.TrimSpace(e.SSHHost)
	if addr, err := netip.ParseAddr(host); err == nil && addr.Zone() == "" {
		host = addr.String()
	} else if !sshTargetPattern.MatchString(host) || strings.Contains(host, "@") {
		return remoteEndpoint{}, errors.New("请输入 服务器的 IP 地址或主机名")
	}
	user := strings.TrimSpace(e.SSHUser)
	if !sshTargetPattern.MatchString(user) || strings.Contains(user, "@") {
		return remoteEndpoint{}, errors.New("请输入 服务器的 SSH 用户名")
	}
	if e.SSHPort < 1 || e.SSHPort > 65535 {
		return remoteEndpoint{}, errors.New("SSH 端口须在 1 到 65535 之间")
	}
	if _, err := parseServerKey(e.SSHKey); err != nil {
		return remoteEndpoint{}, err
	}
	if strings.ContainsAny(e.Path, "\\\x00\r\n") || e.Path != "" && !strings.HasPrefix(e.Path, "/") {
		return remoteEndpoint{}, errors.New("请选择 SFTP 目录")
	}
	if e.Path != "" {
		e.Path = path.Clean(e.Path)
	}
	e.Name = user + "@" + net.JoinHostPort(host, strconv.Itoa(e.SSHPort))
	e.SSHHost, e.SSHUser = host, user
	return e, nil
}

func parseServerKey(value string) (ssh.PublicKey, error) {
	fields := strings.Fields(value)
	if len(fields) == 2 && len(value) <= 8192 {
		if key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(value)); err == nil {
			return key, nil
		}
	}
	return nil, errors.New("请先核对并信任 服务器的 SSH 主机密钥")
}

func (b *Bridge) sshConnectionRPC(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	var in sshConnectionInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, errors.New("SSH 连接参数无效")
	}
	if method == "sshVerifyHost" {
		return verifySSHHost(ctx, strings.TrimSpace(in.Host), in.Port)
	}
	var endpoint remoteEndpoint
	var env []string
	var err error
	if in.Alias != "" {
		endpoint, err = sshEndpoint(in.Alias, in.Path)
		endpoint.SSHUseRoot = in.UseRoot
	} else {
		endpoint, err = normalizePasswordEndpoint(remoteEndpoint{
			Kind: "ssh", SSHHost: in.Host, SSHUser: in.User, SSHPort: in.Port, SSHKey: in.Key, Path: in.Path, SSHUseRoot: in.UseRoot,
		})
		if err == nil {
			env, err = passwordMountEnv(ctx, endpoint, in.Password)
		}
	}
	if err != nil {
		return nil, err
	}
	if method == "sshBrowse" {
		if endpoint.SSHUseRoot && (in.VerifySudo || endpoint.Path == "") {
			if err := verifySudoSFTP(ctx, endpoint, in.Password); err != nil {
				return nil, err
			}
		}
		dir, err := browseSSH(ctx, endpoint, env)
		return dir, err
	}
	if endpoint.Path == "" {
		return nil, errors.New("请先选择 远程档案库目录")
	}
	endpoint.Drive = normalizeMountDrive(in.Drive)
	if err := validateSSHDrive(endpoint.Drive); err != nil {
		return nil, err
	}
	if err := validateRemoteLabel(in.Label, true); err != nil {
		return nil, err
	}
	endpoint.VolumeName = strings.TrimSpace(in.Label)
	if endpoint.VolumeName == "" {
		endpoint.VolumeName = path.Base(endpoint.Path)
	}
	expectedID := b.expectedMountID(endpoint)
	if endpoint.SSHUseRoot {
		if err := verifySudoSFTP(ctx, endpoint, in.Password); err != nil {
			return nil, err
		}
	}
	if env == nil {
		root, _, err := b.mountSSH(ctx, endpoint, expectedID, true)
		return root, err
	}
	root, _, err := b.startRemoteMount(ctx, endpoint, ":sftp:", expectedID, false, sshPasswordOptions(endpoint), env, verifySSHLibrary)
	return root, err
}

func validateSSHDrive(drive string) error {
	if drive != "" && (len(drive) != 1 || drive[0] < 'D' || drive[0] > 'Z') {
		return errors.New("请选择 D 到 Z 之间的可用盘符")
	}
	return nil
}

func verifySSHHost(ctx context.Context, host string, port int) (any, error) {
	if addr, err := netip.ParseAddr(host); err == nil && addr.Zone() == "" {
		host = addr.String()
	} else if !sshTargetPattern.MatchString(host) || strings.Contains(host, "@") {
		return nil, errors.New("请输入 服务器的 IP 地址或主机名")
	}
	if port < 1 || port > 65535 {
		return nil, errors.New("SSH 端口须在 1 到 65535 之间")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, errors.New("无法连接 SSH 端口，请检查 服务器地址、端口和网络")
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	var key ssh.PublicKey
	_, _, _, _ = ssh.NewClientConn(conn, addr, &ssh.ClientConfig{User: "tak", HostKeyCallback: func(_ string, _ net.Addr, serverKey ssh.PublicKey) error {
		key = serverKey
		return errors.New("host key inspection complete")
	}})
	if key == nil {
		return nil, errors.New("端口已连通，但未收到 SSH 主机密钥")
	}
	return map[string]string{"key": strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))), "fingerprint": ssh.FingerprintSHA256(key), "type": key.Type()}, nil
}

var passwordMountOptions = []string{"--config", "NUL", "--log-level", "ERROR", "--sftp-disable-hashcheck", "--sftp-shell-type", "none", "--retries", "1", "--timeout", "12s", "--contimeout", "8s"}

const sudoSFTPServer = `for server in /usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/openssh/sftp-server /usr/libexec/sftp-server; do if test -x "$server"; then printf 'TAK_SUDO_SFTP\n' >&2; exec sudo -n -u root -- "$server"; fi; done; echo TAK_SFTP_SERVER_MISSING >&2; exit 127`

func verifySudoSFTP(ctx context.Context, endpoint remoteEndpoint, password string) error {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if endpoint.SSHHost == "" {
		cmd := hiddenCommandContext(ctx, "ssh.exe", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ConnectTimeout=5", endpoint.Name, sudoSFTPServer)
		return probeOpenSSHSudo(cmd)
	}
	addr := net.JoinHostPort(endpoint.SSHHost, strconv.Itoa(endpoint.SSHPort))
	pinned, err := parseServerKey(endpoint.SSHKey)
	if err != nil {
		return err
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return remoteError("offline", "无法连接服务器以验证 sudo 权限")
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	config := &ssh.ClientConfig{User: endpoint.SSHUser, Auth: []ssh.AuthMethod{ssh.Password(password)}, HostKeyCallback: ssh.FixedHostKey(pinned)}
	sshConn, channels, requests, err := ssh.NewClientConn(conn, addr, config)
	if err != nil {
		return remoteError("authentication_required", "无法验证 SSH 登录，请检查账号、密码和服务器主机密钥")
	}
	client := ssh.NewClient(sshConn, channels, requests)
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		return remoteError("authentication_required", "服务器未允许执行 sudo 验证")
	}
	defer session.Close()
	// Require a protocol response from the exact command used for the mount.
	stdout, err := session.StdoutPipe()
	if err != nil {
		return err
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		return err
	}
	defer stdin.Close()
	stderr, err := session.StderrPipe()
	if err != nil {
		return err
	}
	if err := session.Start(sudoSFTPServer); err != nil {
		return remoteError("authentication_required", "服务器未允许启动 sudo SFTP")
	}
	return verifySudoHandshake(stdin, stdout, stderr)
}

func probeOpenSSHSudo(cmd *exec.Cmd) error {
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	defer stdin.Close()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return remoteError("authentication_required", "无法启动 Windows OpenSSH，请检查 SSH 客户端")
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()
	return verifySudoHandshake(stdin, stdout, stderr)
}

func verifySudoHandshake(stdin io.Writer, stdout, stderr io.Reader) error {
	if _, err := io.WriteString(stdin, "\x00\x00\x00\x05\x01\x00\x00\x00\x03"); err != nil {
		return remoteError("authentication_required", "无法打开 sudo SFTP 会话")
	}
	if marker, _ := bufio.NewReader(io.LimitReader(stderr, 1024)).ReadString('\n'); strings.TrimSpace(marker) != "TAK_SUDO_SFTP" {
		if strings.Contains(marker, "Host key verification failed") || strings.Contains(marker, "host key is known") {
			return remoteError("authentication_required", "OpenSSH 主机密钥尚未获信任或已变更，请先在终端核对后重试")
		}
		if strings.Contains(marker, "Permission denied") {
			return remoteError("authentication_required", "OpenSSH 免密认证失败，请用相同目标在终端确认可以免密登录")
		}
		return remoteError("authentication_required", "未能启动 sudo SFTP，请检查 SSH 登录和服务器命令权限")
	}
	var header [9]byte
	if _, err := io.ReadFull(stdout, header[:]); err != nil || binary.BigEndian.Uint32(header[:4]) < 5 || header[4] != 2 || binary.BigEndian.Uint32(header[5:]) != 3 {
		return remoteError("authentication_required", "sudo 测试未通过：服务器须允许当前账号免交互启动 OpenSSH SFTP")
	}
	return nil
}

func sshPasswordOptions(endpoint remoteEndpoint) []string {
	if !endpoint.SSHUseRoot {
		return passwordMountOptions
	}
	// SFTP owns stdin/stdout. Never mix a sudo password into its protocol.
	return append(slices.Clone(passwordMountOptions), "--sftp-server-command", sudoSFTPServer)
}

func passwordMountEnv(ctx context.Context, endpoint remoteEndpoint, password string) ([]string, error) {
	if password == "" || len(password) > 4096 || strings.ContainsAny(password, "\x00\r\n") {
		return nil, errors.New("请输入 SSH 登录密码")
	}
	exe := findRclone()
	if exe == "" {
		return nil, errors.New("请先安装 rclone")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := hiddenCommandContext(ctx, exe, "obscure", "-")
	cmd.Stdin = strings.NewReader(password + "\n")
	out, err := cmd.Output()
	if err != nil {
		return nil, errors.New("无法准备 SSH 认证，请检查 rclone 安装")
	}
	env := slices.DeleteFunc(os.Environ(), func(item string) bool {
		key, _, _ := strings.Cut(item, "=")
		return strings.HasPrefix(strings.ToUpper(key), "RCLONE_")
	})
	return append(env, "RCLONE_SFTP_HOST="+endpoint.SSHHost, "RCLONE_SFTP_USER="+endpoint.SSHUser,
		"RCLONE_SFTP_PORT="+strconv.Itoa(endpoint.SSHPort), "RCLONE_SFTP_HOST_KEYS="+endpoint.SSHKey,
		"RCLONE_SFTP_PASS="+strings.TrimSpace(string(out))), nil
}

func browseSSH(ctx context.Context, endpoint remoteEndpoint, env []string) (sshDirectory, error) {
	exe := findRclone()
	if exe == "" {
		return sshDirectory{}, errors.New("请先安装 rclone")
	}
	dir := endpoint.Path
	if dir == "" {
		dir = "/"
	}
	options := sshPasswordOptions(endpoint)
	if env == nil {
		var err error
		options, err = aliasMountOptions(endpoint.Name, endpoint.SSHUseRoot)
		if err != nil {
			return sshDirectory{}, err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 14*time.Second)
	defer cancel()
	cmd := hiddenCommandContext(ctx, exe, append([]string{"lsjson", ":sftp:" + dir, "--no-modtime", "--no-mimetype", "--ask-password=false"}, options...)...)
	cmd.Env = env
	return readSSHDirectory(cmd, dir)
}

func readSSHDirectory(cmd *exec.Cmd, dir string) (sshDirectory, error) {
	var report mountReport
	cmd.Stderr = &report
	cmd.WaitDelay = 2 * time.Second
	out, err := cmd.StdoutPipe()
	if err != nil {
		return sshDirectory{}, err
	}
	if err := cmd.Start(); err != nil {
		return sshDirectory{}, errors.New("无法启动 rclone")
	}
	result := sshDirectory{Path: dir, Folders: []string{}}
	reader := json.NewDecoder(bufio.NewReader(io.LimitReader(out, 16<<20)))
	start, decodeErr := reader.Token()
	if decodeErr == nil && start == json.Delim('[') {
		for reader.More() {
			var item struct {
				Name  string
				IsDir bool
			}
			if decodeErr = reader.Decode(&item); decodeErr != nil {
				break
			}
			// Include dot-prefixed folders advertised by the SFTP account.
			if item.IsDir && item.Name != "." && item.Name != ".." && item.Name != "" && !strings.ContainsAny(item.Name, "/\\\x00\r\n") {
				result.Folders = append(result.Folders, item.Name)
			}
			if !item.IsDir && item.Name == "library.json" {
				result.Library = true
			}
		}
		if decodeErr == nil {
			_, decodeErr = reader.Token()
		}
	} else if decodeErr == nil {
		decodeErr = fmt.Errorf("invalid listing")
	}
	if decodeErr == nil {
		var extra any
		if err := reader.Decode(&extra); !errors.Is(err, io.EOF) {
			decodeErr = errors.New("invalid listing")
		}
	}
	if decodeErr != nil && !errors.Is(decodeErr, io.EOF) {
		_ = cmd.Process.Kill()
	}
	_ = out.Close()
	if err := cmd.Wait(); err != nil {
		failure := report.failure(false)
		if failure.status != "error" {
			return sshDirectory{}, failure
		}
		return sshDirectory{}, errors.New("未能浏览 SFTP 目录，请确认 服务器已启用 SFTP 且账号有读取权限")
	}
	if decodeErr != nil {
		return sshDirectory{}, errors.New("未能读取 SFTP 目录，请确认服务已启用且账号具有目录权限")
	}
	slices.Sort(result.Folders)
	return result, nil
}

func verifySSHLibrary(root string) error {
	if info, err := os.Stat(filepath.Join(root, "library.json")); err != nil || !info.Mode().IsRegular() {
		return errors.New("未能读取 library.json，请选择 远程档案库根目录")
	}
	return nil
}
