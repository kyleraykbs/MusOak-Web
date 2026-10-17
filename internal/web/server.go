// Package web is the web UI's own server: it serves the frontend, tells it what
// is configured, and routes its API calls to whichever backend the user chose.
//
// It holds no state of its own. Everything a user sees comes from one of the
// backends; this is the router and the shopfront, which is why a user can point
// it at another backend mid-session and lose nothing.
package web

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"crypto/sha256"
	"encoding/hex"
	webui "github.com/kyleraykbs/MusOak-Web"
	"github.com/kyleraykbs/MusOak-Web/internal/config"
	"mime"
	"path/filepath"
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
	siteFS    fs.FS
	transport http.RoundTripper
	// proxy is the reverse proxy every API request goes through. Nothing about
	// it changes between requests, so there is one of it, made in New.
	proxy   *httputil.ReverseProxy
	started time.Time
	// mu guards the revision of the frontend this server is holding: the digest
	// the page is stamped with, and the bytes read under it. Both are the same
	// until a file changes, and neither should cost a walk over the frontend on
	// every request that asks for one.
	mu      sync.Mutex
	stamp   string
	stampAt time.Time
	// live says the frontend is a directory being edited under this server,
	// whose digest therefore goes stale the moment somebody saves.
	live  bool
	files map[string]assetEntry
}

// assetEntry is one frontend file as it was read: its bytes, and the tag a
// browser revalidates them by. Every revalidation of a file is a question about
// the same bytes, so the file is read once per revision of the frontend. `gz`
// is those same bytes as gzip, packed the first time a client that takes gzip
// asks for the file and kept for every request after it: the frontend is nearly
// a megabyte of JavaScript, and compressing it again for each of those requests
// was the whole of that work, repeated.
type assetEntry struct {
	body []byte
	gz   []byte
	tag  string
}

// defaultStampTTL is how long a live frontend's digest is trusted before it is
// taken again. A stale digest names the revision before the last edit, and a
// browser holding that URL has no reason to ask again - so it is short enough
// that the next reload picks the edit up, and long enough that a page does not
// walk the whole frontend for a URL that has not changed.
const defaultStampTTL = 2 * time.Second

// stampTTL is that interval, as a variable so a test can drive a live frontend
// through an edit without waiting for it.
var stampTTL = defaultStampTTL

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
		siteFS:  root,
		started: time.Now(),
		live:    staticDir != "",
	}
	// The policy that keeps an open router from becoming a tunnel into someone's
	// network belongs where the connection is made, not where the URL is parsed:
	// names resolve to whatever they resolve to.
	//
	// The idle pool is sized for one backend that a browser talks to for as long
	// as it is open. Two connections per host is a fresh handshake behind every
	// cover and every track, and a zero idle timeout is a socket held open on a
	// backend that has long stopped answering.
	s.transport = &http.Transport{
		DialContext:         s.dialGuard,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
		// A backend that accepts the connection and then says nothing is a
		// request with no answer at all: this is where that becomes a failure
		// the page can act on instead of a tab that spins for as long as the
		// browser is willing. It bounds the wait for the response's *headers*
		// only - a song's body is as long as the song is.
		ResponseHeaderTimeout: 30 * time.Second,
	}
	s.proxy = s.newProxy()
	if !s.live {
		// The embedded frontend is the same bytes for as long as this process
		// lives, so its digest is taken once, here, rather than by whoever
		// happens to ask for the first page.
		s.stamp = digestSite(s.siteFS)
	}
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
	// PreloadMax is the deployment's ceiling for the queue's "Songs ahead"
	// control (the device's own preload count, in songs after the one playing).
	PreloadMax int `json:"preloadMax"`
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
		PreloadMax:        s.cfg.PreloadMax,
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

// compressedExtensions is what gets gzipped on the way out. The frontend is
// nearly a megabyte of JavaScript in a hundred files, plus its styles; over a
// phone connection that is the difference between a page that opens and a page
// that arrives. Fonts and images are already compressed - running them through
// gzip again costs CPU and saves nothing.
var compressedExtensions = map[string]bool{
	".js": true, ".css": true, ".html": true, ".svg": true, ".json": true, ".txt": true, ".map": true,
}

