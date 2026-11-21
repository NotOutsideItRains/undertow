//go:build !windows

package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A stand-in for the Discord app: it accepts the handshake and records what it is told to show.
type fakeDiscord struct {
	mu     sync.Mutex
	frames []map[string]any
	hello  map[string]any
	ln     net.Listener
}

func startFake(t *testing.T, dir string) *fakeDiscord {
	ln, err := net.Listen("unix", filepath.Join(dir, "discord-ipc-0"))
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeDiscord{ln: ln}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				op, body, err := readFrame(c)
				if err != nil || op != opHandshake {
					return
				}
				json.Unmarshal(body, &f.hello)
				writeFrame(c, opFrame, map[string]any{"cmd": "DISPATCH", "evt": "READY", "data": map[string]any{"user": map[string]any{"username": "tester"}}})
				for {
					_, body, err := readFrame(c)
					if err != nil {
						return
					}
					var m map[string]any
					json.Unmarshal(body, &m)
					f.mu.Lock()
					f.frames = append(f.frames, m)
					f.mu.Unlock()
				}
			}()
		}
	}()
	return f
}

func (f *fakeDiscord) waitFor(t *testing.T, n int) []map[string]any {
	for i := 0; i < 80; i++ {
		f.mu.Lock()
		if len(f.frames) >= n {
			out := append([]map[string]any(nil), f.frames...)
			f.mu.Unlock()
			return out
		}
		f.mu.Unlock()
		time.Sleep(100 * time.Millisecond)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	t.Fatalf("expected %d frames, got %d: %v", n, len(f.frames), f.frames)
	return nil
}

func setup(t *testing.T) (*httptest.Server, *fakeDiscord, *Server) {
	dir := t.TempDir()
	os.Setenv("XDG_RUNTIME_DIR", dir)
	fake := startFake(t, dir)
	t.Cleanup(func() { fake.ln.Close() })
	logf := func(string, ...any) {}
	d := NewDiscord("1573709606671356118", logf)
	go d.Run()
	t.Cleanup(d.Close)
	cfg := &Config{ClientID: "1573709606671356118"}
	srv := NewServer(8892, []string{"https://player.example"}, d, NewTracker(d), cfg, logf)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	for i := 0; i < 50; i++ {
		if c, _ := d.Status(); c {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	return ts, fake, srv
}

func post(t *testing.T, url, origin, ctype, body string) *http.Response {
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("Content-Type", ctype)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	req.Host = "127.0.0.1:8892"
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestHandshakeAndPresence(t *testing.T) {
	ts, fake, _ := setup(t)
	if fake.hello["client_id"] != "1573709606671356118" || fake.hello["v"] != float64(1) {
		t.Fatalf("handshake: %v", fake.hello)
	}
	body := `{"title":"Ordinary World","artist":"Duran Duran","album":"Duran Duran (The Wedding Album)","durationMs":340000,"positionMs":60000,"playing":true,"coverUrl":"https://resources.tidal.com/images/2f55b7be/3242/4a70/9322/d58947091b45/640x640.jpg","tidalId":"147542"}`
	r := post(t, ts.URL+"/presence", "https://player.example", "application/json", body)
	if r.StatusCode != 200 || r.Header.Get("Access-Control-Allow-Origin") != "https://player.example" {
		t.Fatalf("presence: %d %v", r.StatusCode, r.Header)
	}
	frames := fake.waitFor(t, 1)
	f := frames[0]
	if f["cmd"] != "SET_ACTIVITY" || f["nonce"] == "" {
		t.Fatalf("frame: %v", f)
	}
	act := f["args"].(map[string]any)["activity"].(map[string]any)
	if act["type"] != float64(2) || act["details"] != "Ordinary World" || act["state"] != "Duran Duran" {
		t.Fatalf("activity: %v", act)
	}
	ts2 := act["timestamps"].(map[string]any)
	if ts2["end"].(float64)-ts2["start"].(float64) != 340 {
		t.Fatalf("a 340 second song should span 340 seconds: %v", ts2)
	}
	if now := float64(time.Now().Unix()); now-ts2["start"].(float64) < 59 || now-ts2["start"].(float64) > 62 {
		t.Fatalf("a song a minute in should have started a minute ago: %v", ts2)
	}
	assets := act["assets"].(map[string]any)
	if !strings.HasPrefix(assets["large_image"].(string), "https://resources.tidal.com/") || assets["large_text"] != "Duran Duran (The Wedding Album)" {
		t.Fatalf("assets: %v", assets)
	}
	b := act["buttons"].([]any)[0].(map[string]any)
	if b["url"] != "https://tidal.com/track/147542" || b["label"] != "Listen on TIDAL" {
		t.Fatalf("button: %v", b)
	}

	// pausing takes the card down
	time.Sleep(4200 * time.Millisecond) // Discord's pace
	post(t, ts.URL+"/presence", "https://player.example", "application/json", `{"title":"Ordinary World","artist":"Duran Duran","playing":false}`)
	frames = fake.waitFor(t, 2)
	if _, has := frames[1]["args"].(map[string]any)["activity"]; has {
		t.Fatalf("pause should clear: %v", frames[1])
	}
}

func TestOnlyAllowedSitesAndOnlyJSON(t *testing.T) {
	ts, fake, _ := setup(t)
	body := `{"title":"x","artist":"y","playing":true}`
	if r := post(t, ts.URL+"/presence", "https://evil.example", "application/json", body); r.StatusCode != 403 {
		t.Fatalf("another site should be refused, got %d", r.StatusCode)
	}
	if r := post(t, ts.URL+"/presence", "https://player.example", "text/plain", body); r.StatusCode != 415 {
		t.Fatalf("a form-style post should be refused, got %d", r.StatusCode)
	}
	// a made-up host name pointing at this computer is refused too
	req, _ := http.NewRequest("GET", ts.URL+"/status", nil)
	req.Host = "evil.example:8892"
	if r, _ := http.DefaultClient.Do(req); r.StatusCode != 421 {
		t.Fatalf("a foreign host name should be refused, got %d", r.StatusCode)
	}
	time.Sleep(1500 * time.Millisecond)
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.frames) != 0 {
		t.Fatalf("nothing refused should have reached Discord: %v", fake.frames)
	}
}

func TestPreflightAndStatus(t *testing.T) {
	ts, _, _ := setup(t)
	req, _ := http.NewRequest("OPTIONS", ts.URL+"/presence", nil)
	req.Host = "127.0.0.1:8892"
	req.Header.Set("Origin", "https://player.example")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Private-Network", "true")
	r, _ := http.DefaultClient.Do(req)
	if r.StatusCode != 204 || r.Header.Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatalf("preflight: %d %v", r.StatusCode, r.Header)
	}
	req, _ = http.NewRequest("GET", ts.URL+"/status", nil)
	req.Host = "localhost:8892"
	req.Header.Set("Origin", "https://player.example")
	r, _ = http.DefaultClient.Do(req)
	b, _ := io.ReadAll(r.Body)
	var s map[string]any
	json.Unmarshal(b, &s)
	if s["app"] != "undertow-rpc" || s["discord"].(map[string]any)["connected"] != true || s["discord"].(map[string]any)["user"] != "tester" {
		t.Fatalf("status: %s", b)
	}
}

func TestActivityText(t *testing.T) {
	a := Presence{Title: "A", Artist: "", Playing: true}.Activity(time.Now())
	if a["details"] == "A" || a["state"] != "Unknown artist" {
		t.Fatalf("short lines are padded to Discord's two-character minimum, and a missing artist is named: %v", a)
	}
	long := Presence{Title: strings.Repeat("é", 300), Artist: "x"}.Activity(time.Now())
	if n := len([]rune(long["details"].(string))); n != 128 {
		t.Fatalf("long titles are cut to 128 characters, got %d", n)
	}
	if _, has := (Presence{Title: "x", CoverURL: "http://insecure/a.jpg", TidalID: "12; DROP"}).Activity(time.Now())["assets"]; has {
		t.Fatal("only https covers are passed on")
	}
	if _, has := (Presence{Title: "x", TidalID: "12; DROP"}).Activity(time.Now())["buttons"]; has {
		t.Fatal("a TIDAL id that isn't a number gets no button")
	}
}
