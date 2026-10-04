package web

import (
	"bufio"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"codeberg.org/kyleraykbs/musoak-web/internal/config"
	"os"
	"path/filepath"
)

// captured is what the backend saw, which is what these tests are about: the
// router must hand the backend the same request a direct client would make.
type captured struct {
	method string
	path   string
	query  string
	auth   string
	cookie string
	sawAll chan struct{}
}

func fakeBackend(t *testing.T) (*httptest.Server, *captured) {
	t.Helper()
	seen := &captured{sawAll: make(chan struct{}, 8)}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.method = r.Method
		seen.path = r.URL.Path
		seen.query = r.URL.RawQuery
		seen.auth = r.Header.Get("Authorization")
		seen.cookie = r.Header.Get("Cookie")
		seen.sawAll <- struct{}{}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)
	return server, seen
}

func newServer(t *testing.T, cfg *config.Config) *Server {
	t.Helper()
	server, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return server
}

func do(t *testing.T, handler http.Handler, method, target string, headers map[string]string, cookies []*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, nil)
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	for _, cookie := range cookies {
		request.AddCookie(cookie)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestProxyRoutesByHeaderAndForwardsTheRequest(t *testing.T) {
	backend, seen := fakeBackend(t)
	server := newServer(t, &config.Config{Listen: ":0"})

	response := do(t, server.Handler(), "GET", "/api/v1/tracks/abc?limit=5",
		map[string]string{serverHeader: backend.URL, "Authorization": "Bearer t0ken"}, nil)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body)
	}
	<-seen.sawAll
	if seen.path != "/api/v1/tracks/abc" {
		t.Errorf("backend path = %q", seen.path)
	}
	if seen.query != "limit=5" {
		t.Errorf("backend query = %q, want the caller's own", seen.query)
	}
	if seen.auth != "Bearer t0ken" {
		t.Errorf("backend authorization = %q", seen.auth)
	}
}

// A media element cannot set headers: the backend goes in the URL, and the
// routing parameter must not leak into the backend's own query.
func TestProxyRoutesByQueryParameterAndStripsIt(t *testing.T) {
	backend, seen := fakeBackend(t)
	server := newServer(t, &config.Config{Listen: ":0"})

	response := do(t, server.Handler(), "GET",
		"/api/v1/media/v1?ms="+backend.URL+"&wait=1", nil, nil)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body)
	}
	<-seen.sawAll
	if seen.query != "wait=1" {
		t.Errorf("backend query = %q, want ps stripped", seen.query)
	}
}

// The session cookie carries the token for requests that carry no header, and
// the backend never sees the cookie itself.
func TestProxyCarriesTheSessionCookieAsABearerToken(t *testing.T) {
	backend, seen := fakeBackend(t)
	server := newServer(t, &config.Config{Listen: ":0"})

	response := do(t, server.Handler(), "GET", "/api/v1/me/favorites", nil, []*http.Cookie{
		{Name: serverCookie, Value: backend.URL},
		{Name: tokenCookie, Value: "guest-token"},
	})

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body)
	}
	<-seen.sawAll
	if seen.auth != "Bearer guest-token" {
		t.Errorf("backend authorization = %q", seen.auth)
	}
	if seen.cookie != "" {
		t.Errorf("the backend should not see our cookies, got %q", seen.cookie)
	}
}

func TestProxyRefusesUnlistedServersWhenCustomIsOff(t *testing.T) {
	backend, seen := fakeBackend(t)
	no := false
	server := newServer(t, &config.Config{
		Listen:            ":0",
		Servers:           []config.Server{{Name: "listed", URL: "https://listed.test"}},
		AllowCustomServer: &no,
	})

	response := do(t, server.Handler(), "GET", "/api/v1/providers",
		map[string]string{serverHeader: backend.URL}, nil)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", response.Code, response.Body)
	}
	select {
	case <-seen.sawAll:
		t.Fatal("the request reached a server that is not listed")
	default:
	}
	if !strings.Contains(response.Body.String(), "listed servers only") {
		t.Errorf("the error should say why: %s", response.Body)
	}
}

