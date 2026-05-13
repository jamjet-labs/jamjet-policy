// `jamjet sync install` — emits a platform-native service unit so the
// daemon survives reboots without the user managing a screen/tmux session.
//
// macOS:  ~/Library/LaunchAgents/dev.jamjet.sync.plist
// Linux:  ~/.config/systemd/user/jamjet-sync.service
// Windows: not supported — print a helpful error.
//
// We don't auto-load / enable — the user runs the explicit `launchctl load`
// or `systemctl --user enable --now` so they see and can audit the install.
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export interface InstallOptions {
  /** Don't write — just return the rendered content. Useful for tests + audits. */
  dryRun?: boolean
  /** Override the node binary path (defaults to process.execPath). */
  nodeBin?: string
  /** Override the CLI entry path (defaults to process.argv[1]). */
  cliEntry?: string
  /** Override stdout for tests. */
  stdout?: (s: string) => void
  /** Override home dir for tests. */
  homeDir?: string
  /** Override platform detection for tests. */
  forcePlatform?: 'darwin' | 'linux' | 'win32'
}

export interface InstallResult {
  path: string
  content: string
  enableCommand: string
}

export async function syncInstall(opts: InstallOptions = {}): Promise<InstallResult> {
  const home = opts.homeDir ?? homedir()
  const node = opts.nodeBin ?? process.execPath
  const entry = opts.cliEntry ?? process.argv[1]
  const plat = opts.forcePlatform ?? platform()
  const out = opts.stdout ?? ((s) => process.stdout.write(s))

  let result: InstallResult
  if (plat === 'darwin') {
    const plistPath = join(home, 'Library', 'LaunchAgents', 'dev.jamjet.sync.plist')
    result = {
      path: plistPath,
      content: plistTemplate(node, entry, join(home, '.jamjet', 'sync')),
      enableCommand: `launchctl load -w ${plistPath}`,
    }
  } else if (plat === 'linux') {
    const unitPath = join(home, '.config', 'systemd', 'user', 'jamjet-sync.service')
    result = {
      path: unitPath,
      content: systemdTemplate(node, entry),
      enableCommand: 'systemctl --user enable --now jamjet-sync',
    }
  } else {
    throw new Error(`sync install not supported on platform: ${plat}`)
  }

  if (!opts.dryRun) {
    mkdirSync(join(result.path, '..'), { recursive: true })
    writeFileSync(result.path, result.content)
    out(`Wrote ${result.path}\n`)
    out(`Enable: ${result.enableCommand}\n`)
  }
  return result
}

function plistTemplate(node: string, entry: string, logDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>dev.jamjet.sync</string>
    <key>ProgramArguments</key>
    <array>
      <string>${node}</string>
      <string>${entry}</string>
      <string>sync</string>
      <string>start</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${logDir}/daemon.log</string>
    <key>StandardErrorPath</key><string>${logDir}/daemon.log</string>
  </dict>
</plist>
`
}

function systemdTemplate(node: string, entry: string): string {
  return `[Unit]
Description=JamJet Cloud Sync daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${node} ${entry} sync start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
}
