// Undertow presence: shows what you're listening to in Undertow's players as your Discord status.
// The player pages talk to this small program on 127.0.0.1:8892; it talks to the Discord app on this computer.
package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

type listFlag []string

func (l *listFlag) String() string     { return strings.Join(*l, ",") }
func (l *listFlag) Set(v string) error { *l = append(*l, v); return nil }

func main() {
	var allow listFlag
	port := flag.Int("port", 0, "port to listen on (default 8892)")
	clientID := flag.String("client-id", "", "Discord application ID to show the card under")
	server := flag.String("server", "", "relay: your Undertow address, like https://undertow.example.com (saved)")
	relayKey := flag.String("relay-key", "", "relay: the key made on Undertow's Discord tab (saved)")
	noRelay := flag.Bool("no-relay", false, "turn the relay off and forget its key")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Var(&allow, "allow", "another site allowed to talk to this app, like https://example.com (repeatable)")
	flag.Parse()
	if *showVersion {
		fmt.Println("undertow-rpc", version)
		return
	}
	logf := func(f string, a ...any) { fmt.Printf("%s  %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(f, a...)) }

	cfg := loadConfig()
	if *clientID != "" {
		if !idRe.MatchString(*clientID) {
			fmt.Println("That isn't a Discord application ID (17 to 20 digits).")
			os.Exit(2)
		}
		cfg.ClientID = *clientID
	}
	if *noRelay {
		cfg.Server, cfg.RelayKey = "", ""
		cfg.save()
		logf("Relay turned off.")
	}
	if *server != "" || *relayKey != "" {
		if *server != "" {
			s := cleanServer(*server)
			if s == "" {
				fmt.Println("That isn't an Undertow address. Use something like https://undertow.example.com")
				os.Exit(2)
			}
			cfg.Server = s
		}
		if *relayKey != "" {
			cfg.RelayKey = strings.TrimSpace(*relayKey)
		}
		if cfg.Server == "" || cfg.RelayKey == "" {
			fmt.Println("The relay needs both --server and --relay-key.")
			os.Exit(2)
		}
		cfg.save()
	}
	if cfg.ClientID == "" {
		cfg.ClientID = defaultClientID
	}
	p := 8892
	if cfg.Port != 0 {
		p = cfg.Port
	}
	if *port != 0 {
		p = *port
	}
	origins := append(strings.Split(defaultOrigins, ","), cfg.Origins...)
	origins = append(origins, allow...)

	d := NewDiscord(cfg.ClientID, logf)
	t := NewTracker(d)
	srv := NewServer(p, origins, d, t, &cfg, logf)

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
	if err != nil {
		fmt.Printf("Can't listen on 127.0.0.1:%d (%v). Is the app already running?\n", p, err)
		fmt.Println("Press Enter to close.")
		fmt.Scanln()
		os.Exit(1)
	}
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go hs.Serve(ln)
	go d.Run()
	relayCtx, stopRelay := context.WithCancel(context.Background())
	defer stopRelay()
	if cfg.Server != "" && cfg.RelayKey != "" {
		go RunRelay(relayCtx, cfg.Server, cfg.RelayKey, t, logf)
	}

	fmt.Printf("Undertow presence %s\n", version)
	logf("Listening on 127.0.0.1:%d. Open Undertow in your browser to connect. Close this window to stop.", p)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sig:
	case <-srv.quit:
		logf("Told to stop by the page.")
	}
	stopRelay()
	t.Clear()
	time.Sleep(300 * time.Millisecond) // let the "nothing on show" reach Discord
	d.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	hs.Shutdown(ctx)
}