// gzipWriter compresses whatever a handler writes, to a client that asked. It
// keeps the coding to itself until there is a body to encode: a response with
// no body - the 304 a revalidation gets - carries no content coding and no
// length, and claiming one describes bytes that never went out.
type gzipWriter struct {
	http.ResponseWriter
	// writer exists only once there is something to put in it, and Close
	// finishes it when the handler is done.
	writer *gzip.Writer
	// status is what the handler asked for, held back until a body settles it:
	// the coding and the length have to be on the header the first byte goes
	// out with.
	status int
	// sent says the client has been given its header.
	sent bool
}

func (g *gzipWriter) WriteHeader(status int) {
	if g.status != 0 {
		return
	}
	g.status = status
	if bodyless(status) {
		// Nothing follows a 304 or a 204, so there is nothing to compress: it
		// goes out exactly as the handler asked for it.
		g.sent = true
		g.ResponseWriter.WriteHeader(status)
	}
}

func (g *gzipWriter) Write(p []byte) (int, error) {
	if !g.sent {
		g.start()
	}
	if g.writer == nil {
		// A status that forbids a body swallows the bytes, as it would with no
		// wrapper here at all.
		return len(p), nil
	}
	return g.writer.Write(p)
}

// start sends the header the first byte has to go out with. Content-Length
// goes: the compressed size is not known until the end, and a wrong one
// truncates the body.
func (g *gzipWriter) start() {
	g.sent = true
	status := g.status
	if status == 0 {
		status = http.StatusOK
	}
	g.writer = gzip.NewWriter(g.ResponseWriter)
	g.Header().Del("Content-Length")
	g.Header().Set("Content-Encoding", "gzip")
	g.ResponseWriter.WriteHeader(status)
}

// Close finishes the response: the tail of the stream if anything was written
// into it, and otherwise the status the handler asked for, which nothing else
// would have sent.
func (g *gzipWriter) Close() {
	if g.writer != nil {
		_ = g.writer.Close()
		return
	}
	if g.sent {
		return
	}
	status := g.status
	if status == 0 {
		status = http.StatusOK
	}
	g.sent = true
	g.ResponseWriter.WriteHeader(status)
}

// bodyless reports whether a status forbids a body, which is what decides
// whether there is anything to compress.
func bodyless(status int) bool {
	return status < 200 || status == http.StatusNoContent || status == http.StatusNotModified
}

// acceptsGzip reports whether the client said it takes gzip.
func acceptsGzip(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")
}

// packable reports whether a file is one worth compressing: text, by its
// extension. Fonts and images are already compressed, so running them through
// gzip again costs CPU and saves nothing.
func packable(name string) bool {
	return compressedExtensions[strings.ToLower(path.Ext(name))]
}

// handleSite serves the frontend, falling back to its index for the routes the
// router owns (so a reload on /rooms still gets the app).
func (s *Server) handleSite(w http.ResponseWriter, r *http.Request) {
	// A browser must ask before reusing its copy: no-cache means "revalidate",
	// and an unchanged file still answers 304 from the tag of its bytes. Without
	// it a browser is free to guess a freshness lifetime, and the page keeps
	// running yesterday's modules.
	w.Header().Set("Cache-Control", "no-cache")

	// Asking the frontend for the bytes settles two questions at once: a name
	// that holds a file is an asset, and anything else is the shell - and only
	// one of the two is worth compressing on these terms.
	route := strings.TrimPrefix(r.URL.Path, "/")
	page := route == "" || strings.HasSuffix(route, "/") || route == "index.html"
	gzip := acceptsGzip(r)
	var entry assetEntry
	if !page {
		var err error
		// The file is packed here, once, if this client would take it that way
		// and it is the kind of file worth packing.
		entry, err = s.asset(route, gzip && packable(route))
		page = err != nil
	}
	if page {
		// The page is built for the request that asked for it - it carries the
		// revision's URL and the origin it was reached by - so it is compressed
		// as it goes. A file is not: it is packed once and sent many times.
		if gzip {
			// Said out loud, because what comes back depends on it: a cache
			// that stores the compressed body without knowing that would hand
			// it to a client that cannot read it.
			w.Header().Add("Vary", "Accept-Encoding")
			packed := &gzipWriter{ResponseWriter: w}
			defer packed.Close()
			w = packed
		}
		s.servePage(w, r)
		return
	}
	s.serveAsset(w, r, route, entry)
}

