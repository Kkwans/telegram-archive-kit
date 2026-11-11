package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"

	"rsc.io/qr"
	"telegramarchivekit/desktop/webpublish"
	"telegramarchivekit/internal/platform"
)

const restoreWebPublicationArg = "--restore-web-publication"

func (b *Bridge) publicationRPC(method string, raw json.RawMessage) (any, error) {
	if b.publication == nil {
		return nil, errors.New("网页部署尚未初始化")
	}
	switch method {
	case "webPublishStatus":
		return b.publication.Status(true), nil
	case "webPublishSave", "webPublishStart":
		var config webpublish.Config
		if err := json.Unmarshal(raw, &config); err != nil {
			return nil, errors.New("网页部署设置无效")
		}
		if err := b.publication.Save(config, method == "webPublishStart"); err != nil {
			return nil, err
		}
		return b.publication.Status(false), nil
	case "webPublishStop":
		if err := b.publication.Stop(); err != nil {
			return nil, err
		}
		return b.publication.Status(false), nil
	case "webPublishOpen", "webPublishQR":
		var p struct{ URL string }
		if json.Unmarshal(raw, &p) != nil || !b.publication.HasAddress(p.URL) {
			return nil, errors.New("该部署地址已不可用")
		}
		if method == "webPublishOpen" {
			return nil, platform.Open(p.URL)
		}
		code, err := qr.Encode(p.URL, qr.M)
		if err != nil {
			return nil, err
		}
		return "data:image/png;base64," + base64.StdEncoding.EncodeToString(code.PNG()), nil
	case "webPublishFirewall":
		return nil, platform.Open("windowsdefender:")
	case "webPublishNetworkSettings":
		return nil, platform.Open("ms-settings:network-status")
	default:
		return nil, errors.New("不支持的网页部署操作")
	}
}

func (b *Bridge) showWebPublication() {
	b.showWindow()
	if b.window != nil {
		b.window.ExecJS(`window.dispatchEvent(new Event('tak:show-web-publication'))`)
	}
}
