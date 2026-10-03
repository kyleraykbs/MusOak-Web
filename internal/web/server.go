// Package web is the web UI's own server: it serves the frontend, tells it what
// is configured, and routes its API calls to whichever backend the user chose.
//
// It holds no state of its own. Everything a user sees comes from one of the
// backends; this is the router and the shopfront, which is why a user can point
// it at another backend mid-session and lose nothing.
package web

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	webui "codeberg.org/kyleraykbs/musoak-web"
	"codeberg.org/kyleraykbs/musoak-web/internal/config"
)

const (
	// serverHeader names the backend a request routes through. It wins over the
	// session cookie so one tab can look at another backend.
	serverHeader = "X-Musoak-Server"
	// The session cookies cover what headers cannot: media elements.
	serverCookie = "ms_server"
	tokenCookie  = "ms_token"
	// routeParam is how a URL names its backend (for <audio>/<img> sources).
	routeParam = "ms"
)

// Server is one web UI instance.
type Server struct {
	cfg       *config.Config
	logger    *slog.Logger
	mux       *http.ServeMux
	site      http.Handler
	siteFS    fs.FS
	transport http.RoundTripper
	started   time.Time
}

// New builds the server around its configuration. When staticDir is set the
// frontend is read from that directory instead of the embedded copy, which is
// what a developer wants while editing it.
func New(cfg *config.Config, logger *slog.Logger, staticDir string) (*Server, error) {
	var root fs.FS
	if staticDir != "" {
		root = os.DirFS(staticDir)
	} else {
		embedded, err := fs.Sub(webui.Site, "web")
		if err != nil {
			return nil, fmt.Errorf("web: embedded frontend: %w", err)
		}
		root = embedded
	}
	s := &Server{
		cfg:     cfg,
		logger:  logger,
		mux:     http.NewServeMux(),
		site:    http.FileServer(http.FS(root)),
		siteFS:  root,
		started: time.Now(),
	}
	// The policy that keeps an open router from becoming a tunnel into someone's
	// network belongs where the connection is made, not where the URL is parsed:
	// names resolve to whatever they resolve to.
	s.transport = &http.Transport{DialContext: s.dialGuard}
	s.routes()
	return s, nil
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", s.handleHealth)
	s.mux.HandleFunc("GET /ui/config", s.handleConfig)
	s.mux.HandleFunc("POST /ui/session", s.handleSessionCreate)
	s.mux.HandleFunc("DELETE /ui/session", s.handleSessionDelete)
	s.mux.HandleFunc("/api/", s.handleAPI)
	s.mux.HandleFunc("/", s.handleSite)
}

// Handler is everything this server serves.
func (s *Server) Handler() http.Handler { return s.mux }

