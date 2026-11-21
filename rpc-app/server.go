package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

type Server struct {
	mu      sync.Mutex
	origins map[string]bool
	port    int
	d       *Discord
	t       *Tracker
	cfg     *Config
	quit    chan struct{}
	logf    func(string, ...any)
}

func NewServer(port int, origins []string, d *Discord, t *Tracker, cfg *Config, logf func(string, ...any)) *Server {
	s := &Server{origins: map[string]bool{}, port: port, d: d, t: t, cfg: cfg, quit: make(chan struct{}), logf: logf}
	for _, o := range origins {
		if c := cleanOrigin(o); c != "" {
			s.origins[c] = true
		}
	}
	return s
}

func (s *Server) allowed(origin string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.origins[strings.ToLower(origin)]
}

// Only this computer's own address may be used to reach the app (a website can't point its own name at 127.0.0.1 and get in).
func (s *Server) hostOK(h string) bool {
	host, _, err := net.SplitHostPort(h)
	if err != nil {
		host = h
	}
	return host == "127.0.0.1" || host == "localhost" || host == "[::1]" || host == "::1"
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "Undertow presence %s: connected to Discord: %v\n", version, func() bool { c, _ := s.d.Status(); return c }())
	})
	mux.HandleFunc("/status", s.status)
	mux.HandleFunc("/presence", s.presence)
	mux.HandleFunc("/clear", func(w http.ResponseWriter, r *http.Request) { s.t.Clear(); s.ok(w) })
	mux.HandleFunc("/config", s.config)
	mux.HandleFunc("/quit", func(w http.ResponseWriter, r *http.Request) {
		s.ok(w)
		select {
		case <-s.quit:
		default:
			close(s.quit)
		}
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.hostOK(r.Host) {
			http.Error(w, "wrong address", http.StatusMisdirectedRequest)
			return
		}
		origin := r.Header.Get("Origin")
		if origin != "" {
			if !s.allowed(origin) {
				http.Error(w, "this site isn't allowed to use the app", http.StatusForbidden)
				return
			}
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type")
			h.Set("Access-Control-Allow-Private-Network", "true") // browsers ask before letting a public site reach 127.0.0.1
			h.Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		// A site could send a "simple" cross-site request without a preflight: anything that writes has to say it is JSON.
		if r.Method == http.MethodPost && origin != "" && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "send JSON", http.StatusUnsupportedMediaType)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) ok(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	io.WriteString(w, `{"ok":true}`)
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	connected, user := s.d.Status()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"app": "undertow-rpc", "version": version, "discord": map[string]any{"connected": connected, "user": user}, "clientId": s.cfg.ClientID})
}

func (s *Server) presence(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var p Presence
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&p); err != nil {
		http.Error(w, "bad JSON", http.StatusBadRequest)
		return
	}
	s.t.Update(p)
	s.ok(w)
}

// The page can say which Discord application to use, and which other sites may talk to the app.
func (s *Server) config(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var c struct {
		ClientID string `json:"clientId"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&c); err != nil || !idRe.MatchString(c.ClientID) {
		http.Error(w, "that isn't a Discord application ID", http.StatusBadRequest)
		return
	}
	s.cfg.ClientID = c.ClientID
	s.cfg.save()
	s.d.SetClientID(c.ClientID)
	s.logf("Discord application changed.")
	s.ok(w)
}
