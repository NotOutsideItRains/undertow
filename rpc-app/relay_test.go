package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRelayLocalWinsAndPauseClears(t *testing.T) {
	d := NewDiscord("123456789012345678", func(string, ...any) {})
	tr := NewTracker(d)
	song := Presence{Title: "Song", Artist: "Me", Playing: true, DurationMs: 200000}
	tr.Relay(song)
	if !tr.relayed {
		t.Fatal("relay should show when nothing local is playing")
	}
	tr.Relay(Presence{Playing: false})
	if tr.relayed {
		t.Fatal("paused on the server should clear the relayed card")
	}
	tr.Update(song) // a local browser reports
	tr.Relay(song)
	if tr.relayed {
		t.Fatal("a fresh local report must win over the relay")
	}
	tr.Relay(Presence{Playing: false})
	tr.Clear()
}

func TestRunRelaySendsKey(t *testing.T) {
	got := make(chan string, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got <- r.Header.Get("Authorization")
		w.Write([]byte(`{"title":"Song","artist":"Me","playing":true,"durationMs":1000}`))
	}))
	defer srv.Close()
	d := NewDiscord("123456789012345678", func(string, ...any) {})
	tr := NewTracker(d)
	ctx, cancel := context.WithCancel(context.Background())
	go RunRelay(ctx, srv.URL, "urp_x", tr, func(string, ...any) {})
	select {
	case a := <-got:
		if a != "Bearer urp_x" {
			t.Fatalf("auth header %q", a)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no poll")
	}
	cancel()
}