// The default server is where people are pointed, so it is routable even when
// it is not repeated in the list.
func TestProxyAllowsTheDefaultServerWhenCustomIsOff(t *testing.T) {
	backend, seen := fakeBackend(t)
	no := false
	server := newServer(t, &config.Config{
		Listen:            ":0",
		DefaultServer:     backend.URL,
		AllowCustomServer: &no,
	})

	response := do(t, server.Handler(), "GET", "/api/v1/providers",
		map[string]string{serverHeader: backend.URL}, nil)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body)
	}
	<-seen.sawAll
}

func TestProxyRefusesPrivateBackendsWhenAsked(t *testing.T) {
	backend, seen := fakeBackend(t)
	server := newServer(t, &config.Config{Listen: ":0", BlockPrivateServers: true})

	response := do(t, server.Handler(), "GET", "/api/v1/providers",
		map[string]string{serverHeader: backend.URL}, nil)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", response.Code, response.Body)
	}
	select {
	case <-seen.sawAll:
		t.Fatal("a private backend was dialled")
	default:
	}
}

func TestProxySaysSoWhenTheBackendIsDown(t *testing.T) {
	backend, _ := fakeBackend(t)
	url := backend.URL
	backend.Close()

	server := newServer(t, &config.Config{Listen: ":0"})
	response := do(t, server.Handler(), "GET", "/api/v1/providers",
		map[string]string{serverHeader: url}, nil)

	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502; body %s", response.Code, response.Body)
	}
	if !strings.Contains(response.Body.String(), "did not answer") {
		t.Errorf("unhelpful body: %s", response.Body)
	}
}

func TestProxySaysSoWhenNoServerIsChosen(t *testing.T) {
	server := newServer(t, &config.Config{Listen: ":0"})
	response := do(t, server.Handler(), "GET", "/api/v1/providers", nil, nil)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
}

func TestConfigEndpointTellsTheFrontendWhatThisDeploymentOffers(t *testing.T) {
	cfg := &config.Config{
		Listen:        ":0",
		DefaultServer: "https://music.example.com",
		LoginPopup:    true,
		Servers:       []config.Server{{Name: "Living room", URL: "https://music.example.com"}},
	}
	server := newServer(t, cfg)
	response := do(t, server.Handler(), "GET", "/ui/config", nil, nil)

	var payload uiConfig
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v (%s)", err, response.Body)
	}
	if payload.DefaultServer != "https://music.example.com" || !payload.LoginPopup {
		t.Errorf("payload = %+v", payload)
	}
	if !payload.AllowCustomServer {
		t.Error("custom servers default to allowed")
	}
	// The default server is offered even if the operator only set it as a
	// default: it is where people are pointed.
	if len(payload.Servers) != 1 || payload.Servers[0].Name != "Living room" {
		t.Errorf("servers = %+v", payload.Servers)
	}
}

// Asking people to sign in means nothing without somewhere to sign in to.
func TestLoginPopupIsOffWithoutADefaultServer(t *testing.T) {
	server := newServer(t, &config.Config{Listen: ":0", LoginPopup: true})
	response := do(t, server.Handler(), "GET", "/ui/config", nil, nil)

	var payload uiConfig
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.LoginPopup {
		t.Error("a login popup with no server to sign in to is a dead end")
	}
}

func TestSessionEndpointSetsAndClearsCookies(t *testing.T) {
	backend, _ := fakeBackend(t)
	server := newServer(t, &config.Config{Listen: ":0"})

	body := strings.NewReader(`{"server":"` + backend.URL + `","token":"abc"}`)
	request := httptest.NewRequest("POST", "/ui/session", body)
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", recorder.Code, recorder.Body)
	}
	set := recorder.Result().Cookies()
	byName := map[string]*http.Cookie{}
	for _, cookie := range set {
		byName[cookie.Name] = cookie
	}
	if byName[serverCookie] == nil || byName[serverCookie].Value != backend.URL {
		t.Errorf("server cookie = %+v", byName[serverCookie])
	}
	if byName[tokenCookie] == nil || !byName[tokenCookie].HttpOnly {
		t.Errorf("the token cookie must be HttpOnly: %+v", byName[tokenCookie])
	}

	cleared := do(t, server.Handler(), "DELETE", "/ui/session", nil, nil)
	for _, cookie := range cleared.Result().Cookies() {
		if cookie.MaxAge >= 0 {
			t.Errorf("cookie %s was not cleared", cookie.Name)
		}
	}
}

