//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func lockInstance(file string) (func(), error) {
	f, e := os.OpenFile(file, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, errAlreadyRunning
	}
	return func() { syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}
func containProcesses() (func(), error) { syscall.Umask(0077); return func() {}, nil }
func detach(c *exec.Cmd)                { c.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
func childProcess(c *exec.Cmd)          { c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func terminateSignal() os.Signal        { return syscall.SIGTERM }

// redirectStd sends runtime panics and other direct writes to the log.
func redirectStd(f *os.File) {
	_ = unix.Dup2(int(f.Fd()), 1)
	_ = unix.Dup2(int(f.Fd()), 2)
}

func processTable() map[int]processInfo {
	out, _ := exec.Command("ps", "-A", "-o", "pid=,ppid=,lstart=").Output()
	return parseProcessTable(string(out))
}

// Pi background runners create their own process groups and outlive their
// parent, so record the service's tree while it is alive. Signal a PID later
// only if it is still that recorded process (or descends from one), and the
// group only while its leader is unreaped and so still owns the group ID.
func treeCleanup(c *exec.Cmd, exited func() bool) func() {
	if c.Process == nil {
		return func() {}
	}
	leader := c.Process.Pid
	before := processTable()
	recorded := map[int]string{}
	for pid := range descendantsOf(before, map[int]bool{leader: true}) {
		recorded[pid] = before[pid].start
	}
	signal := func(sig syscall.Signal) {
		if !exited() && c.Process.Signal(sig) == nil {
			_ = syscall.Kill(-leader, sig)
		}
		now := processTable()
		for pid := range descendantsOf(now, stillRunning(now, recorded)) {
			if pid != leader {
				_ = syscall.Kill(pid, sig)
			}
		}
	}
	return func() {
		signal(syscall.SIGTERM)
		time.Sleep(500 * time.Millisecond)
		signal(syscall.SIGKILL)
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
