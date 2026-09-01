//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestManagedProcessStopKillsProcessGroup(t *testing.T) {
	dir := t.TempDir()
	childFile := dir + "/child.pid"
	cmd := exec.Command("/bin/sh", "-c", "sleep 30 & echo $! > \"$1\"; wait", "sh", childFile)
	configureChild(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	process := &managedProcess{cmd: cmd, done: make(chan struct{})}
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		err := cmd.Wait()
		process.mu.Lock()
		process.err = err
		process.mu.Unlock()
		close(process.done)
	}()

	var childPID int
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(childFile)
		if err == nil {
			childPID, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
			if childPID > 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if childPID == 0 {
		t.Fatal("child process did not start")
	}
	if err := process.Stop(); err != nil {
		t.Fatalf("stop: %v", err)
	}
	wait.Wait()
	if err := syscall.Kill(childPID, 0); err == nil || !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("child process %d survived process-group shutdown: %v", childPID, err)
	}
}