func TestSessionEndpointRejectsNonsense(t *testing.T) {
	server := newServer(t, &config.Config{Listen: ":0"})
	body := strings.NewReader(`{"server":"not a url"}`)
	request := httptest.NewRequest("POST", "/ui/session", body)
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
}

func TestSiteServesAssetsAndFallsBackToTheApp(t *testing.T) {
	server := newServer(t, &config.Config{Listen: ":0"})
	handler := server.Handler()

	css := do(t, handler, "GET", "/theme.css", nil, nil)
	if css.Code != http.StatusOK || !strings.Contains(css.Body.String(), "--bg0-h") {
		t.Errorf("theme.css = %d, %d bytes", css.Code, css.Body.Len())
	}

	app := do(t, handler, "GET", "/theme.css", nil, nil)
	if !strings.Contains(app.Body.String(), "gruvbox") {
		t.Error("the theme should say it is gruvbox-dark")
	}

	// A reload on a view's route still gets the app, not a 404.
	route := do(t, handler, "GET", "/some/view/route", nil, nil)
	if route.Code != http.StatusOK || !strings.Contains(route.Body.String(), "js/app.js") {
		t.Errorf("client route = %d, body %s", route.Code, route.Body.String()[:min(120, route.Body.Len())])
	}
}

// A deployment with nothing configured must still answer with an empty list: a
// null here is what made "Choose a server" do nothing.
func TestConfigEndpointNeverOmitsTheServerList(t *testing.T) {
	server := newServer(t, &config.Config{Listen: ":0"})
	response := do(t, server.Handler(), "GET", "/ui/config", nil, nil)

	body := response.Body.String()
	if strings.Contains(body, `"servers":null`) {
		t.Errorf("servers came back null: %s", body)
	}
	var raw map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	list, ok := raw["servers"].([]any)
	if !ok {
		t.Fatalf("servers is %T, want an array: %s", raw["servers"], body)
	}
	if len(list) != 0 {
		t.Errorf("servers = %v, want none", list)
	}
}

// The default server is offered even when the operator did not list it.
func TestConfigEndpointOffersTheDefaultServer(t *testing.T) {
	server := newServer(t, &config.Config{
		Listen:        ":0",
		DefaultServer: "https://music.example.com",
		Servers:       []config.Server{{Name: "Other", URL: "https://other.example.com"}},
	})
	response := do(t, server.Handler(), "GET", "/ui/config", nil, nil)

	var payload uiConfig
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Servers) != 2 {
		t.Fatalf("servers = %+v, want the default first and the listed one", payload.Servers)
	}
	if payload.Servers[0].URL != "https://music.example.com" || payload.Servers[0].Name == "" {
		t.Errorf("the default server should lead the list and carry a name: %+v", payload.Servers[0])
	}
	if payload.Servers[1].Name != "Other" {
		t.Errorf("the listed server lost its name: %+v", payload.Servers[1])
	}
}

func TestHealthz(t *testing.T) {
	server := newServer(t, &config.Config{Listen: ":0"})
	response := do(t, server.Handler(), "GET", "/healthz", nil, nil)
	if response.Code != http.StatusOK || !strings.HasPrefix(response.Body.String(), "ok") {
		t.Errorf("healthz = %d %q", response.Code, response.Body)
	}
}

// Rooms are a WebSocket, and a WebSocket is an upgrade: the router has to pass
// the tunnel through untouched or listen-together cannot work at all.
func TestProxyTunnelsWebSocketUpgrades(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, buffer, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)
			return
		}
		defer connection.Close()
		_, _ = buffer.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		_ = buffer.Flush()
		line, err := buffer.ReadString('\n')
		if err != nil {
			return
		}
		_, _ = buffer.WriteString("echo:" + line)
		_ = buffer.Flush()
	}))
	defer backend.Close()

	server, err := New(&config.Config{Listen: ":0"}, slog.New(slog.NewTextHandler(io.Discard, nil)), "")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	front := httptest.NewServer(server.Handler())
	defer front.Close()

	host := strings.TrimPrefix(front.URL, "http://")
	connection, err := net.Dial("tcp", host)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer connection.Close()

	request := "GET /api/v1/ws?ms=" + url.QueryEscape(backend.URL) + " HTTP/1.1\r\n" +
		"Host: " + host + "\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
	if _, err := connection.Write([]byte(request)); err != nil {
		t.Fatalf("write: %v", err)
	}

	reader := bufio.NewReader(connection)
	status, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read status: %v", err)
	}
	if !strings.Contains(status, "101") {
		t.Fatalf("status line = %q, want an upgrade", status)
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read headers: %v", err)
		}
		if line == "\r\n" {
			break
		}
	}
	if _, err := connection.Write([]byte("hello\n")); err != nil {
		t.Fatalf("write frame: %v", err)
	}
	echo, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if strings.TrimSpace(echo) != "echo:hello" {
		t.Errorf("tunnel echoed %q", echo)
	}
}

