//go:build windows

package main

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"strconv"
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
		return nil, errors.New("Kady is already starting or running")
	}
	return func() { windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &overlap); f.Close() }, nil
}
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
	return func() { windows.CloseHandle(job) }, nil
}
func detach(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS, HideWindow: true}
}
func childProcess(c *exec.Cmd)   { c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
func terminateSignal() os.Signal { return os.Interrupt }
func treeCleanup(c *exec.Cmd) func() {
	return func() {
		if c.Process != nil {
			cmd := exec.Command("taskkill", "/PID", strconv.Itoa(c.Process.Pid), "/T", "/F")
			childProcess(cmd)
			_ = cmd.Run()
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
