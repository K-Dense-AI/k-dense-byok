// Kady's native entry point. It owns one per-user supervisor, never a system service.
package main

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var version = "dev"

type paths struct{ Data, Config, Cache, Resources string }
type instance struct {
	PID     int    `json:"pid"`
	Token   string `json:"token"`
	Control string `json:"control"`
	UI      string `json:"ui"`
	Version string `json:"version"`
}
type ports struct {
	API int `json:"api"`
	UI  int `json:"ui"`
}

var client = &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
func locations() (paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return paths{}, err
	}
	var p paths
	switch runtime.GOOS {
	case "darwin":
		p.Data = filepath.Join(home, "Library", "Application Support", "Kady")
		p.Config = p.Data
		p.Cache = filepath.Join(home, "Library", "Caches", "Kady")
	case "windows":
		p.Data = filepath.Join(envOr("LOCALAPPDATA", filepath.Join(home, "AppData", "Local")), "Kady")
		p.Config = p.Data
		p.Cache = filepath.Join(p.Data, "cache")
	default:
		p.Data = filepath.Join(envOr("XDG_DATA_HOME", filepath.Join(home, ".local", "share")), "kady")
		p.Config = filepath.Join(envOr("XDG_CONFIG_HOME", filepath.Join(home, ".config")), "kady")
		p.Cache = filepath.Join(envOr("XDG_CACHE_HOME", filepath.Join(home, ".cache")), "kady")
	}
	p.Data = envOr("KADY_DATA_DIR", p.Data)
	p.Config = envOr("KADY_CONFIG_DIR", p.Config)
	p.Cache = envOr("KADY_CACHE_DIR", p.Cache)
	for _, dir := range []*string{&p.Data, &p.Config, &p.Cache} {
		*dir, err = filepath.Abs(*dir)
		if err != nil {
			return p, err
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return p, err
	}
	if real, e := filepath.EvalSymlinks(exe); e == nil {
		exe = real
	}
	p.Resources = filepath.Join(filepath.Dir(exe), "resources")
	if runtime.GOOS == "darwin" {
		mac := filepath.Join(filepath.Dir(exe), "..", "Resources")
		if _, e := os.Stat(filepath.Join(mac, "distribution.json")); e == nil {
			p.Resources = mac
		}
	}
	for _, d := range []string{p.Data, p.Config, p.Cache, filepath.Join(p.Data, "logs")} {
		if err = os.MkdirAll(d, 0700); err != nil {
			return p, err
		}
	}
	return p, nil
}
func atomicFile(file string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(file), ".kady-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, file)
}
func readInstance(p paths) (instance, error) {
	var s instance
	b, e := os.ReadFile(filepath.Join(p.Data, "instance.json"))
	if e != nil {
		return s, e
	}
	e = json.Unmarshal(b, &s)
	return s, e
}
func control(s instance, method, endpoint string) (*http.Response, error) {
	u, e := url.Parse(s.Control)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || len(s.Token) < 32 {
		return nil, errors.New("invalid launcher state")
	}
	req, e := http.NewRequest(method, s.Control+endpoint, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("X-Kady-Token", s.Token)
	return client.Do(req)
}
func live(s instance) bool {
	r, e := control(s, "GET", "/status")
	if e != nil {
		return false
	}
	defer r.Body.Close()
	return r.StatusCode == 200
}
func browser(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return errors.New("invalid browser address")
	}
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("open", raw)
	case "windows":
		return openWindowsURL(raw)
	default:
		c = exec.Command("xdg-open", raw)
	}
	return c.Run()
}
func pickPort(preferred int) (int, error) {
	if preferred < 1 || preferred > 65535 {
		preferred = 0
	}
	l, e := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", preferred))
	if e != nil {
		l, e = net.Listen("tcp4", "127.0.0.1:0")
	}
	if e != nil {
		return 0, e
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}
func waitReady(s instance, timeout time.Duration) error {
	until := time.Now().Add(timeout)
	misses := 0
	for time.Now().Before(until) {
		r, e := control(s, "GET", "/status")
		if e == nil {
			misses = 0
			var v struct {
				Ready    bool   `json:"ready"`
				Stopping bool   `json:"stopping"`
				Error    string `json:"error"`
			}
			json.NewDecoder(r.Body).Decode(&v)
			r.Body.Close()
			if v.Error != "" {
				return errors.New(v.Error)
			}
			if v.Stopping {
				return errors.New("Kady is stopping. Reopen the application after shutdown completes")
			}
			if v.Ready {
				return nil
			}
		} else {
			misses++
			if misses >= 8 {
				return errors.New("Kady stopped during startup. Open the startup log for details")
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return errors.New("Kady did not become ready. Open the startup log for details")
}
func start(p paths, noBrowser bool) error {
	if s, e := readInstance(p); e == nil && live(s) {
		if e = waitReady(s, 90*time.Second); e != nil {
			return e
		}
		if !noBrowser {
			return browser(s.UI + "/#kady-token=" + s.Token)
		}
		return nil
	}
	exe, e := os.Executable()
	if e != nil {
		return e
	}
	c := exec.Command(exe, "serve")
	detach(c)
	log, e := os.OpenFile(filepath.Join(p.Data, "logs", "kady.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer log.Close()
	c.Stdout = log
	c.Stderr = log
	if e = c.Start(); e != nil {
		return e
	}
	exited := make(chan error, 1)
	go func() { exited <- c.Wait() }()
	until := time.Now().Add(90 * time.Second)
	for time.Now().Before(until) {
		if s, e := readInstance(p); e == nil && live(s) {
			if e = waitReady(s, 90*time.Second); e != nil {
				return e
			}
			if !noBrowser {
				return browser(s.UI + "/#kady-token=" + s.Token)
			}
			return nil
		}
		select {
		case <-exited:
			// A simultaneous launch may have won the per-user lock.
			if s, err := readInstance(p); err == nil && live(s) {
				continue
			}
			return errors.New("Kady could not start. See " + filepath.Join(p.Data, "logs", "kady.log"))
		case <-time.After(200 * time.Millisecond):
		}
	}
	return errors.New("Kady could not start. See " + filepath.Join(p.Data, "logs", "kady.log"))
}
func setEnv(base []string, values map[string]string) []string {
	result := []string{}
	for _, v := range base {
		k, _, _ := strings.Cut(v, "=")
		_, replaced := values[k]
		if runtime.GOOS == "windows" {
			for name := range values {
				if strings.EqualFold(name, k) {
					replaced = true
					break
				}
			}
		}
		if !replaced {
			result = append(result, v)
		}
	}
	for k, v := range values {
		result = append(result, k+"="+v)
	}
	return result
}
func serve(p paths) error {
	unlock, e := lockInstance(filepath.Join(p.Data, "instance.lock"))
	if e != nil {
		return e
	}
	defer unlock()
	closeJob, e := containProcesses()
	if e != nil {
		return e
	}
	defer closeJob()
	if _, e = os.Stat(filepath.Join(p.Resources, "distribution.json")); e != nil {
		return fmt.Errorf("application resources missing: %w", e)
	}
	secret := make([]byte, 32)
	if _, e = rand.Read(secret); e != nil {
		return e
	}
	previous := ports{API: 8000, UI: 3000}
	if data, e := os.ReadFile(filepath.Join(p.Config, "ports.json")); e == nil {
		_ = json.Unmarshal(data, &previous)
	}
	if v, e := strconv.Atoi(os.Getenv("KADY_PORT")); e == nil {
		previous.API = v
	}
	if v, e := strconv.Atoi(os.Getenv("KADY_FRONTEND_PORT")); e == nil {
		previous.UI = v
	}
	api, e := pickPort(previous.API)
	if e != nil {
		return e
	}
	ui, e := pickPort(previous.UI)
	if e != nil {
		return e
	}
	if ui == api {
		ui, e = pickPort(0)
		if e != nil {
			return e
		}
	}
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		return e
	}
	defer listener.Close()
	s := instance{PID: os.Getpid(), Token: hex.EncodeToString(secret), Control: "http://" + listener.Addr().String(), UI: fmt.Sprintf("http://localhost:%d", ui), Version: version}
	var ready atomic.Bool
	var stopping atomic.Bool
	stop := make(chan struct{})
	var once sync.Once
	requestStop := func() { once.Do(func() { close(stop) }) }
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		if r.Host != listener.Addr().String() || r.Header.Get("Origin") != "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Kady-Token")), []byte(s.Token)) != 1 {
			http.Error(w, "forbidden", 403)
			return
		}
		if r.URL.Path == "/status" && r.Method == "GET" {
			json.NewEncoder(w).Encode(map[string]any{"ready": ready.Load() && !stopping.Load(), "stopping": stopping.Load(), "version": version})
			return
		}
		if r.URL.Path == "/stop" && r.Method == "POST" {
			w.Write([]byte("{\"stopping\":true}"))
			time.AfterFunc(time.Second, requestStop)
			return
		}
		if r.URL.Path == "/import" && r.Method == "POST" {
			var input struct {
				Source string `json:"source"`
			}
			if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&input) != nil || !filepath.IsAbs(input.Source) {
				http.Error(w, "Enter the full path to the existing Kady installation.", 400)
				return
			}
			if err := selectCheckout(p, input.Source); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			w.Write([]byte("{\"stopping\":true}"))
			time.AfterFunc(time.Second, requestStop)
			return
		}
		http.NotFound(w, r)
	})
	controlServer := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go controlServer.Serve(listener)
	defer controlServer.Close()
	data, _ := json.Marshal(s)
	if e = atomicFile(filepath.Join(p.Data, "instance.json"), data); e != nil {
		return e
	}
	defer os.Remove(filepath.Join(p.Data, "instance.json"))
	nodeDir := filepath.Join(p.Resources, "node", "bin")
	node := filepath.Join(nodeDir, "node")
	if runtime.GOOS == "windows" {
		nodeDir = filepath.Join(p.Resources, "node")
		node = filepath.Join(nodeDir, "node.exe")
	}
	gitDir := filepath.Join(p.Resources, "git", "bin")
	gitExec := filepath.Join(p.Resources, "git", "libexec", "git-core")
	pathEntries := []string{nodeDir, filepath.Join(p.Resources, "uv"), filepath.Join(p.Resources, "rg"), filepath.Join(p.Resources, "fd"), gitDir}
	if runtime.GOOS == "windows" {
		pathEntries = append(pathEntries, filepath.Join(p.Resources, "git", "cmd"), filepath.Join(p.Resources, "git", "usr", "bin"))
		gitExec = filepath.Join(p.Resources, "git", "mingw64", "libexec", "git-core")
	}
	pathEntries = append(pathEntries, os.Getenv("PATH"))
	// Finder does not read shell startup files. Include standard optional-tool
	// locations so Homebrew tools and MacTeX work from an application launch.
	if runtime.GOOS == "darwin" {
		pathEntries = append(pathEntries, "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin", "/Library/TeX/texbin")
	}
	if runtime.GOOS != "windows" {
		if home, err := os.UserHomeDir(); err == nil {
			pathEntries = append(pathEntries, filepath.Join(home, ".local", "bin"))
		}
	}
	guardPath := filepath.ToSlash(filepath.Join(p.Resources, "guard.mjs"))
	if runtime.GOOS == "windows" {
		guardPath = "/" + guardPath
	}
	guardian := (&url.URL{Scheme: "file", Path: guardPath}).String()
	values := map[string]string{"KADY_PACKAGED": "1", "KADY_PROJECTS_ROOT": projectsRoot(p), "KADY_DATA_DIR": p.Data, "KADY_CONFIG_DIR": p.Config, "KADY_CACHE_DIR": p.Cache, "KADY_LAUNCHER": "1", "KADY_HOST": "127.0.0.1", "HOSTNAME": "127.0.0.1", "KADY_PORT": strconv.Itoa(api), "KADY_FRONTEND_PORT": strconv.Itoa(ui), "PORT": strconv.Itoa(ui), "KADY_API_URL": fmt.Sprintf("http://localhost:%d", api), "KADY_CONTROL_URL": s.Control, "KADY_AUTH_TOKEN": s.Token, "KADY_REQUIRE_AUTH": "1", "PATH": strings.Join(pathEntries, string(os.PathListSeparator)), "NODE_OPTIONS": "--import=" + guardian, "NODE_PATH": "", "NODE_ENV": "production", "GIT_EXEC_PATH": gitExec, "UV_CACHE_DIR": filepath.Join(p.Cache, "uv"), "UV_PYTHON_INSTALL_DIR": filepath.Join(p.Data, "python"), "UV_PYTHON_PREFERENCE": "only-managed", "KADY_OFFICE_CACHE_DIR": filepath.Join(p.Cache, "office-assets"), "NO_PROXY": envOr("NO_PROXY", "") + ",localhost,127.0.0.1,::1"}
	if runtime.GOOS == "windows" {
		values["PI_BASH_PATH"] = filepath.Join(p.Resources, "git", "bin", "bash.exe")
	}
	env := setEnv(os.Environ(), values)
	children := []*exec.Cmd{}
	exits := make(chan error, 2)
	var waits sync.WaitGroup
	defer func() {
		// The preload asks both services and detached Pi workers to shut down
		// cooperatively, including on Windows where SIGTERM is not available.
		stopping.Store(true)
		cleanups := []func(){}
		for _, c := range children {
			cleanups = append(cleanups, treeCleanup(c))
		}
		done := make(chan struct{})
		go func() { waits.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(12 * time.Second):
		}
		for _, cleanup := range cleanups {
			cleanup()
		}
	}()
	for _, role := range []string{"backend", "frontend"} {
		c := exec.Command(node, filepath.Join(p.Resources, "bootstrap.mjs"), role)
		c.Env = env
		c.Dir = p.Data
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		childProcess(c)
		if e = c.Start(); e != nil {
			return fmt.Errorf("start %s: %w", role, e)
		}
		children = append(children, c)
		waits.Add(1)
		go func() { defer waits.Done(); exits <- c.Wait() }()
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, terminateSignal())
	defer signal.Stop(sig)
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	deadline := time.NewTimer(90 * time.Second)
	defer deadline.Stop()
	for !ready.Load() {
		select {
		case <-stop:
			return nil
		case <-sig:
			return nil
		case e := <-exits:
			return fmt.Errorf("application service exited during startup: %v", e)
		case <-deadline.C:
			return errors.New("application startup timed out")
		case <-tick.C:
			if probe(fmt.Sprintf("http://127.0.0.1:%d/health", api), "") && probe(fmt.Sprintf("http://127.0.0.1:%d/runtime-config.js", ui), fmt.Sprintf("localhost:%d", api)) {
				ready.Store(true)
				b, _ := json.Marshal(ports{API: api, UI: ui})
				_ = atomicFile(filepath.Join(p.Config, "ports.json"), b)
				fmt.Println("Kady", version, "ready at", s.UI)
			}
		}
	}
	select {
	case <-stop:
		return nil
	case <-sig:
		return nil
	case e := <-exits:
		return fmt.Errorf("application service exited: %v", e)
	}
}
func probe(address, contains string) bool {
	r, e := client.Get(address)
	if e != nil {
		return false
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return false
	}
	if contains == "" {
		return true
	}
	b, _ := io.ReadAll(io.LimitReader(r.Body, 8192))
	return bytes.Contains(b, []byte(contains))
}
func main() {
	p, e := locations()
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
	command := "start"
	noBrowser := false
	for _, arg := range os.Args[1:] {
		if arg == "--no-browser" {
			noBrowser = true
		} else {
			command = arg
			break
		}
	}
	for _, arg := range os.Args[1:] {
		if arg == "--no-browser" {
			noBrowser = true
		}
	}
	switch command {
	case "serve":
		e = serve(p)
	case "start", "open":
		e = start(p, noBrowser)
	case "status":
		var s instance
		s, e = readInstance(p)
		if e == nil && live(s) {
			fmt.Println("Kady", s.Version, s.UI)
		} else {
			e = errors.New("Kady is not running")
		}
	case "stop":
		var s instance
		s, e = readInstance(p)
		if e == nil {
			var r *http.Response
			r, e = control(s, "POST", "/stop")
			if e == nil {
				r.Body.Close()
				if r.StatusCode != 200 {
					e = errors.New("stop refused")
				}
			}
		}
		if os.IsNotExist(e) {
			e = nil
		}
	case "logs":
		var b []byte
		b, e = os.ReadFile(filepath.Join(p.Data, "logs", "kady.log"))
		if e == nil {
			os.Stdout.Write(b)
		}
	case "version", "--version":
		fmt.Println(version)
	case "import":
		if len(os.Args) < 3 {
			e = errors.New("usage: kady import /path/to/checkout")
		} else {
			e = importCheckout(p, os.Args[2])
		}
	default:
		e = errors.New("usage: kady [start|stop|status|logs|version|import PATH] [--no-browser]")
	}
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		if command == "start" && !noBrowser {
			showError(e.Error() + "\n\nLog: " + filepath.Join(p.Data, "logs", "kady.log"))
		}
		os.Exit(1)
	}
}
