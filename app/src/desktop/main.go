package main

import (
	"embed"
	"io/fs"
	"log"
	"os"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"

	"telegramarchivekit/internal/model"
)

//go:embed all:frontend/dist
var embeddedAssets embed.FS

// DesktopService is the first RPC surface of the desktop client. Business
// services are added in later phases; P0 only proves the shell and binding path.
type DesktopService struct{}

func (d *DesktopService) Ping() string { return "pong" }

func (d *DesktopService) Version() string { return model.Version }

func main() {
	// The desktop exe is a windowed app: CLI output is only useful for the
	// headless smoke test, which writes a file instead of stdout.
	if handleHeadlessCLI(os.Args[1:]) {
		return
	}

	assets, err := fs.Sub(embeddedAssets, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}

	app := application.New(application.Options{
		Name:        "TelegramArchiveKit",
		Description: "Telegram Archive Kit 桌面客户端",
		Services: []application.Service{
			application.NewService(&DesktopService{}),
		},
		Assets: application.AssetOptions{
			Handler: application.BundledAssetFileServer(assets),
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.kkwans.telegramarchivekit",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				if w := application.Get().Window.Current(); w != nil {
					w.Show()
					w.Focus()
				}
			},
		},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true,
		},
	})

	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:     "main",
		Title:    "TelegramArchiveKit",
		Width:    1280,
		Height:   820,
		MinWidth: 1040,
		MinHeight: 680,
		Frameless: true,
		// Mica only works with a translucent background on Windows 11 22621+.
		// The frontend detects data-mica="off" and falls back to a solid surface.
		BackgroundType:   application.BackgroundTypeTranslucent,
		BackgroundColour: application.NewRGBA(247, 248, 251, 0),
		URL:              "/",
		Windows: application.WindowsWindow{
			BackdropType:           application.Mica,
			NonClientRegionSupport: true,
		},
	})
	win.Show()

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

func handleHeadlessCLI(args []string) bool {
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "--version":
		// No console under -H windowsgui, so the exit code is the contract.
		for i, a := range args {
			if a == "--out" && i+1 < len(args) {
				_ = os.WriteFile(args[i+1], []byte(`{"version":"`+model.Version+`","platform":"`+runtime.GOOS+`"}`), 0644)
				break
			}
		}
		os.Exit(0)
	case "--selftest":
		for i, a := range args {
			if a == "--out" && i+1 < len(args) {
				_ = os.WriteFile(args[i+1], []byte(`{"ok":true,"version":"`+model.Version+`"}`), 0644)
			}
		}
		os.Exit(0)
	}
	return false
}
