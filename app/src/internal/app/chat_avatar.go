package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	imagecolor "image/color"
	"image/draw"
	"image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	maxChatAvatarInputBytes  = 10 << 20
	maxChatAvatarDimension   = 8192
	maxChatAvatarPixels      = 12_000_000
	chatAvatarOutputSize     = 512
	maxChatAvatarOutputBytes = 2 << 20
)

func normalizeAvatarColor(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	if len(value) != 7 || value[0] != '#' {
		return "", errors.New("头像颜色需为 #RRGGBB 格式")
	}
	for _, ch := range value[1:] {
		if !(ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f' || ch >= 'A' && ch <= 'F') {
			return "", errors.New("头像颜色需为 #RRGGBB 格式")
		}
	}
	return strings.ToUpper(value), nil
}

func normalizeAvatarFontFamily(value string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "":
		return "", nil
	case "microsoft yahei":
		return "Microsoft YaHei", nil
	case "microsoft yahei ui":
		return "Microsoft YaHei UI", nil
	case "segoe ui":
		return "Segoe UI", nil
	case "dengxian":
		return "DengXian", nil
	case "simsun":
		return "SimSun", nil
	case "kaiti":
		return "KaiTi", nil
	case "arial":
		return "Arial", nil
	default:
		return "", errors.New("不支持的头像字体")
	}
}

func normalizeAvatarFontSize(value int) (int, error) {
	if value == 0 {
		return 0, nil
	}
	if value < 14 || value > 34 {
		return 0, errors.New("头像字号需在 14 到 34 之间")
	}
	return value, nil
}

func normalizeAvatarFontWeight(value int) (int, error) {
	if value == 0 {
		return 0, nil
	}
	if value < 400 || value > 900 || value%100 != 0 {
		return 0, errors.New("头像字重需为 400 到 900 之间的百位数")
	}
	return value, nil
}

func decodeChatAvatarData(value string) ([]byte, error) {
	const prefix = "data:image/jpeg;base64,"
	if !strings.HasPrefix(value, prefix) {
		return nil, errors.New("头像仅支持 PNG 或 JPG 图片")
	}
	encoded := strings.TrimPrefix(value, prefix)
	if len(encoded) > (maxChatAvatarInputBytes+2)/3*4 {
		return nil, errors.New("头像图片不能超过 10 MB")
	}
	decoded := make([]byte, base64.StdEncoding.DecodedLen(len(encoded)))
	n, err := base64.StdEncoding.Decode(decoded, []byte(encoded))
	if err != nil {
		return nil, errors.New("头像图片数据无效")
	}
	return encodeChatAvatar(bytes.NewReader(decoded[:n]))
}

func encodeChatAvatar(reader io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, maxChatAvatarInputBytes+1))
	if err != nil {
		return nil, errors.New("无法读取头像图片")
	}
	if len(data) == 0 || len(data) > maxChatAvatarInputBytes {
		return nil, errors.New("头像图片不能超过 10 MB")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || format != "jpeg" && format != "png" {
		return nil, errors.New("头像仅支持 PNG 或 JPG 图片")
	}
	width, height := config.Width, config.Height
	if width <= 0 || height <= 0 || width > maxChatAvatarDimension || height > maxChatAvatarDimension || int64(width)*int64(height) > maxChatAvatarPixels {
		return nil, errors.New("头像图片尺寸过大")
	}
	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, errors.New("头像图片无法解析")
	}
	scale := 1.0
	if max(width, height) > chatAvatarOutputSize {
		scale = float64(chatAvatarOutputSize) / float64(max(width, height))
	}
	outWidth := max(1, int(float64(width)*scale))
	outHeight := max(1, int(float64(height)*scale))
	canvas := image.NewRGBA(image.Rect(0, 0, outWidth, outHeight))
	draw.Draw(canvas, canvas.Bounds(), image.NewUniform(imagecolor.White), image.Point{}, draw.Src)
	draw.Draw(canvas, canvas.Bounds(), source, source.Bounds().Min, draw.Src)
	var out bytes.Buffer
	if err := jpeg.Encode(&out, canvas, &jpeg.Options{Quality: 88}); err != nil {
		return nil, errors.New("头像图片处理失败")
	}
	if out.Len() > maxChatAvatarOutputBytes {
		return nil, errors.New("头像图片处理结果过大")
	}
	return out.Bytes(), nil
}

func chatAvatarFilename(data []byte) string {
	sum := sha256.Sum256(data)
	return ".tak-avatar-" + hex.EncodeToString(sum[:8]) + ".jpg"
}

func validChatAvatarFilename(name string) bool {
	const prefix = ".tak-avatar-"
	const suffix = ".jpg"
	if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, suffix) || filepath.Base(name) != name {
		return false
	}
	hash := strings.TrimSuffix(strings.TrimPrefix(name, prefix), suffix)
	decoded, err := hex.DecodeString(hash)
	return err == nil && len(decoded) == 8
}

func removeChatAvatarFile(dir, name string) {
	if !validChatAvatarFilename(name) {
		return
	}
	_ = os.Remove(filepath.Join(dir, name))
}

func writeChatAvatarFile(dir string, data []byte) (string, error) {
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() {
		return "", errors.New("聊天目录不可写")
	}
	name := chatAvatarFilename(data)
	target := filepath.Join(dir, name)
	if info, err := os.Lstat(target); err == nil {
		if !info.Mode().IsRegular() {
			return "", errors.New("头像文件路径无效")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	file, err := os.CreateTemp(dir, ".tak-avatar-*")
	if err != nil {
		return "", err
	}
	temp := file.Name()
	defer os.Remove(temp)
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	written, err := os.ReadFile(temp)
	if err != nil {
		return "", err
	}
	if !bytes.Equal(written, data) {
		return "", errors.New("远程档案库未完整保存头像，原头像已保留")
	}
	if err := os.Rename(temp, target); err != nil {
		return "", fmt.Errorf("无法更新头像文件：%w", err)
	}
	if saved, err := os.ReadFile(target); err != nil || !bytes.Equal(saved, data) {
		return "", errors.New("头像文件保存后校验失败")
	}
	return name, nil
}

func (f *Facade) ChatAvatarFile(root, slug, name string) (string, error) {
	if root == "" || !validChatAvatarFilename(name) {
		return "", os.ErrNotExist
	}
	dir, err := checkedWorkspaceDir(root, slug)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, name)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxChatAvatarOutputBytes {
		return "", os.ErrNotExist
	}
	return path, nil
}
