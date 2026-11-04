package main

import (
	"embed"
	"io/fs"
	"log"
	"os"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"

	takapp "telegramarchivekit/internal/app"
	"telegramarchivekit/internal/model"
)

//go:embed all:frontend/dist
var embeddedAssets embed.FS

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
	facade, err := takapp.OpenFacade()
	if err != nil {
		log.Fatal(err)
	}
	bridge := NewBridge(facade)

	windowsOpts := application.WindowsOptions{
		DisableQuitOnLastWindowClosed: true,
	}
	if os.Getenv("TAK_DEVTOOLS") == "1" {
		windowsOpts.AdditionalBrowserArgs = append(windowsOpts.AdditionalBrowserArgs, "--remote-debugging-port=9222")
	}

	app := application.New(application.Options{
		Name:        "TelegramArchiveKit",
		Description: "Telegram Archive Kit 桌面客户端",
		Assets: application.AssetOptions{
			Handler:    application.BundledAssetFileServer(assets),
			Middleware: bridge.Middleware,
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
		Windows: windowsOpts,
	})

	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:      "main",
		Title:     "TelegramArchiveKit",
		Width:     1280,
		Height:    820,
		MinWidth:  1040,
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
	bridge.Attach(win)

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
