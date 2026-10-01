package main

import (
	"io"
	"os"
	"sync"
)

const maxLogBytes = 10 << 20

// rotatingLog is the supervisor's only handle on kady.log. Services write
// through pipes, so the file can be replaced while they run: past the limit
// it becomes kady.log.1 and a fresh kady.log starts.
type rotatingLog struct {
	mu       sync.Mutex
	path     string
	file     *os.File
	size     int64
	limit    int64
	redirect bool // also point this process's stdout/stderr at the file
}

func openLog(path string, limit int64, redirect bool) (*rotatingLog, error) {
	l := &rotatingLog{path: path, limit: limit, redirect: redirect}
	if e := l.open(); e != nil {
		return nil, e
	}
	if l.size >= l.limit {
		l.rotate() // a previous run's log
	}
	return l, nil
}

func (l *rotatingLog) open() error {
	f, e := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if e != nil {
		return e
	}
	info, e := f.Stat()
	if e != nil {
		f.Close()
		return e
	}
	l.file, l.size = f, info.Size()
	if l.redirect {
		redirectStd(f)
	}
	return nil
}

func (l *rotatingLog) Write(b []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.size > 0 && l.size+int64(len(b)) > l.limit {
		l.rotate()
	}
	n, e := l.file.Write(b)
	l.size += int64(n)
	return n, e
}

func (l *rotatingLog) rotate() {
	limit := l.limit
	l.file.Close() // Windows cannot rename an open file.
	if os.Rename(l.path, l.path+".1") != nil {
		// Another program holds it open (Windows): start over in place.
		_ = os.Truncate(l.path, 0)
	}
	if l.open() != nil {
		l.file, _ = os.OpenFile(os.DevNull, os.O_WRONLY, 0)
		l.size = 0
	}
	if l.size >= limit {
		// Neither worked; append rather than retrying on every write.
		l.limit = l.size + limit
	}
}

// tailFile returns at most limit bytes from the end of a file.
func tailFile(path string, limit int64) ([]byte, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil {
		return nil, e
	}
	offset := max(0, info.Size()-limit)
	b := make([]byte, info.Size()-offset)
	n, e := f.ReadAt(b, offset)
	if e == io.EOF {
		e = nil
	}
	return b[:n], e
}
