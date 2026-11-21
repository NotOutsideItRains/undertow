package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

const relayEvery = 10 * time.Second

// An Undertow address is an https origin (plain http only for this computer or a home network name while testing).
func cleanServer(s string) string {
	s = strings.TrimRight(strings.TrimSpace(s), "/")
	if s == "" {
		return ""
	}
	if o := cleanOrigin(s); o != "" {
		return o
	}
	if strings.HasPrefix(s, "http://") && !strings.ContainsAny(s[7:], "/?# ") {
		return strings.ToLower(s)
	}
	return ""
}

// RunRelay asks the Undertow server every few seconds what the account is playing and passes it to the tracker, until ctx ends.
func RunRelay(ctx context.Context, server, key string, t *Tracker, logf func(string, ...any)) {
	client := &http.Client{Timeout: 8 * time.Second}
	failing := false
	poll := func() {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, server+"/api/rpc/now", nil)
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("User-Agent", "undertow-rpc/"+version)
		resp, err := client.Do(req)
		if err == nil && resp.StatusCode != 200 {
			resp.Body.Close()
			err = &statusErr{resp.StatusCode}
		}
		if err != nil {
			if !failing {
				failing = true
				if se, ok := err.(*statusErr); ok && se.code == 401 {
					logf("Relay: Undertow doesn't accept the key. Make a new one on the Discord tab.")
				} else {
					logf("Relay: can't reach %s (%v). Trying again.", server, err)
				}
			}
			return
		}
		defer resp.Body.Close()
		var p Presence
		if json.NewDecoder(io.LimitReader(resp.Body, 16<<10)).Decode(&p) != nil {
			return
		}
		if failing {
			failing = false
			logf("Relay: connected to %s.", server)
		}
		t.Relay(p)
	}
	logf("Relay on: following %s every %d seconds.", server, int(relayEvery/time.Second))
	poll()
	tk := time.NewTicker(relayEvery)
	defer tk.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tk.C:
			poll()
		}
	}
}

type statusErr struct{ code int }

func (e *statusErr) Error() string { return http.StatusText(e.code) }
