//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"syscall"
)

const firewallSupported = true
const firewallRuleName = "HiTech Control Map"

func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd
}

func firewallAllowed() bool {
	for _, name := range []string{firewallRuleName, "HOTAS Viewer"} {
		if hidden(exec.Command("netsh", "advfirewall", "firewall", "show", "rule", "name="+name)).Run() == nil {
			return true
		}
	}
	return false
}

// Adding a firewall rule needs administrator rights, so Windows shows its
// permission prompt. The rule only opens this program's port.
func firewallAllow(port int) error {
	args := fmt.Sprintf(`advfirewall firewall add rule name="%s" dir=in action=allow protocol=TCP localport=%d profile=any`, firewallRuleName, port)
	ps := fmt.Sprintf(`Start-Process -FilePath netsh -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '%s'`, args)
	if err := hidden(exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", ps)).Run(); err != nil {
		return fmt.Errorf("Windows didn't add the rule (the permission prompt may have been declined)")
	}
	if !firewallAllowed() {
		return fmt.Errorf("Windows didn't add the rule (the permission prompt may have been declined)")
	}
	return nil
}
