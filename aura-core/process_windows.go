//go:build windows

package main

import "os/exec"

func configureChild(_ *exec.Cmd) {}

func terminateChild(cmd *exec.Cmd) error {
	return cmd.Process.Kill()
}
