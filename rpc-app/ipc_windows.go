//go:build windows

package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"time"
)

// On Windows, Discord listens on a named pipe.
func ipcCandidates() []string {
	var out []string
	for i := 0; i < 10; i++ {
		out = append(out, fmt.Sprintf(`\\.\pipe\discord-ipc-%d`, i))
	}
	return out
}

// pipeConn lets a named pipe (an ordinary file handle) be used like a connection.
type pipeConn struct{ f *os.File }

func (p *pipeConn) Read(b []byte) (int, error)         { return p.f.Read(b) }
func (p *pipeConn) Write(b []byte) (int, error)        { return p.f.Write(b) }
func (p *pipeConn) Close() error                       { return p.f.Close() }
func (p *pipeConn) LocalAddr() net.Addr                { return pipeAddr{} }
func (p *pipeConn) RemoteAddr() net.Addr               { return pipeAddr{} }
func (p *pipeConn) SetDeadline(t time.Time) error      { return nil }
func (p *pipeConn) SetReadDeadline(t time.Time) error  { return nil }
func (p *pipeConn) SetWriteDeadline(t time.Time) error { return nil }

type pipeAddr struct{}

func (pipeAddr) Network() string { return "pipe" }
func (pipeAddr) String() string  { return "discord-ipc" }

var _ io.ReadWriteCloser = (*pipeConn)(nil)

func dialIPC(path string) (net.Conn, error) {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	return &pipeConn{f}, nil
}
