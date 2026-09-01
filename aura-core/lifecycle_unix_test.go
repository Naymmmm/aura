//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCoreLifecycleStopsChild(t *testing.T) {
	dir := t.TempDir()
	engine := filepath.Join(dir, "fake-engine")
	script := `#!/bin/sh
if [ "$1" = check ]; then exit 0; fi
trap 'exit 0' TERM INT
while :; do sleep 1; done
`
	if err := os.WriteFile(engine, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	c := &core{stateDir: dir, engine: engine}
	if err := c.start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	if !c.snapshot().Running {
		t.Fatal("child did not enter running state")
	}
	if err := c.stop(); err != nil {
		t.Fatalf("stop: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for c.snapshot().Running && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if c.snapshot().Running {
		t.Fatal("child remained running after stop")
	}
}
