package app

import "telegramarchivekit/internal/model"

type (
	Entity             = model.Entity
	Reaction           = model.Reaction
	Media              = model.Media
	Message            = model.Message
	Chat               = model.Chat
	Stats              = model.Stats
	Archive            = model.Archive
	Report             = model.Report
	RawExport          = model.RawExport
	OfficialExportMeta = model.OfficialExportMeta
	WorkspaceMeta      = model.WorkspaceMeta
	LibraryChat        = model.LibraryChat
	LibraryManifest    = model.LibraryManifest
	Settings           = model.Settings
)

const (
	version          = model.Version
	schemaVersion    = model.SchemaVersion
	defaultNamespace = model.DefaultNamespace
)

func defaultSettings() Settings { return model.DefaultSettings() }
