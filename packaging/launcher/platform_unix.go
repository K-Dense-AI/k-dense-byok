//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func lockInstance(file string) (func(), error) {
	f, e := os.OpenFile(file, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, errors.New("Kady is already starting or running")
	}
	return func() { syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}
func containProcesses() (func(), error) { syscall.Umask(0077); return func() {}, nil }
func detach(c *exec.Cmd)                { c.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
func childProcess(c *exec.Cmd)          { c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func terminateSignal() os.Signal        { return syscall.SIGTERM }

// Pi background runners create their own process groups. Include observed
// descendants before terminating the parent; never kill unrelated port owners.
func treeCleanup(c *exec.Cmd) func() {
	if c.Process == nil {
		return func() {}
	}
	owned := map[int]bool{c.Process.Pid: true}
	data, _ := exec.Command("ps", "-ax", "-o", "pid=,ppid=").Output()
	rows := strings.Split(string(data), "\n")
	for changed := true; changed; {
		changed = false
		for _, row := range rows {
			fields := strings.Fields(row)
			if len(fields) != 2 {
				continue
			}
			pid, _ := strconv.Atoi(fields[0])
			ppid, _ := strconv.Atoi(fields[1])
			if pid > 1 && owned[ppid] && !owned[pid] {
				owned[pid] = true
				changed = true
			}
		}
	}
	return func() {
		_ = syscall.Kill(-c.Process.Pid, syscall.SIGTERM)
		for pid := range owned {
			_ = syscall.Kill(pid, syscall.SIGTERM)
		}
		time.Sleep(500 * time.Millisecond)
		_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
		for pid := range owned {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
}
func openWindowsURL(string) error { return errors.New("Windows only") }
func showError(message string) {
	// Startup failures must be visible even when Finder launched without a terminal.
	if _, e := os.Stat("/usr/bin/osascript"); e == nil {
		c := exec.Command("/usr/bin/osascript", "-e", "on run argv", "-e", "display alert \"Kady could not start\" message (item 1 of argv)", "-e", "end run", "--", message)
		_ = c.Run()
		return
	}
	_ = exec.Command("zenity", "--error", "--title=Kady could not start", "--text="+message).Run()
}
