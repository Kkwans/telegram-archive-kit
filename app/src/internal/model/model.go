package model

import "time"

const Version = "1.0"
const SchemaVersion = 9
const DefaultNamespace = "telegram-archive-kit"

type Entity struct {
	Type string `json:"type"`
	Text string `json:"text"`
	Href string `json:"href,omitempty"`
}

type Reaction struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
}

type Media struct {
	Path  string `json:"path"`
	Thumb string `json:"thumb,omitempty"`
	Name  string `json:"name"`
	Kind  string `json:"kind"`
	Size  int64  `json:"size"`
	Ext   string `json:"ext,omitempty"`
}

type Message struct {
	ID            string     `json:"id"`
	Type          string     `json:"type"`
	Date          string     `json:"date"`
	TS            int64      `json:"ts"`
	Edited        string     `json:"edited,omitempty"`
	EditedTS      int64      `json:"edited_ts,omitempty"`
	From          string     `json:"from,omitempty"`
	FromID        string     `json:"from_id,omitempty"`
	Text          string     `json:"text,omitempty"`
	Entities      []Entity   `json:"entities,omitempty"`
	ReplyTo       string     `json:"reply_to,omitempty"`
	ForwardedFrom string     `json:"forwarded_from,omitempty"`
	ViaBot        string     `json:"via_bot,omitempty"`
	GroupedID     string     `json:"grouped_id,omitempty"`
	SourceIDs     []string   `json:"source_ids,omitempty"`
	Views         int64      `json:"views,omitempty"`
	Reactions     []Reaction `json:"reactions,omitempty"`
	MediaType     string     `json:"media_type,omitempty"`
	ExpectedMedia bool       `json:"expected_media,omitempty"`
	ExpectedSize  int64      `json:"expected_size,omitempty"`
	Media         []Media    `json:"media,omitempty"`
}

type Chat struct {
	Name string `json:"name"`
	Type string `json:"type,omitempty"`
	ID   string `json:"id,omitempty"`
}

type Stats struct {
	Messages             int `json:"messages"`
	MediaFiles           int `json:"media_files"`
	Images               int `json:"images"`
	Videos               int `json:"videos"`
	Audio                int `json:"audio"`
	Files                int `json:"files"`
	ExpectedMedia        int `json:"expected_media_messages"`
	MissingMedia         int `json:"missing_media_messages"`
	SizeMismatch         int `json:"size_mismatch_messages"`
	UnmatchedFiles       int `json:"unmatched_media_files"`
	MissingVideoPreviews int `json:"missing_video_previews,omitempty"`
	MissingImagePreviews int `json:"missing_image_previews,omitempty"`
}

type Archive struct {
	SchemaVersion int       `json:"schema_version"`
	Generator     string    `json:"generator"`
	GeneratedAt   string    `json:"generated_at"`
	Chat          Chat      `json:"chat"`
	Messages      []Message `json:"messages"`
	Stats         Stats     `json:"stats"`
	Missing       []string  `json:"missing_media_message_ids,omitempty"`
	Unmatched     []string  `json:"unmatched_media_files,omitempty"`
}

type Report struct {
	Version     string   `json:"version"`
	GeneratedAt string   `json:"generated_at"`
	Chat        Chat     `json:"chat"`
	Stats       Stats    `json:"stats"`
	Missing     []string `json:"missing_media_message_ids"`
	Unmatched   []string `json:"unmatched_media_files"`
	Status      string   `json:"status"`
}

type RawExport struct {
	Name     string           `json:"name"`
	Type     string           `json:"type"`
	ID       any              `json:"id"`
	Messages []map[string]any `json:"messages"`
}

type OfficialExportMeta struct {
	Name           string    `json:"name"`
	Root           string    `json:"root"`
	Mode           string    `json:"mode"` // managed | copied | referenced
	ImportedAt     time.Time `json:"imported_at"`
	FirstMessageID string    `json:"first_message_id,omitempty"`
	LastMessageID  string    `json:"last_message_id,omitempty"`
	MessageCount   int       `json:"message_count"`
	MediaMessages  int       `json:"media_messages"`
	MediaFiles     int       `json:"media_files"`
}

