package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

// Browsers may send `localhost` to ::1 before 127.0.0.1. The services bind
// IPv4 loopback, so a port is usable only when ::1 is free as well; the
// returned ::1 listener stays open as a forwarder to the IPv4 service, so no
// other program can answer for Kady on that side for as long as it runs.
var ipv6Loopback = sync.OnceValue(func() bool {
	l, e := net.Listen("tcp6", "[::1]:0")
	if e != nil {
		return false
	}
	l.Close()
	return true
})

func tryPort(port int) (int, net.Listener, bool) {
	l4, e := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
	if e != nil {
		return 0, nil, false
	}
	port = l4.Addr().(*net.TCPAddr).Port
	defer l4.Close()
	if !ipv6Loopback() {
		return port, nil, true
	}
	l6, e := net.Listen("tcp6", fmt.Sprintf("[::1]:%d", port))
	if e != nil {
		return 0, nil, false
	}
	return port, l6, true
}

// reservePort prefers the given port and otherwise picks a free one. It never
// disturbs whatever already listens on an occupied port.
func reservePort(preferred int) (int, net.Listener, error) {
	if preferred >= 1 && preferred <= 65535 {
		if port, l6, ok := tryPort(preferred); ok {
			return port, l6, nil
		}
	}
	for range 20 {
		if port, l6, ok := tryPort(0); ok {
			return port, l6, nil
		}
	}
	return 0, nil, errors.New("no free local port")
}

// forward relays each connection accepted on l to the IPv4 service.
func forward(l net.Listener, target string) {
	for {
		c, e := l.Accept()
		if e != nil {
			return
		}
		go func() {
			defer c.Close()
			u, e := net.DialTimeout("tcp4", target, 5*time.Second)
			if e != nil {
				return
			}
			defer u.Close()
			done := make(chan struct{}, 2)
			relay := func(dst, src net.Conn) {
				_, _ = io.Copy(dst, src)
				if tcp, ok := dst.(*net.TCPConn); ok {
					_ = tcp.CloseWrite()
				}
				done <- struct{}{}
			}
			go relay(u, c)
			go relay(c, u)
			<-done
			<-done
		}()
	}
}