// The link preview an app builds for a shared page needs absolute URLs, and
// this server only ever sees plain HTTP on loopback - so the page has to take
// its public address from the request that served it.
func TestPageNamesTheOriginItWasReachedOn(t *testing.T) {
	server := newServer(t, &config.Config{Listen: ":0"})

	response := do(t, server.Handler(), "GET", "/", map[string]string{
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "music.example",
	}, nil)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	body := response.Body.String()
	if strings.Contains(body, "{{origin}}") {
		t.Errorf("the page still carries the placeholder:\n%s", body)
	}
	if !strings.Contains(body, `content="https://music.example/icon.png"`) {
		t.Errorf("the embed image is not absolute, so no app will show it:\n%s", body)
	}
}

// A Host header is whatever the client sent, and this value lands in an
// attribute a crawler reads: a page pointing at the attacker's image is worse
// than a page with no preview at all.
func TestPageRefusesAHostThatCouldBreakOutOfTheAttribute(t *testing.T) {
	server := newServer(t, &config.Config{Listen: ":0"})

	response := do(t, server.Handler(), "GET", "/", map[string]string{
		"X-Forwarded-Host": `evil.example"><script>alert(1)</script>`,
	}, nil)

	if body := response.Body.String(); strings.Contains(body, "evil.example") || strings.Contains(body, "<script>alert") {
		t.Errorf("a hostile host reached the page:\n%s", body)
	}
}

// A browser told "no-cache" revalidates, so the answer has to come from the
// file's contents. Everything in the store is stamped 1970, and a Last-Modified
// from that never changes: every browser kept its first copy of the frontend,
// and a deploy could not reach it however many times it was deployed.
func TestFrontendRevalidatesByContent(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, body string) {
		t.Helper()
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("index.html", `<html><link rel="stylesheet" href="theme.css" /></html>`)
	write("theme.css", "body { color: red }")
	write("js/app.js", "console.log('one')")

	server, err := New(&config.Config{Listen: ":0"}, slog.New(slog.NewTextHandler(io.Discard, nil)), dir)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	first := do(t, server.Handler(), "GET", "/js/app.js", nil, nil)
	tag := first.Header().Get("ETag")
	if tag == "" {
		t.Fatal("a module is served with no ETag, so nothing can revalidate it")
	}
	if got := first.Header().Get("Last-Modified"); got != "" {
		t.Errorf("Last-Modified = %q; the store's mtimes are the epoch and say nothing", got)
	}

	// The same bytes are Not Modified; different bytes are sent.
	again := do(t, server.Handler(), "GET", "/js/app.js", map[string]string{"If-None-Match": tag}, nil)
	if again.Code != http.StatusNotModified {
		t.Errorf("revalidating an unchanged file = %d, want 304", again.Code)
	}
	write("js/app.js", "console.log('two')")
	changed := do(t, server.Handler(), "GET", "/js/app.js", map[string]string{"If-None-Match": tag}, nil)
	if changed.Code != http.StatusOK {
		t.Errorf("a changed file = %d, want 200", changed.Code)
	}
	if changed.Header().Get("ETag") == tag {
		t.Error("the ETag did not follow the contents")
	}

	// And the shell's stylesheet stamp follows the frontend too, so a deploy
	// asks for a URL the browser has never seen.
	before := do(t, server.Handler(), "GET", "/", nil, nil).Body.String()
	write("theme.css", "body { color: blue }")
	after := do(t, server.Handler(), "GET", "/", nil, nil).Body.String()
	if before == after {
		t.Error("the stylesheet stamp did not change with the frontend")
	}
}
