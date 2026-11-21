package main

import (
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// What a player tells us: the song, and how far into it it is.
type Presence struct {
	Title      string  `json:"title"`
	Artist     string  `json:"artist"`
	Album      string  `json:"album"`
	DurationMs float64 `json:"durationMs"`
	PositionMs float64 `json:"positionMs"`
	Playing    bool    `json:"playing"`
	CoverURL   string  `json:"coverUrl"`
	TidalID    string  `json:"tidalId"`
	Source     string  `json:"source"` // which player: "Monochrome", "Undertow"
}

var digits = regexp.MustCompile(`^[0-9]{1,12}$`)

// Discord wants 2 to 128 characters in its text lines.
func clip(s string, n int) string {
	s = strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return ' '
		}
		return r
	}, s)), " ")
	if utf8.RuneCountInString(s) > n {
		r := []rune(s)
		s = string(r[:n-1]) + "…"
	}
	return s
}

func pad(s string) string {
	if utf8.RuneCountInString(s) < 2 {
		return s + " ​"
	}
	return s
}

// A cover is only passed on if it is an https address: Discord fetches it itself, so nothing from this computer is sent.
func okCover(s string) string {
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || len(s) > 512 {
		return ""
	}
	return s
}

// Activity turns a Presence into what Discord shows: a "Listening to" card with the cover, the song, the artist, a progress bar and a TIDAL button.
func (p Presence) Activity(now time.Time) Activity {
	title, artist := clip(p.Title, 128), clip(p.Artist, 128)
	if title == "" {
		return nil
	}
	a := Activity{
		"type":    2, // Listening
		"details": pad(title),
		"state":   pad(orDash(artist)),
		// which line the member list shows next to "Listening to": 1 is the artist
		"status_display_type": 1,
	}
	if p.DurationMs > 1000 && p.DurationMs < 24*3600*1000 && p.PositionMs >= 0 {
		pos := p.PositionMs
		if pos > p.DurationMs {
			pos = p.DurationMs
		}
		start := now.Add(-time.Duration(pos) * time.Millisecond)
		a["timestamps"] = map[string]any{"start": start.Unix(), "end": start.Add(time.Duration(p.DurationMs) * time.Millisecond).Unix()}
	}
	assets := map[string]any{}
	if c := okCover(p.CoverURL); c != "" {
		assets["large_image"] = c
	}
	if album := clip(p.Album, 128); album != "" {
		assets["large_text"] = pad(album)
	}
	if len(assets) > 0 {
		a["assets"] = assets
	}
	if digits.MatchString(p.TidalID) {
		a["buttons"] = []map[string]string{{"label": "Listen on TIDAL", "url": "https://tidal.com/track/" + p.TidalID}}
	}
	return a
}

func orDash(s string) string {
	if s == "" {
		return "Unknown artist"
	}
	return s
}

// Tracker remembers the last thing a player said and clears it when the player goes quiet, so a closed tab doesn't leave a song on show.
type Tracker struct {
	mu      sync.Mutex
	last    time.Time
	d       *Discord
	timer   *time.Timer
	relayed bool // what is on show came from the server relay, not a local browser
}

const quiet = 50 * time.Second // players report at least every 15 seconds while playing

func NewTracker(d *Discord) *Tracker { return &Tracker{d: d} }

func (t *Tracker) Update(p Presence) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.last = time.Now()
	t.relayed = false
	if t.timer != nil {
		t.timer.Stop()
	}
	if !p.Playing {
		t.d.Set(nil) // paused or stopped: nothing on show
		return
	}
	t.d.Set(p.Activity(time.Now()))
	t.timer = time.AfterFunc(quiet, func() { t.d.Set(nil) })
}

func (t *Tracker) Clear() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.timer != nil {
		t.timer.Stop()
	}
	t.d.Set(nil)
}

// Relay feeds what the Undertow server says the account is playing (from a phone, say). A local browser that reported within the
// last `quiet` wins; paused or idle on the server only clears what the relay itself put on show.
func (t *Tracker) Relay(p Presence) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.last.IsZero() && time.Since(t.last) < quiet && !t.relayed {
		return
	}
	if !p.Playing || p.Title == "" {
		if t.relayed {
			if t.timer != nil {
				t.timer.Stop()
			}
			t.relayed = false
			t.d.Set(nil)
		}
		return
	}
	t.relayed = true
	if t.timer != nil {
		t.timer.Stop()
	}
	t.d.Set(p.Activity(time.Now()))
	t.timer = time.AfterFunc(30*time.Second, func() { // the poll runs every 10 s; silence means the server is unreachable
		t.mu.Lock()
		defer t.mu.Unlock()
		if t.relayed {
			t.relayed = false
			t.d.Set(nil)
		}
	})
}
