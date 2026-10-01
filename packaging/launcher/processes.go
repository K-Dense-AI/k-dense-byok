package main

import (
	"strconv"
	"strings"
)

// A PID alone does not identify a process for long: once a service exits and
// is reaped, the number can be handed to an unrelated program. A PID plus its
// start time does, so cleanup only signals processes whose recorded start
// time still matches, or that descend from one that does.
type processInfo struct {
	ppid  int
	start string
}

// parseProcessTable reads `ps -A -o pid=,ppid=,lstart=` output.
func parseProcessTable(out string) map[int]processInfo {
	table := map[int]processInfo{}
	for _, row := range strings.Split(out, "\n") {
		fields := strings.Fields(row)
		if len(fields) < 3 {
			continue
		}
		pid, e1 := strconv.Atoi(fields[0])
		ppid, e2 := strconv.Atoi(fields[1])
		if e1 != nil || e2 != nil || pid <= 1 {
			continue
		}
		table[pid] = processInfo{ppid: ppid, start: strings.Join(fields[2:], " ")}
	}
	return table
}

// descendantsOf returns the roots present in table plus everything below them.
func descendantsOf(table map[int]processInfo, roots map[int]bool) map[int]bool {
	owned := map[int]bool{}
	for pid := range roots {
		if _, ok := table[pid]; ok {
			owned[pid] = true
		}
	}
	for changed := true; changed; {
		changed = false
		for pid, p := range table {
			if owned[p.ppid] && !owned[pid] {
				owned[pid] = true
				changed = true
			}
		}
	}
	return owned
}

// stillRunning returns the recorded processes that have not been replaced.
func stillRunning(table map[int]processInfo, recorded map[int]string) map[int]bool {
	alive := map[int]bool{}
	for pid, start := range recorded {
		if p, ok := table[pid]; ok && p.start == start {
			alive[pid] = true
		}
	}
	return alive
}