// Serve runs until the context is done or the listener fails.
func (s *Server) Serve(ctx context.Context, listener net.Listener) error {
	httpServer := &http.Server{
		Handler:           s.mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	err := httpServer.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	fmt.Fprintf(w, "ok %s\n", time.Since(s.started).Truncate(time.Second))
}

// uiConfig is what the frontend is told about this deployment. It is public:
// there is nothing in it a visitor could not see.
type uiConfig struct {
	DefaultServer     string          `json:"defaultServer"`
	LoginPopup        bool            `json:"loginPopup"`
	Servers           []config.Server `json:"servers"`
	AllowCustomServer bool            `json:"allowCustomServer"`
}

func (s *Server) handleConfig(w http.ResponseWriter, _ *http.Request) {
	// The default server is offered even when the operator did not list it: it
	// is where people are pointed, so it is where they may sign in.
	//
	// A deployment with nothing configured still answers with an empty list: a
	// null here is a trap for every client that spreads it.
	servers := make([]config.Server, 0, len(s.cfg.Servers)+1)
	if s.cfg.DefaultServer != "" && !listed(s.cfg.Servers, s.cfg.DefaultServer) {
		servers = append(servers, config.Server{Name: nameFor(s.cfg.DefaultServer), URL: s.cfg.DefaultServer})
	}
	servers = append(servers, s.cfg.Servers...)
	writeJSON(w, http.StatusOK, uiConfig{
		DefaultServer:     s.cfg.DefaultServer,
		LoginPopup:        s.cfg.LoginPopup && s.cfg.DefaultServer != "",
		Servers:           servers,
		AllowCustomServer: s.cfg.AllowCustom(),
	})
}

// sessionRequest signs the browser into one backend for media and other
// requests that carry no headers of their own.
type sessionRequest struct {
	Server string `json:"server"`
	Token  string `json:"token"`
}

func (s *Server) handleSessionCreate(w http.ResponseWriter, r *http.Request) {
	var body sessionRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad session body")
		return
	}
	if body.Server != "" {
		if _, err := s.route(body.Server); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name:     serverCookie,
			Value:    body.Server,
			Path:     "/",
			SameSite: http.SameSiteLaxMode,
			// The proxy is the only reader that matters, but the frontend also
			// shows which backend it is on, so this one stays readable.
			HttpOnly: false,
			MaxAge:   30 * 24 * 60 * 60,
		})
	}
	if body.Token != "" {
		http.SetCookie(w, &http.Cookie{
			Name:     tokenCookie,
			Value:    body.Token,
			Path:     "/",
			SameSite: http.SameSiteLaxMode,
			// The token is only ever forwarded to the chosen backend, never
			// read by script: a stolen script cannot read it back.
			HttpOnly: true,
			MaxAge:   30 * 24 * 60 * 60,
		})
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleSessionDelete(w http.ResponseWriter, _ *http.Request) {
	for _, name := range []string{serverCookie, tokenCookie} {
		http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: "/", MaxAge: -1})
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleSite serves the frontend, falling back to its index for the routes the
// router owns (so a reload on /rooms still gets the app).
func (s *Server) handleSite(w http.ResponseWriter, r *http.Request) {
	// The frontend is edited while it is being served, so a browser must ask
	// before reusing its copy: no-cache means "revalidate", and an unchanged
	// file still answers 304 from the Last-Modified the file server sets. Without
	// it a browser is free to guess a freshness lifetime, and the page keeps
	// running yesterday's modules.
	w.Header().Set("Cache-Control", "no-cache")
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" || strings.HasSuffix(path, "/") || path == "index.html" {
		s.servePage(w)
		return
	}
	if path != "" && !strings.HasSuffix(path, "/") {
		if info, err := fs.Stat(s.siteFS, path); err == nil && !info.IsDir() {
			s.site.ServeHTTP(w, r)
			return
		}
	}
	fresh := r.Clone(r.Context())
	fresh.URL.Path = "/"
	s.site.ServeHTTP(w, fresh)
}

// servePage serves the shell with its stylesheet under a versioned URL. A
// browser holding yesterday's stylesheet asks for a URL it has never seen
// instead of reusing what it has, so an edit lands on the next reload and nobody
// has to clear a cache.
//
// The entry script is deliberately *not* stamped: the views import it by its
// bare path (`../app.js`), so a query on the script tag makes the browser load
// two copies of the whole app - two shells, two dialogs, and a boot that runs
// twice. Everything is served `no-cache` anyway, which is what keeps the modules
// fresh.
func (s *Server) servePage(w http.ResponseWriter) {
	page, err := fs.ReadFile(s.siteFS, "index.html")
	if err != nil {
		http.Error(w, "no page", http.StatusNotFound)
		return
	}
	stamp := s.assetStamp()
	body := strings.ReplaceAll(string(page), `href="theme.css"`, `href="theme.css?v=`+stamp+`"`)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = io.WriteString(w, body)
}

// assetStamp is the newest modification time in the frontend, so changing any
// file changes every URL the page asks for.
func (s *Server) assetStamp() string {
	newest := time.Time{}
	_ = fs.WalkDir(s.siteFS, ".", func(_ string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if info, err := entry.Info(); err == nil && info.ModTime().After(newest) {
			newest = info.ModTime()
		}
		return nil
	})
	return strconv.FormatInt(newest.Unix(), 10)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func listed(servers []config.Server, raw string) bool {
	want := strings.TrimSuffix(strings.TrimSpace(raw), "/")
	for _, server := range servers {
		if strings.TrimSuffix(strings.TrimSpace(server.URL), "/") == want {
			return true
		}
	}
	return false
}

func nameFor(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return parsed.Host
}

// dialGuard is the network half of the private-range policy: whatever a name
// resolves to here is what gets refused.
func (s *Server) dialGuard(ctx context.Context, network, address string) (net.Conn, error) {
	if s.cfg.BlockPrivateServers {
		host, _, err := net.SplitHostPort(address)
		if err == nil {
			if ip := net.ParseIP(host); ip != nil && isPrivate(ip) {
				return nil, fmt.Errorf("web: %s is on a private range", host)
			}
		}
	}
	return (&net.Dialer{}).DialContext(ctx, network, address)
}

func isPrivate(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}
