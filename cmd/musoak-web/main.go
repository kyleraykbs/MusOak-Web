// Command musoak-web serves the MusOak web UI: a public frontend that
// routes to the MusOak backends its users choose.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"

	"codeberg.org/kyleraykbs/musoak-web/internal/config"
	"codeberg.org/kyleraykbs/musoak-web/internal/web"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "musoak-web:", err)
		os.Exit(1)
	}
}

func run() error {
	var configPath string
	var webDir string
	flag.StringVar(&configPath, "config", "", "path to config.json (default: $XDG_CONFIG_HOME/musoak-web/config.json)")
	flag.StringVar(&webDir, "web-dir", "", "serve the frontend from this directory instead of the copy inside the binary (for development)")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg, err := config.Load(resolveConfigPath(configPath))
	if err != nil {
		return err
	}

	server, err := web.New(cfg, logger, webDir)
	if err != nil {
		return err
	}

	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", cfg.Listen, err)
	}
	logger.Info("serving the web UI",
		"address", listener.Addr().String(),
		"defaultServer", orNone(cfg.DefaultServer),
		"backends", len(cfg.Servers),
	)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return server.Serve(ctx, listener)
}

func resolveConfigPath(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = home + "/.config"
	}
	return base + "/musoak-web/config.json"
}

func orNone(value string) string {
	if value == "" {
		return "none (users pick their own)"
	}
	return value
}
