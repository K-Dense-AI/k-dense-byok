//go:build !windows

package main

import (
	"bufio"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestCleanupReachesOrphanedDescendantsAfterServiceExit(t *testing.T) {
	c := exec.Command("/bin/sh", "-c", "sleep 60 & echo $!; wait")
	childProcess(c)
	out, e := c.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	if e = c.Start(); e != nil {
		t.Fatal(e)
	}
	line, e := bufio.NewReader(out).ReadString('\n')
	if e != nil {
		t.Fatal(e)
	}
	runner, _ := strconv.Atoi(strings.TrimSpace(line))
	defer syscall.Kill(runner, syscall.SIGKILL)
	cleanup := treeCleanup(c, func() bool { return true })
	// The service dies first and is reaped; its child is orphaned.
	c.Process.Kill()
	c.Wait()
	cleanup()
	for range 50 {
		if syscall.Kill(runner, 0) != nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("recorded descendant survived cleanup")
}
