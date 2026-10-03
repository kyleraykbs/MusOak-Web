// Package config loads and validates the web UI's JSON configuration.
//
// The file is strict: unknown keys are an error, so a typo can never be
// silently ignored. Absent keys keep their defaults.
package config

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
)

const appName = "musoak-web"

// DefaultListen is the address the web UI binds to.
const DefaultListen = ":4421"

// Server is one backend the web UI can route to.
type Server struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

// Config is the whole file.
type Config struct {
	// Listen is the address the web UI binds to.
	Listen string `json:"listen"`
	// DefaultServer is the backend users are pointed at on arrival. Empty means
	// nobody is pointed anywhere and they pick one themselves.
	DefaultServer string `json:"defaultServer"`
	// LoginPopup asks people to sign in to the default server when they arrive,
	// with a way to skip it. It only means something with a default server.
	LoginPopup bool `json:"loginPopup"`
	// Servers are the backends offered in the server picker. The default server
	// is offered too even when it is not listed here.
	Servers []Server `json:"servers"`
	// AllowCustomServer lets a user route through a backend that is not listed:
	// this web UI is a router for the backends, and people run their own.
	AllowCustomServer *bool `json:"allowCustomServer"`
	// BlockPrivateServers refuses backends on loopback or private ranges, for
	// when this web UI is exposed to the internet and an open route would turn
	// it into a fetch tunnel for anyone.
	BlockPrivateServers bool `json:"blockPrivateServers"`
}

// Load reads the configuration, or returns the defaults when there is no file.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Defaults(), nil
		}
		return nil, fmt.Errorf("config: read %s: %w", path, err)
	}
	return Parse(raw)
}

// Defaults is a working configuration with nothing preselected.
func Defaults() *Config {
	yes := true
	return &Config{
		Listen:            DefaultListen,
		AllowCustomServer: &yes,
	}
}

// Parse decodes one configuration file, rejecting unknown keys and URLs that
// could not be routed to.
func Parse(raw []byte) (*Config, error) {
	cfg := Defaults()
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(cfg); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Validate checks what routing depends on.
func (c *Config) Validate() error {
	if strings.TrimSpace(c.Listen) == "" {
		return fmt.Errorf("config: listen is empty")
	}
	for index, server := range c.Servers {
		if err := checkURL(server.URL); err != nil {
			return fmt.Errorf("config: servers[%d]: %w", index, err)
		}
	}
	if c.DefaultServer != "" {
		if err := checkURL(c.DefaultServer); err != nil {
			return fmt.Errorf("config: defaultServer: %w", err)
		}
		if c.LoginPopup && len(c.Servers) == 0 {
			// Not an error: the default server is offered on its own.
			return nil
		}
	}
	return nil
}

// AllowCustom reports whether a user may route to a backend that is not listed.
func (c *Config) AllowCustom() bool {
	return c.AllowCustomServer == nil || *c.AllowCustomServer
}

func checkURL(raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("%q is not an http or https URL", raw)
	}
	if parsed.Host == "" {
		return fmt.Errorf("%q has no host", raw)
	}
	return nil
}

// Saving is for tooling; the running UI reads the file at start.
func (c *Config) Write(w io.Writer) error {
	payload, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	_, err = w.Write(append(payload, '\n'))
	return err
}
