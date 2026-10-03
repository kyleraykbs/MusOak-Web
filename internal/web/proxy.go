package web

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"codeberg.org/kyleraykbs/musoak-web/internal/config"
)

// handleAPI routes the app's API calls to the backend the user chose.
//
// Every request carries what it needs: which backend (header, then cookie,
// then the configured default) and who the caller is (their bearer token, or
// the session cookie when the request comes from a media element that cannot
// set headers). This server keeps neither.
func (s *Server) handleAPI(w http.ResponseWriter, r *http.Request) {
	target, err := s.route(s.selected(r))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	proxy := &httputil.ReverseProxy{
		Transport: s.transport, // the one that refuses private ranges when asked
		Rewrite: func(out *httputil.ProxyRequest) {
			out.SetURL(target)
			// The path is already the backend's own; only the host moves, and
			// the routing parameter is ours, not the backend's.
			query := out.In.URL.Query()
			query.Del(routeParam)
			out.Out.URL.Path = r.URL.Path
			out.Out.URL.RawQuery = query.Encode()
			out.Out.Header.Set("User-Agent", "musoak-web/1")

			// A request from a media element carries no Authorization header;
			// the session cookie is its stand-in. The backend never sees the
			// cookie itself.
			if out.Out.Header.Get("Authorization") == "" {
				if cookie, err := r.Cookie(tokenCookie); err == nil && cookie.Value != "" {
					out.Out.Header.Set("Authorization", "Bearer "+cookie.Value)
				}
			}
			out.Out.Header.Del("Cookie")
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			s.logger.Debug("proxy: backend unreachable", "error", err)
			writeError(w, http.StatusBadGateway, "that server did not answer")
		},
	}
	proxy.ServeHTTP(w, r)
}

// selected is the backend this request goes through: what the request says,
// then what the browser session says, then where this deployment points people.
// A query parameter is the fallback for elements that can set neither headers
// nor anything else — audio and images name their backend in the URL.
func (s *Server) selected(r *http.Request) string {
	if header := strings.TrimSpace(r.Header.Get(serverHeader)); header != "" {
		return header
	}
	if query := strings.TrimSpace(r.URL.Query().Get(routeParam)); query != "" {
		return query
	}
	if cookie, err := r.Cookie(serverCookie); err == nil && strings.TrimSpace(cookie.Value) != "" {
		return strings.TrimSpace(cookie.Value)
	}
	return s.cfg.DefaultServer
}

// route turns what a user chose into a backend this deployment will talk to.
func (s *Server) route(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("no server chosen: pick one in the server menu")
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("%q is not an http or https URL", raw)
	}
	if parsed.User != nil {
		return nil, fmt.Errorf("a server URL may not carry credentials")
	}
	if !s.allowed(raw) {
		return nil, fmt.Errorf("this web UI routes to its listed servers only")
	}
	if s.cfg.BlockPrivateServers && isPrivateHost(parsed.Hostname()) {
		return nil, fmt.Errorf("this web UI does not route to private addresses")
	}
	parsed.Path = ""
	parsed.RawPath = ""
	return parsed, nil
}

func (s *Server) allowed(raw string) bool {
	if listed(s.cfg.Servers, raw) {
		return true
	}
	return s.cfg.AllowCustom() || listed([]config.Server{{URL: s.cfg.DefaultServer}}, raw)
}

func isPrivateHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	// Names are policed where the connection is made (dialGuard), which is the
	// only place their real address is known.
	if ip := net.ParseIP(host); ip != nil {
		return isPrivate(ip)
	}
	return false
}
