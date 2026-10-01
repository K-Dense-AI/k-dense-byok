package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testPaths(t *testing.T) paths {
	t.Helper()
	root := t.TempDir()
	p := paths{Data: filepath.Join(root, "data"), Config: filepath.Join(root, "config"), Cache: filepath.Join(root, "cache")}
	for _, d := range []string{p.Data, p.Config, p.Cache} {
		if e := os.MkdirAll(d, 0700); e != nil {
			t.Fatal(e)
		}
	}
	return p
}
func TestPortConflictNeverKillsOwner(t *testing.T) {
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	occupied := listener.Addr().(*net.TCPAddr).Port
	chosen, v6, e := reservePort(occupied)
	if e != nil || chosen == occupied {
		t.Fatalf("expected fallback, got %d %v", chosen, e)
	}
	if v6 != nil {
		v6.Close()
	}
	connection, e := net.Dial("tcp4", listener.Addr().String())
	if e != nil {
		t.Fatal("port owner was disturbed", e)
	}
	connection.Close()
}
func TestPortOccupiedOnlyOnIPv6LoopbackIsSkipped(t *testing.T) {
	if !ipv6Loopback() {
		t.Skip("no IPv6 loopback")
	}
	// e.g. a dev server on [::1]:3000 that `localhost` would reach first.
	other, e := net.Listen("tcp6", "[::1]:0")
	if e != nil {
		t.Fatal(e)
	}
	defer other.Close()
	occupied := other.Addr().(*net.TCPAddr).Port
	chosen, v6, e := reservePort(occupied)
	if e != nil || chosen == occupied {
		t.Fatalf("expected fallback, got %d %v", chosen, e)
	}
	v6.Close()
}
func TestIPv6LoopbackForwardsToService(t *testing.T) {
	if !ipv6Loopback() {
		t.Skip("no IPv6 loopback")
	}
	port, v6, e := reservePort(0)
	if e != nil {
		t.Fatal(e)
	}
	defer v6.Close()
	service, e := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
	if e != nil {
		t.Fatal(e)
	}
	defer service.Close()
	go func() {
		c, e := service.Accept()
		if e == nil {
			io.Copy(c, c)
			c.Close()
		}
	}()
	go forward(v6, service.Addr().String())
	c, e := net.Dial("tcp6", fmt.Sprintf("[::1]:%d", port))
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	c.Write([]byte("kady"))
	c.(*net.TCPConn).CloseWrite()
	b, _ := io.ReadAll(c)
	if string(b) != "kady" {
		t.Fatalf("relayed %q", b)
	}
	// The ::1 side stays reserved while the forwarder runs.
	if l, e := net.Listen("tcp6", fmt.Sprintf("[::1]:%d", port)); e == nil {
		l.Close()
		t.Fatal("another program could claim [::1] for Kady's port")
	}
}
func TestInstanceLock(t *testing.T) {
	file := filepath.Join(t.TempDir(), "instance.lock")
	unlock, e := lockInstance(file)
	if e != nil {
		t.Fatal(e)
	}
	if second, e := lockInstance(file); e == nil {
		second()
		t.Fatal("second supervisor acquired the lock")
	}
	unlock()
	unlock, e = lockInstance(file)
	if e != nil {
		t.Fatal("lock was not released", e)
	}
	unlock()
}
func TestImportPreservesProjectsAndExistingCredentials(t *testing.T) {
	p := testPaths(t)
	source := filepath.Join(t.TempDir(), "old checkout ü")
	root := filepath.Join(source, "projects")
	os.MkdirAll(root, 0700)
	os.WriteFile(filepath.Join(root, "index.json"), []byte(`{"projects":{"sample":{"id":"sample"}}}`), 0600)
	os.WriteFile(filepath.Join(root, "research.txt"), []byte("unchanged"), 0600)
	os.WriteFile(filepath.Join(source, ".env"), []byte("OLD=value\n"), 0600)
	os.WriteFile(filepath.Join(p.Config, ".env"), []byte("CURRENT=value\n"), 0600)
	if e := selectCheckout(p, source); e != nil {
		t.Fatal(e)
	}
	if actual := projectsRoot(p); actual != root {
		t.Fatalf("root %q", actual)
	}
	b, _ := os.ReadFile(filepath.Join(p.Config, ".env"))
	if string(b) != "CURRENT=value\n" {
		t.Fatal("existing credentials overwritten")
	}
	b, _ = os.ReadFile(filepath.Join(root, "research.txt"))
	if string(b) != "unchanged" {
		t.Fatal("research data modified")
	}
}
func TestInvalidImportDoesNotChangeSettings(t *testing.T) {
	p := testPaths(t)
	if e := selectCheckout(p, t.TempDir()); e == nil {
		t.Fatal("invalid import accepted")
	}
	if _, e := os.Stat(filepath.Join(p.Config, "workspace.json")); !os.IsNotExist(e) {
		t.Fatal("invalid import wrote settings")
	}
}
func TestAtomicStateAndEnvironment(t *testing.T) {
	p := testPaths(t)
	file := filepath.Join(p.Data, "instance.json")
	for _, token := range []string{"first", "second"} {
		b, _ := json.Marshal(instance{Token: token})
		if e := atomicFile(file, b); e != nil {
			t.Fatal(e)
		}
	}
	s, e := readInstance(p)
	if e != nil || s.Token != "second" {
		t.Fatal("state replacement failed", e)
	}
	entries := setEnv([]string{"PATH=old", "OTHER=value"}, map[string]string{"PATH": "new"})
	if strings.Contains(strings.Join(entries, "\n"), "PATH=old") {
		t.Fatal("ambient PATH survived")
	}
}
func TestLockHeldReflectsAnotherSupervisor(t *testing.T) {
	p := testPaths(t)
	if lockHeld(p) {
		t.Fatal("free lock reported held")
	}
	unlock, e := lockInstance(filepath.Join(p.Data, "instance.lock"))
	if e != nil {
		t.Fatal(e)
	}
	if !lockHeld(p) {
		t.Fatal("held lock reported free")
	}
	unlock()
	if lockHeld(p) {
		t.Fatal("probe kept the lock")
	}
}
func TestLogRotatesAndKeepsOneGeneration(t *testing.T) {
	file := filepath.Join(t.TempDir(), "kady.log")
	os.WriteFile(file, bytes.Repeat([]byte("o"), 64), 0600)
	l, e := openLog(file, 40, false)
	if e != nil {
		t.Fatal(e)
	}
	// The oversized previous run moved aside at open.
	if b, _ := os.ReadFile(file + ".1"); len(b) != 64 {
		t.Fatalf("previous log %d bytes", len(b))
	}
	for range 3 {
		l.Write([]byte("0123456789abcdef\n")) // 17 bytes
	}
	current, _ := os.ReadFile(file)
	previous, _ := os.ReadFile(file + ".1")
	if string(current) != "0123456789abcdef\n" || string(previous) != strings.Repeat("0123456789abcdef\n", 2) {
		t.Fatalf("current %q previous %q", current, previous)
	}
	tail, e := tailFile(file+".1", 5)
	if e != nil || string(tail) != "cdef\n" {
		t.Fatalf("tail %q %v", tail, e)
	}
}
func TestCleanupIgnoresReusedProcessIDs(t *testing.T) {
	before := parseProcessTable(`
  100     1 Wed Oct  1 07:00:00 2026
  101   100 Wed Oct  1 07:00:01 2026
  102   101 Wed Oct  1 07:00:02 2026
  999     1 Wed Oct  1 06:00:00 2026
`)
	recorded := map[int]string{}
	for pid := range descendantsOf(before, map[int]bool{100: true}) {
		recorded[pid] = before[pid].start
	}
	if len(recorded) != 3 {
		t.Fatalf("recorded %v", recorded)
	}
	// 100 exited and its number went to an unrelated program; 101 (a detached
	// runner) was reparented and started a new child.
	now := parseProcessTable(`
  100    50 Wed Oct  1 08:00:00 2026
  101     1 Wed Oct  1 07:00:01 2026
  103   101 Wed Oct  1 08:00:01 2026
  200   100 Wed Oct  1 08:00:02 2026
  999     1 Wed Oct  1 06:00:00 2026
`)
	got := descendantsOf(now, stillRunning(now, recorded))
	want := map[int]bool{101: true, 103: true}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("would signal %v, want %v", got, want)
	}
}
