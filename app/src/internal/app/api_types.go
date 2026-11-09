package app

// BootstrapDTO is the full state the desktop window needs on first paint.
type BootstrapDTO struct {
	Version     string   `json:"version"`
	LibraryRoot string   `json:"libraryRoot"`
	Tdl         string   `json:"tdl"`
	TdlRunning  bool     `json:"tdlRunning"`
	HasSession  bool     `json:"hasSession"`
	FFmpeg      string   `json:"ffmpeg"`
	Chats       int      `json:"chats"`
	Current     string   `json:"current"`
	ConfigPath  string   `json:"configPath"`
	History     []string `json:"history,omitempty"`
}

// ChatDTO is one row in the desktop chat list.
type ChatDTO struct {
	Slug       string `json:"slug"`
	Name       string `json:"name"`
	Type       string `json:"type,omitempty"`
	ID         string `json:"id,omitempty"`
	Messages   int    `json:"messages"`
	Media      int    `json:"media"`
	Images     int    `json:"images,omitempty"`
	Videos     int    `json:"videos,omitempty"`
	Audio      int    `json:"audio,omitempty"`
	Files      int    `json:"files,omitempty"`
	Missing    int    `json:"missing"`
	TotalBytes int64  `json:"totalBytes,omitempty"`
	ImageBytes int64  `json:"imageBytes,omitempty"`
	VideoBytes int64  `json:"videoBytes,omitempty"`
	AudioBytes int64  `json:"audioBytes,omitempty"`
	FileBytes  int64  `json:"fileBytes,omitempty"`
	FirstTS    int64  `json:"firstTs,omitempty"`
	LastTS     int64  `json:"lastTs,omitempty"`
	UpdatedAt  string `json:"updatedAt,omitempty"`
	Pages      int    `json:"pages"`
	HasSource  bool   `json:"hasSource"`
	Official   int    `json:"official"`
	Dir        string `json:"dir"`
	Current    bool   `json:"current"`
}

// OperationDTO carries non-download stages (checking / building / verifying).
type OperationDTO struct {
	OpID      string `json:"opId"`
	Phase     string `json:"phase"`
	Stage     string `json:"stage"`
	Detail    string `json:"detail"`
	Current   int64  `json:"current"`
	Total     int64  `json:"total"`
	Unit      string `json:"unit"`
	ElapsedMs int64  `json:"elapsedMs"`
}

// DoneDTO closes one desktop operation.
type DoneDTO struct {
	OpID     string `json:"opId"`
	OK       bool   `json:"ok"`
	Paused   bool   `json:"paused,omitempty"`
	Stopped  bool   `json:"stopped,omitempty"`
	Partial  bool   `json:"partial,omitempty"`
	Error    string `json:"error,omitempty"`
	Stage    string `json:"stage,omitempty"`
	Messages int    `json:"messages,omitempty"`
	Media    int    `json:"media,omitempty"`
	Missing  int    `json:"missing,omitempty"`
}

// RPCReply is the answer to one frontend request over the raw message channel.
type RPCReply struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}