// servePage serves the shell with its stylesheet under a versioned URL. A
// browser holding yesterday's stylesheet asks for a URL it has never seen
// instead of reusing what it has, so an edit lands on the next reload and nobody
// has to clear a cache.
//
// The entry script is deliberately *not* stamped: the views import it by its
// bare path (`../app.js`), so a query on the script tag makes the browser load
// two copies of the whole app - two shells, two dialogs, and a boot that runs
// twice. The page and its modules are served `no-cache` anyway, which is what
// keeps the modules fresh.
func (s *Server) servePage(w http.ResponseWriter, r *http.Request) {
	page, err := fs.ReadFile(s.siteFS, "index.html")
	if err != nil {
		http.Error(w, "no page", http.StatusNotFound)
		return
	}
	stamp := s.assetStamp()
	body := strings.ReplaceAll(string(page), `href="theme.css"`, `href="theme.css?v=`+stamp+`"`)
	// The embed's absolute URLs, from where the page was actually reached.
	body = strings.ReplaceAll(body, "{{origin}}", requestOrigin(r))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = io.WriteString(w, body)
}

// requestOrigin is where this page was reached, which is not where this server
// sits: it is behind a reverse proxy that terminates TLS and forwards over
// plain HTTP, so its own request has neither the right scheme nor the right
// host. A crawler building a link preview needs absolute URLs, and the
// forwarded headers are what say. A direct connection falls back to the socket.
func requestOrigin(r *http.Request) string {
	scheme := firstValue(r.Header.Get("X-Forwarded-Proto"))
	if scheme == "" {
		scheme = "http"
		if r.TLS != nil {
			scheme = "https"
		}
	}
	host := firstValue(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = r.Host
	}
	if host = safeHost(host); host == "" {
		return ""
	}
	return scheme + "://" + host
}

// firstValue takes the first entry of a comma-separated forwarded header: a
// chain of proxies appends to it, and the first entry is the browser's.
func firstValue(value string) string {
	if at := strings.IndexByte(value, ','); at >= 0 {
		value = value[:at]
	}
	return strings.TrimSpace(value)
}

// safeHost keeps a host and an optional port and nothing else. This value lands
// in an HTML attribute that a crawler reads, and a Host header is whatever the
// client sent, so anything that could break out of the attribute is refused
// outright rather than escaped - a page with no embed beats a page that points
// somewhere else.
func safeHost(host string) string {
	for _, r := range host {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.', r == '-', r == ':', r == '[', r == ']':
		default:
			return ""
		}
	}
	return host
}

// assetStamp is the version the page's stylesheet URL carries: a digest of the
// whole frontend, so changing any file changes the URL the page asks for.
//
// Taking it reads and hashes every file, and it is the same value on every
// request until one of them changes. The embedded frontend is the same bytes
// for as long as this process lives, so its digest is taken once, when the
// server is built; a directory being edited under a running server is taken
// again once it has aged, and everything read under the old digest goes with
// it.
func (s *Server) assetStamp() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stampLocked()
}

// stampLocked is assetStamp for a caller already holding the lock, and is the
// only way the digest is ever taken.
func (s *Server) stampLocked() string {
	if s.stamp == "" || (s.live && time.Since(s.stampAt) >= stampTTL) {
		s.stamp = digestSite(s.siteFS)
		s.stampAt = time.Now()
		// What was read under the old digest is another revision of the
		// frontend: a revalidation must not be answered out of it.
		s.files = nil
	}
	return s.stamp
}

// asset is one frontend file's bytes and tag, read once per revision of the
// frontend. A browser revalidating a module it already has asks about bytes
// that were read a moment ago, and the answer to that should be a lookup rather
// than a walk to the disk or the embed. `pack` is the caller saying it will
// serve the file compressed, so the packing is done here rather than by
// whoever compresses.
func (s *Server) asset(name string, pack bool) (assetEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stampLocked()
	entry, ok := s.files[name]
	if !ok {
		body, err := fs.ReadFile(s.siteFS, name)
		if err != nil {
			return assetEntry{}, err
		}
		entry = assetEntry{body: body, tag: `"` + assetTag(body) + `"`}
	}
	if pack && entry.gz == nil {
		entry.gz = gzipBytes(entry.body)
	}
	if s.files == nil {
		s.files = make(map[string]assetEntry)
	}
	s.files[name] = entry
	return entry, nil
}

