//go:build windows

package main

import (
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

func lockInstance(file string) (func(), error) {
	f, e := os.OpenFile(file, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	var overlap windows.Overlapped
	if e = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlap); e != nil {
		f.Close()
		return nil, errAlreadyRunning
	}
	return func() { windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &overlap); f.Close() }, nil
}

// containProcesses puts the supervisor and everything it starts into a job
// that terminates its members when its last handle closes. The handle is
// deliberately never closed here: the supervisor is a member too, so closing
// it early would kill this process before it could log why it stopped. The
// OS closes it at exit, which is when remaining descendants must go.
func containProcesses() (func(), error) {
	job, e := windows.CreateJobObject(nil, nil)
	if e != nil {
		return nil, e
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, e = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); e != nil {
		windows.CloseHandle(job)
		return nil, e
	}
	if e = windows.AssignProcessToJobObject(job, windows.CurrentProcess()); e != nil {
		windows.CloseHandle(job)
		return nil, e
	}
	return func() {}, nil
}
func detach(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS, HideWindow: true}
}
func childProcess(c *exec.Cmd)   { c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
func terminateSignal() os.Signal { return os.Interrupt }

// redirectStd sends runtime panics and other direct writes to the log.
func redirectStd(f *os.File) {
	_ = windows.SetStdHandle(windows.STD_OUTPUT_HANDLE, windows.Handle(f.Fd()))
	_ = windows.SetStdHandle(windows.STD_ERROR_HANDLE, windows.Handle(f.Fd()))
	os.Stdout, os.Stderr = f, f
}

// The job object owns every descendant and ends them at exit. Terminate the
// service itself only while it is unreaped, through Go's process handle: a
// PID handed to taskkill may already belong to an unrelated program.
func treeCleanup(c *exec.Cmd, exited func() bool) func() {
	return func() {
		if c.Process != nil && !exited() {
			_ = c.Process.Kill()
		}
	}
}
func openWindowsURL(raw string) error {
	verb, _ := windows.UTF16PtrFromString("open")
	file, e := windows.UTF16PtrFromString(raw)
	if e != nil {
		return e
	}
	return windows.ShellExecute(0, verb, file, nil, nil, windows.SW_SHOWNORMAL)
}
func showError(message string) {
	title, _ := windows.UTF16PtrFromString("Kady could not start")
	text, _ := windows.UTF16PtrFromString(message)
	proc := windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW")
	proc.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
}
