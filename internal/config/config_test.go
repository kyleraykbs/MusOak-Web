package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMissingFileIsDefaults(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "nope.json"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Listen != DefaultListen {
		t.Errorf("listen = %q, want %q", cfg.Listen, DefaultListen)
	}
	if cfg.DefaultServer != "" {
		t.Errorf("defaultServer = %q, want nobody pointed anywhere", cfg.DefaultServer)
	}
	if !cfg.AllowCustom() {
		t.Error("a fresh config should let people route to their own server")
	}
}

// The file is strict so a typo cannot look like a working deployment.
func TestUnknownKeyIsAnError(t *testing.T) {
	_, err := Parse([]byte(`{"listen": ":1", "defualtServer": "https://x.test"}`))
	if err == nil {
		t.Fatal("an unknown key was accepted")
	}
	if !strings.Contains(err.Error(), "defualtServer") {
		t.Errorf("the error should name the key, got %v", err)
	}
}

func TestURLsAreChecked(t *testing.T) {
	cases := map[string]string{
		"not a scheme": `{"listen": ":1", "defaultServer": "music.example.com"}`,
		"no scheme":    `{"listen": ":1", "servers": [{"name": "a", "url": "ftp://x.test"}]}`,
		"no host":      `{"listen": ":1", "servers": [{"name": "a", "url": "https://"}]}`,
		"empty listen": `{"listen": "  "}`,
	}
	for name, raw := range cases {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Errorf("%s: accepted %s", name, raw)
		}
	}
}

func TestFullConfigParses(t *testing.T) {
	raw := `{
	  "listen": ":9000",
	  "defaultServer": "https://music.example.com",
	  "loginPopup": true,
	  "servers": [{"name": "Living room", "url": "https://music.example.com"}],
	  "allowCustomServer": false,
	  "blockPrivateServers": true
	}`
	cfg, err := Parse([]byte(raw))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.Listen != ":9000" || !cfg.LoginPopup || !cfg.BlockPrivateServers {
		t.Errorf("parsed config lost fields: %+v", cfg)
	}
	if cfg.AllowCustom() {
		t.Error("allowCustomServer: false was ignored")
	}
	if len(cfg.Servers) != 1 || cfg.Servers[0].Name != "Living room" {
		t.Errorf("servers = %+v", cfg.Servers)
	}
}

func TestLoadReadsTheGivenFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"listen": ":8123"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Listen != ":8123" {
		t.Errorf("listen = %q", cfg.Listen)
	}
}
