package main

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"
)

// Discord's local IPC: every message is [opcode u32 LE][length u32 LE][JSON].
const (
	opHandshake = 0
	opFrame     = 1
	opClose     = 2
	opPing      = 3
	opPong      = 4
)

type Activity map[string]any

// Discord keeps the connection to the Discord app, reconnecting by itself, and sends it the one activity we want shown.
type Discord struct {
	mu        sync.Mutex
	clientID  string
	conn      net.Conn
	user      string
	connected bool
	want      Activity // what should be on show (nil: nothing)
	sent      string   // the JSON last sent, so the same thing isn't sent twice
	lastSend  time.Time
	stop      chan struct{}
	kick      chan struct{}
	logf      func(string, ...any)
}

func NewDiscord(clientID string, logf func(string, ...any)) *Discord {
	return &Discord{clientID: clientID, stop: make(chan struct{}), kick: make(chan struct{}, 1), logf: logf}
}

func (d *Discord) Status() (bool, string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.connected, d.user
}

func (d *Discord) SetClientID(id string) {
	d.mu.Lock()
	changed := d.clientID != id
	d.clientID = id
	conn := d.conn
	d.mu.Unlock()
	if changed && conn != nil {
		conn.Close() // reconnect with the new application
	}
}

// Set says what to show; nil clears it. It never blocks: the loop below sends it when Discord is there.
func (d *Discord) Set(a Activity) {
	d.mu.Lock()
	d.want = a
	d.mu.Unlock()
	select {
	case d.kick <- struct{}{}:
	default:
	}
}

func (d *Discord) Close() {
	close(d.stop)
	d.mu.Lock()
	if d.conn != nil {
		d.conn.Close()
	}
	d.mu.Unlock()
}

func writeFrame(w io.Writer, op uint32, v any) error {
	body, err := json.Marshal(v)
	if err != nil {
		return err
	}
	buf := make([]byte, 8+len(body))
	binary.LittleEndian.PutUint32(buf[0:4], op)
	binary.LittleEndian.PutUint32(buf[4:8], uint32(len(body)))
	copy(buf[8:], body)
	_, err = w.Write(buf)
	return err
}

func readFrame(r io.Reader) (uint32, []byte, error) {
	head := make([]byte, 8)
	if _, err := io.ReadFull(r, head); err != nil {
		return 0, nil, err
	}
	op := binary.LittleEndian.Uint32(head[0:4])
	n := binary.LittleEndian.Uint32(head[4:8])
	if n > 1<<20 {
		return 0, nil, errors.New("frame too large")
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return 0, nil, err
	}
	return op, body, nil
}

func nonce() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// connect finds Discord's socket and does the handshake.
func (d *Discord) connect() (net.Conn, string, error) {
	d.mu.Lock()
	id := d.clientID
	d.mu.Unlock()
	var lastErr error = errors.New("Discord isn't running")
	for _, p := range ipcCandidates() {
		if _, err := os.Stat(p); err != nil && !isPipe(p) {
			continue
		}
		c, err := dialIPC(p)
		if err != nil {
			lastErr = err
			continue
		}
		if err := writeFrame(c, opHandshake, map[string]any{"v": 1, "client_id": id}); err != nil {
			c.Close()
			lastErr = err
			continue
		}
		op, body, err := readFrame(c)
		if err != nil || op != opFrame {
			c.Close()
			lastErr = fmt.Errorf("handshake failed (%v)", err)
			continue
		}
		var ev struct {
			Evt  string `json:"evt"`
			Data struct {
				User struct {
					Username string `json:"username"`
				} `json:"user"`
				Message string `json:"message"`
			} `json:"data"`
		}
		json.Unmarshal(body, &ev)
		if ev.Evt != "READY" {
			c.Close()
			lastErr = fmt.Errorf("Discord said no: %s", ev.Data.Message)
			continue
		}
		return c, ev.Data.User.Username, nil
	}
	return nil, "", lastErr
}

func isPipe(p string) bool { return len(p) > 2 && p[:2] == `\\` }

// Run keeps connected and keeps the activity current until Close.
func (d *Discord) Run() {
	backoff := 3 * time.Second
	for {
		select {
		case <-d.stop:
			return
		default:
		}
		c, user, err := d.connect()
		if err != nil {
			d.logf("Discord: %v. Trying again in %s.", err, backoff)
			select {
			case <-d.stop:
				return
			case <-time.After(backoff):
			}
			if backoff < 20*time.Second {
				backoff += 3 * time.Second
			}
			continue
		}
		backoff = 3 * time.Second
		d.mu.Lock()
		d.conn, d.connected, d.user, d.sent = c, true, user, "null" // Discord starts with nothing on show, so "nothing" needn't be sent
		d.mu.Unlock()
		d.logf("Connected to Discord as %s.", user)
		done := make(chan struct{})
		go d.readLoop(c, done)
		d.sendLoop(c, done)
		c.Close()
		d.mu.Lock()
		d.conn, d.connected = nil, false
		d.mu.Unlock()
		d.logf("Lost the connection to Discord.")
	}
}

func (d *Discord) readLoop(c net.Conn, done chan struct{}) {
	defer close(done)
	for {
		op, body, err := readFrame(c)
		if err != nil {
			return
		}
		switch op {
		case opPing:
			var v any
			json.Unmarshal(body, &v)
			writeFrame(c, opPong, v)
		case opClose:
			return
		}
	}
}

// Discord limits how often an activity can change (about five times in twenty seconds), so changes go out at most every 4 seconds.
const minGap = 4 * time.Second

func (d *Discord) sendLoop(c net.Conn, done chan struct{}) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-d.stop:
			return
		case <-done:
			return
		case <-d.kick:
		case <-tick.C:
		}
		d.mu.Lock()
		want := d.want
		key := "null"
		if want != nil {
			b, _ := json.Marshal(want)
			key = string(b)
		}
		if key == d.sent || time.Since(d.lastSend) < minGap {
			d.mu.Unlock()
			continue
		}
		d.sent, d.lastSend = key, time.Now()
		d.mu.Unlock()
		args := map[string]any{"pid": os.Getpid()}
		if want != nil {
			args["activity"] = want
		}
		if err := writeFrame(c, opFrame, map[string]any{"cmd": "SET_ACTIVITY", "args": args, "nonce": nonce()}); err != nil {
			return
		}
	}
}
