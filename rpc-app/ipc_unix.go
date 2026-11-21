//go:build !windows

package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"
)

// Where Discord keeps its local socket: the runtime directory, with a few app-specific subfolders (Flatpak, Snap).
func ipcCandidates() []string {
	var dirs []string
	for _, e := range []string{"XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"} {
		if v := os.Getenv(e); v != "" {
			dirs = append(dirs, v)
		}
	}
	dirs = append(dirs, "/tmp")
	subs := []string{"", "app/com.discordapp.Discord", "app/com.discordapp.DiscordCanary", "app/com.discordapp.DiscordPTB", "snap.discord", "snap.discord-canary"}
	var out []string
	seen := map[string]bool{}
	for _, d := range dirs {
		for _, s := range subs {
			for i := 0; i < 10; i++ {
				p := filepath.Join(d, s, fmt.Sprintf("discord-ipc-%d", i))
				if !seen[p] {
					seen[p] = true
					out = append(out, p)
				}
			}
		}
	}
	return out
}

func dialIPC(path string) (net.Conn, error) {
	return net.DialTimeout("unix", path, 2*time.Second)
}
