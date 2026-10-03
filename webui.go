// Package webui carries the frontend files so the server ships as one binary.
package webui

import "embed"

// Site is the frontend: HTML, CSS, JavaScript and the service worker.
//
//go:embed web
var Site embed.FS