type WorkspaceMeta struct {
	Slug            string               `json:"slug"`
	Chat            Chat                 `json:"chat"`
	ImportedAt      time.Time            `json:"imported_at"`
	UpdatedAt       time.Time            `json:"updated_at"`
	MessageCount    int                  `json:"message_count"`
	MediaCount      int                  `json:"media_count"`
	MissingCount    int                  `json:"missing_count"`
	FirstTS         int64                `json:"first_ts,omitempty"`
	LastTS          int64                `json:"last_ts,omitempty"`
	SourceVersion   string               `json:"source_version,omitempty"`
	ExternalStorage string               `json:"external_storage,omitempty"`
	OfficialExports []OfficialExportMeta `json:"official_exports,omitempty"`
}

type LibraryChat struct {
	Slug            string `json:"slug"`
	Name            string `json:"name"`
	Type            string `json:"type,omitempty"`
	ID              string `json:"id,omitempty"`
	Messages        int    `json:"messages"`
	MediaFiles      int    `json:"media_files"`
	Pages           int    `json:"pages,omitempty"`
	Images          int    `json:"images"`
	Videos          int    `json:"videos"`
	Audio           int    `json:"audio"`
	Files           int    `json:"files"`
	Missing         int    `json:"missing"`
	FirstTS         int64  `json:"first_ts,omitempty"`
	LastTS          int64  `json:"last_ts,omitempty"`
	ImportedAt      string `json:"imported_at,omitempty"`
	UpdatedAt       string `json:"updated_at"`
	FolderName      string `json:"folder_name,omitempty"`
	OfficialExports int    `json:"official_exports,omitempty"`
	DataScript      string `json:"data_script"`
	SourceRel       string `json:"source_rel"`
	ReportRel       string `json:"report_rel"`
	WorkspaceRel    string `json:"workspace_rel"`
	MessagesRel     string `json:"messages_rel,omitempty"`
}

type LibraryManifest struct {
	SchemaVersion int           `json:"schema_version"`
	Generator     string        `json:"generator"`
	GeneratedAt   string        `json:"generated_at"`
	Chats         []LibraryChat `json:"chats"`
}

type Settings struct {
	SchemaVersion          int      `json:"schema_version,omitempty"`
	LibraryRoot            string   `json:"library_root"`
	TdlNamespace           string   `json:"tdl_namespace"`
	Concurrent             int      `json:"concurrent"`
	Threads                int      `json:"threads"`
	ReconnectTimeout       string   `json:"reconnect_timeout"`
	Proxy                  string   `json:"proxy,omitempty"`
	MaxRepairPasses        int      `json:"max_repair_passes"`
	OpenAfterBuild         bool     `json:"open_after_build"`
	LastWorkspaceSlug      string   `json:"last_workspace_slug,omitempty"`
	LibraryHistory         []string `json:"library_history,omitempty"`
	NetworkRetryMinutes    int      `json:"network_retry_minutes,omitempty"`
	UnknownRetryCount      int      `json:"unknown_retry_count,omitempty"`
	ConfirmedLegacyLibrary string   `json:"confirmed_legacy_library,omitempty"`
	GenerateThumbnails     bool     `json:"generate_thumbnails"`
	StallTimeoutSeconds    int      `json:"stall_timeout_seconds,omitempty"`
	AdaptiveConcurrency    bool     `json:"adaptive_concurrency"`
	StalledFileRetries     int      `json:"stalled_file_retries"`
	TransferAdjustment     string   `json:"transfer_adjustment"`
}

func DefaultSettings() Settings {
	return Settings{
		SchemaVersion:       985,
		TdlNamespace:        DefaultNamespace,
		Concurrent:          2,
		Threads:             4,
		ReconnectTimeout:    "60s",
		MaxRepairPasses:     3,
		OpenAfterBuild:      true,
		NetworkRetryMinutes: 30,
		UnknownRetryCount:   2,
		GenerateThumbnails:  true,
		StallTimeoutSeconds: 60,
		AdaptiveConcurrency: false,
		StalledFileRetries:  3,
		TransferAdjustment:  "increase",
	}
}
