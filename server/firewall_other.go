//go:build !windows

package main

import "fmt"

const firewallSupported = false

func firewallAllowed() bool { return true }

func firewallAllow(port int) error {
	return fmt.Errorf("only available on Windows")
}
