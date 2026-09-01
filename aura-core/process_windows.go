//go:build windows

package main

import (
	"fmt"
	"os/exec"
)

func configureChild(_ *exec.Cmd) {}

func terminateChild(cmd *exec.Cmd) error {
	// NaiveProxy is Chromium-based and may own subprocesses. Killing only the
	// parent can strand transport processes after disconnect or app exit.
	return exec.Command(
		"taskkill.exe",
		"/PID", fmt.Sprint(cmd.Process.Pid),
		"/T", "/F",
	).Run()
}