// gzipBytes is the bytes as gzip. The default level, deliberately: this runs
// once per revision of a file and then stands for every request after it, and
// the extra milliseconds of the highest level would be spent in front of the
// first person asking for the page.
func gzipBytes(body []byte) []byte {
	var buf bytes.Buffer
	writer := gzip.NewWriter(&buf)
	_, _ = writer.Write(body)
	_ = writer.Close()
	return buf.Bytes()
}

// digestSite is a digest of the frontend's file names and contents, short
// enough to carry in a query.
func digestSite(fsys fs.FS) string {
	sum := sha256.New()
	_ = fs.WalkDir(fsys, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			return nil
		}
		_, _ = io.WriteString(sum, name)
		_, _ = sum.Write(body)
		return nil
	})
	return hex.EncodeToString(sum.Sum(nil))[:12]
}

// serveAsset serves one frontend file with an ETag of its contents and no
// Last-Modified.
//
// Every file in the store is stamped 1970, and the page is served "no-cache",
// which means "revalidate". Against a Last-Modified that never changes a browser
// is always told Not Modified - so a deploy could never reach a browser that had
// already loaded the page once, and the frontend appeared frozen at whatever
// version it first saw.
//
// A URL that names its version - the page stamps its stylesheet with the digest
// of the frontend - will never mean different bytes, so a browser may keep it as
// long as it likes: immutable says asking again would be a trip with nothing to
// learn. Every other URL is the one a deploy will reuse for new bytes, and keeps
// asking; the answer to that costs a comparison of tags, not a read.
func (s *Server) serveAsset(w http.ResponseWriter, r *http.Request, name string, entry assetEntry) {
	w.Header().Set("ETag", entry.tag)
	w.Header().Set("Content-Type", assetType(name))
	if r.URL.Query().Has("v") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	if matchesETag(r.Header.Get("If-None-Match"), entry.tag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if entry.gz != nil && acceptsGzip(r) {
		// The packed bytes are in the entry because a client asked for them
		// once; whether *this* client gets them is this request's own business.
		//
		// What came back depends on the request, so a cache has to know that.
		w.Header().Add("Vary", "Accept-Encoding")
		w.Header().Set("Content-Encoding", "gzip")
		// Known here, unlike the streamed form: the compressed size was
		// settled when it was packed.
		w.Header().Set("Content-Length", strconv.Itoa(len(entry.gz)))
		_, _ = w.Write(entry.gz)
		return
	}
	_, _ = w.Write(entry.body)
}

// assetTag is a short digest of one file's contents, which is what makes a
// revalidation meaningful: the same bytes answer Not Modified, different bytes
// are sent.
func assetTag(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])[:12]
}

// assetType is the media type of a frontend file, from its name.
func assetType(path string) string {
	if kind := mime.TypeByExtension(filepath.Ext(path)); kind != "" {
		return kind
	}
	return "application/octet-stream"
}

// matchesETag reports whether an If-None-Match header names this tag. The header
// may list several, and any of them may carry the weak prefix.
func matchesETag(header, tag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimPrefix(strings.TrimSpace(candidate), "W/")
		if strings.TrimSpace(candidate) == tag {
			return true
		}
	}
	return false
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
//
// The dialer is shared, and carries a timeout: a name that resolves into a
// black hole is otherwise dialled for as long as the operating system's own
// default allows - minutes - with a request hanging on it and nothing to show
// the person waiting.
var dialer = &net.Dialer{
	Timeout:   10 * time.Second,
	KeepAlive: 30 * time.Second,
}

func (s *Server) dialGuard(ctx context.Context, network, address string) (net.Conn, error) {
	if s.cfg.BlockPrivateServers {
		host, _, err := net.SplitHostPort(address)
		if err == nil {
			if ip := net.ParseIP(host); ip != nil && isPrivate(ip) {
				return nil, fmt.Errorf("web: %s is on a private range", host)
			}
		}
	}
	return dialer.DialContext(ctx, network, address)
}

func isPrivate(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}
