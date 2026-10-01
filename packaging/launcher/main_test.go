package main

import (
	"encoding/json"
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
	chosen, e := pickPort(occupied)
	if e != nil || chosen == occupied {
		t.Fatalf("expected fallback, got %d %v", chosen, e)
	}
	connection, e := net.Dial("tcp4", listener.Addr().String())
	if e != nil {
		t.Fatal("port owner was disturbed", e)
	}
	connection.Close()
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
