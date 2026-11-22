package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Set when building (see build.sh): the Discord application the card is shown under, and the sites allowed to talk to this app.
var (
	defaultClientID = "1573709606671356118" // "Monochrome Player"
	defaultOrigins  = "http://localhost:7000" // your own addresses go here: build with ORIGINS=... (see build.sh) or run with --allow
	version         = "1.1.0"
)

type Config struct {
	ClientID string   `json:"clientId,omitempty"`
	Origins  []string `json:"origins,omitempty"`
	Port     int      `json:"port,omitempty"`
	Server   string   `json:"server,omitempty"`   // relay: the Undertow address, like https://undertow.example.com
	RelayKey string   `json:"relayKey,omitempty"` // relay: the key made on Undertow's Discord tab
}

var idRe = regexp.MustCompile(`^[0-9]{17,20}$`)

func configPath() string {
	d, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(d, "undertow-rpc", "config.json")
}

func loadConfig() Config {
	var c Config
	if p := configPath(); p != "" {
		if b, err := os.ReadFile(p); err == nil {
			json.Unmarshal(b, &c)
		}
	}
	return c
}

func (c Config) save() error {
	p := configPath()
	if p == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(p, b, 0o600)
}

// An origin is scheme://host[:port] and nothing else.
func cleanOrigin(o string) string {
	o = strings.TrimRight(strings.TrimSpace(o), "/")
	if !(strings.HasPrefix(o, "https://") || strings.HasPrefix(o, "http://localhost") || strings.HasPrefix(o, "http://127.0.0.1")) || strings.ContainsAny(o[8:], "/?# ") {
		return ""
	}
	return strings.ToLower(o)
}
