package assets

import "embed"

// UI is the whole static shell written into a Library on first build.
//
//go:embed ui/*
var UI embed.FS

// BeautifierTheme is the complete telegram-export-beautifier edition bundled
// with the binary; it is materialized as style.css / script.js per Library.
//
//go:embed ui/beautifier-theme.css ui/beautifier-theme.js
var BeautifierTheme embed.FS
