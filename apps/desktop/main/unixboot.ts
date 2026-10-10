import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { run, type Runner } from './runasadmin'

/** The background engine on macOS and Linux (docket
 *  mac-and-linux-background-engine-that-starts-auto): what the "Orgtree
 *  Background Engine" scheduled task is on Windows. The same supervisor,
 *  `orgtree-engine host`, starts at login under the platform's per-user
 *  service manager, publishes engine-attach.json, and the desktop adopts it
 *  instead of starting an engine of its own, so closing Orgtree leaves the
 *  agents running.
 *
 *  - macOS: a launchd LaunchAgent, ~/Library/LaunchAgents/<appId>.engine.plist,
 *    loaded with `launchctl bootstrap gui/<uid>`.
 *  - Linux: a systemd user unit, ~/.config/systemd/user/orgtree-engine.service,
 *    `systemctl --user enable`; where `systemctl --user` does not answer, an
 *    XDG autostart entry, ~/.config/autostart/orgtree-engine.desktop.
 *
 *  The installed app re-registers at every launch, so a moved .app or
 *  AppImage, or a new data folder, is picked up; an unchanged registration is
 *  left alone. Restart on failure mirrors the task's (one minute apart, three
 *  times): launchd only throttles, it cannot count. A removed installation
 *  makes the entry a no-op (the command is checked before it runs). */

export const LAUNCH_AGENT_SUFFIX = '.engine'
export const SYSTEMD_UNIT = 'orgtree-engine.service'
export const AUTOSTART_ENTRY = 'orgtree-engine.desktop'

/** The host under `ELECTRON_RUN_AS_NODE`, for the AppImage: its files live in
 *  a mount that exists only while the AppImage runs, so the registration
 *  names the AppImage itself and this keeps the mount up while the host runs.
 *  No `$`, `%` or backquote: it survives every quoting below unchanged. */
export const APPIMAGE_HOST_JS = "const p=require('path'),c=require('child_process');" +
  "const h=c.spawn(p.join(p.dirname(process.execPath),'resources','engine','orgtree-engine'),['host'],{stdio:'inherit'});" +
  "for(const s of ['SIGTERM','SIGINT','SIGHUP'])process.on(s,()=>h.kill(s));" +
  "h.on('exit',(code)=>process.exit(code===null?1:code))"

export interface BootCommand {
  /** what must exist for the entry to do anything */
  program: string
  args: string[]
  env: Record<string, string>
}

export interface BootInputs {
  platform: NodeJS.Platform
  home: string
  appId: string
  /** the packaged engine binary (inside the .app, /opt/Orgtree, or the AppImage mount) */
  engine: string
  /** $APPIMAGE when running from an AppImage */
  appImage?: string
  dataRoot: string
  /** the user's login shell's PATH (loginShellPath), ahead of the fixed list */
  shellPath?: string
}

/** Where the provider CLIs live: the login shell's PATH (nvm, volta, an npm
 *  prefix, bun, Linuxbrew), then where they usually are, instead of a service
 *  manager's minimal PATH. Never the desktop's own PATH: that differs between
 *  a terminal and a Dock or menu launch, and a registration that changed with
 *  it would restart the running engine on every such launch. */
export function bootPath(home: string, platform: NodeJS.Platform, shellPath = ''): string {
  const fixed = [path.posix.join(home, '.local', 'bin'), ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : []),
    '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  const seen = new Set<string>()
  return [...shellPath.split(':'), ...fixed].filter(d => path.posix.isAbsolute(d) && !seen.has(d) && !!seen.add(d)).join(':')
}

const PATH_MARK = '__ORGTREE_LOGIN_PATH__'

/** The PATH between the markers, ignoring whatever the profile printed around it. */
export function parseShellPath(stdout: string): string {
  const m = new RegExp(PATH_MARK + '(.*?)' + PATH_MARK).exec(stdout)
  return m ? m[1].trim() : ''
}

/** What the user's login shell sets PATH to, read with a CLEAN environment
 *  (HOME, USER, SHELL and a minimal PATH), so the answer depends on their
 *  profile files only, not on how Orgtree was opened. An interactive login
 *  shell (zsh: .zprofile and .zshrc; bash: .bash_profile or .profile) and an
 *  interactive one (bash: .bashrc, where nvm and friends usually live, which a
 *  login bash reads only if its profile sources it), merged in that order;
 *  each bounded by `timeoutMs`. '' when neither answers. */
export async function loginShellPath(shell = process.env.SHELL || '/bin/sh', home = process.env.HOME || '', timeoutMs = 4000): Promise<string> {
  const env = { HOME: home, USER: process.env.USER ?? '', LOGNAME: process.env.LOGNAME ?? process.env.USER ?? '', SHELL: shell,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'dumb' }
  const script = `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`
  const read = (flags: string) => new Promise<string>(resolve => {
    const child = execFile(shell, [flags, script], { env, cwd: home || undefined, timeout: timeoutMs, killSignal: 'SIGKILL' },
      (_error, stdout) => resolve(parseShellPath(String(stdout ?? ''))))
    child.on('error', () => resolve(''))
    child.stdin?.end()
  })
  const [login, interactive] = await Promise.all([read('-ilc'), read('-ic')])
  const seen = new Set<string>()
  return [...login.split(':'), ...interactive.split(':')].filter(d => d && !seen.has(d) && !!seen.add(d)).join(':')
}

export function bootCommand(o: BootInputs): BootCommand {
  const env = { ORGTREE_V2_DATA: o.dataRoot, PATH: bootPath(o.home, o.platform, o.shellPath) }
  if (o.appImage) return { program: o.appImage, args: ['-e', APPIMAGE_HOST_JS], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  return { program: o.engine, args: ['host'], env }
}

export const launchAgentLabel = (appId: string) => appId + LAUNCH_AGENT_SUFFIX

export function bootFile(o: Pick<BootInputs, 'platform' | 'home' | 'appId'>, kind: 'launchd' | 'systemd' | 'autostart'): string {
  if (kind === 'launchd') return path.posix.join(o.home, 'Library', 'LaunchAgents', launchAgentLabel(o.appId) + '.plist')
  if (kind === 'systemd') return path.posix.join(o.home, '.config', 'systemd', 'user', SYSTEMD_UNIT)
  return path.posix.join(o.home, '.config', 'autostart', AUTOSTART_ENTRY)
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** RunAtLoad at login; restarted (no sooner than a minute) only after a
 *  failure, as the task's RestartOnFailure. A missing program exits 0, which
 *  launchd leaves alone. */
export function launchAgentPlist(o: BootInputs): string {
  const c = bootCommand(o)
  const args = ['/bin/sh', '-c', 'test -x "$0" || exit 0; exec "$0" "$@"', c.program, ...c.args]
  const s = (v: string) => `<string>${xml(v)}</string>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${s(launchAgentLabel(o.appId))}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map(a => '    ' + s(a)),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(c.env).map(([k, v]) => `    <key>${xml(k)}</key>${s(v)}`),
    '  </dict>',
    `  <key>WorkingDirectory</key>${s(o.home)}`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key>',
    '  <dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ThrottleInterval</key><integer>60</integer>',
    '  <key>ProcessType</key><string>Standard</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/** systemd's quoting: double quotes, backslash escapes, `%` and `$` doubled. */
export function systemdQuote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$') + '"'
}

export function systemdUnit(o: BootInputs): string {
  const c = bootCommand(o)
  return [
    '[Unit]',
    'Description=Orgtree Background Engine',
    `ConditionPathExists=${c.program.replace(/%/g, '%%')}`,
    'StartLimitIntervalSec=600',
    'StartLimitBurst=4',
    '',
    '[Service]',
    'Type=simple',
    // The engine creates its data folders and descriptor; the user manager's own
    // umask can be 0002 (pam_umask with a private group), and the desktop
    // refuses a descriptor in a folder others can write.
    'UMask=0077',
    ...Object.entries(c.env).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`),
    `WorkingDirectory=${o.home.replace(/%/g, '%%')}`,
    `ExecStart=${[c.program, ...c.args].map(systemdQuote).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=60',
    // SIGTERM to the host (it stops the engine cleanly), then the rest
    'KillMode=mixed',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/** The desktop entry spec's Exec quoting. */
export function desktopExecQuote(s: string): string {
  const quoted = /[\s"'\\><~|&;$*?#()`]/.test(s) ? '"' + s.replace(/([\\"`$])/g, '\\$1') + '"' : s
  return quoted.replace(/%/g, '%%')
}

export function autostartEntry(o: BootInputs): string {
  const c = bootCommand(o)
  const exec = ['env', ...Object.entries(c.env).map(([k, v]) => `${k}=${v}`), c.program, ...c.args].map(desktopExecQuote).join(' ')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Orgtree Background Engine',
    'Comment=Keeps your Orgtree agents working without the window open',
    `TryExec=${c.program}`,
    `Exec=${exec}`,
    'Terminal=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

// ------------------------------------------------------------ private data

export interface FolderIo {
  mkdir(dir: string): void
  stat(dir: string): { uid: number; mode: number }
  chmod(dir: string, mode: number): void
  uid(): number
}

const realFolderIo: FolderIo = {
  mkdir: dir => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) },
  stat: dir => fs.statSync(dir),
  chmod: (dir, mode) => fs.chmodSync(dir, mode),
  uid: () => process.getuid?.() ?? -1,
}

/** Make the engine's data folder private before the background engine starts.
 *
 *  The desktop only attaches to a descriptor in a folder nobody else can write
 *  (policy.ts judgePosixTrust), and checks every folder above it as well. A
 *  session umask of 0002, the default for a user-private group on Ubuntu,
 *  creates these folders 0775, and the attach is then refused. So the data
 *  folder is created 0700, and it and its parents up to and including
 *  `appRoot` (Orgtree's own folder) are TIGHTENED to 0700 when they belong
 *  to this user and others could reach them: an install made by 4.1.0 or
 *  4.1.1 under such a umask is repaired, not refused. Folders above `appRoot`
 *  are not Orgtree's and are never changed. Returns the folders it tightened;
 *  never throws (the attach check still has the last word). */
export function privateDataFolders(dataRoot: string, appRoot: string, io: FolderIo = realFolderIo): { tightened: string[]; error?: string } {
  const tightened: string[] = []
  try {
    io.mkdir(dataRoot)
    const dirs = [dataRoot]
    const relative = path.relative(appRoot, dataRoot)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      for (let d = path.dirname(dataRoot); ; d = path.dirname(d)) {
        dirs.push(d)
        if (d === appRoot || path.dirname(d) === d) break
      }
    }
    const uid = io.uid()
    for (const dir of dirs) {
      const s = io.stat(dir)
      if (s.uid !== uid || (s.mode & 0o077) === 0) continue
      io.chmod(dir, 0o700)
      tightened.push(dir)
    }
    return { tightened }
  } catch (e) { return { tightened, error: (e as Error).message } }
}

// ------------------------------------------------------------ registering

export interface BootIo {
  runner: Runner
  read(file: string): string | null
  write(file: string, text: string): void
  remove(file: string): void
  uid(): number
  /** start the host now, outside any service manager (the autostart fallback) */
  detach(c: BootCommand): void
}

export const realIo: BootIo = {
  runner: run,
  read: file => { try { return fs.readFileSync(file, 'utf8') } catch { return null } },
  write: (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file + '.tmp', text, { mode: 0o644 })
    fs.renameSync(file + '.tmp', file)
  },
  remove: file => { fs.rmSync(file, { force: true }) },
  uid: () => process.getuid?.() ?? -1,
  detach: c => {
    const child = spawn(c.program, c.args, { detached: true, stdio: 'ignore', env: { ...process.env, ...c.env } })
    child.on('error', () => { /* the desktop starts its own engine instead */ })
    child.unref()
  },
}

export interface BootOutcome {
  /** launchd | systemd | autostart */
  manager: 'launchd' | 'systemd' | 'autostart'
  file: string
  changed: boolean
  /** the host was asked to start now */
  started: boolean
  error?: string
}

const failed = (r: { code: number; stdout: string; stderr: string }) => (r.stderr || r.stdout).trim() || `exit code ${r.code}`

/** Write (if different) and load the registration, then start the host now
 *  if it is not running. Never throws: a failure leaves the desktop to start
 *  its own engine, as on Windows without the task. */
export async function ensureBootEngine(o: BootInputs, io: BootIo = realIo): Promise<BootOutcome> {
  if (o.platform === 'darwin') {
    const file = bootFile(o, 'launchd')
    const label = launchAgentLabel(o.appId)
    const domain = `gui/${io.uid()}`
    const text = launchAgentPlist(o)
    const changed = io.read(file) !== text
    try {
      if (changed) {
        // a changed agent must be unloaded first, or launchd keeps the old one
        await io.runner('launchctl', ['bootout', `${domain}/${label}`], 15000)
        io.write(file, text)
      }
      const loaded = (await io.runner('launchctl', ['print', `${domain}/${label}`], 15000)).code === 0
      if (!loaded) {
        const r = await io.runner('launchctl', ['bootstrap', domain, file], 15000)
        if (r.code !== 0) return { manager: 'launchd', file, changed, started: false, error: `launchctl bootstrap: ${failed(r)}` }
      }
      // RunAtLoad started it on bootstrap; kickstart (without -k) is a no-op if it runs
      const k = await io.runner('launchctl', ['kickstart', `${domain}/${label}`], 15000)
      return { manager: 'launchd', file, changed, started: k.code === 0, ...(k.code === 0 ? {} : { error: `launchctl kickstart: ${failed(k)}` }) }
    } catch (e) { return { manager: 'launchd', file, changed, started: false, error: (e as Error).message } }
  }
  const systemd = (await io.runner('systemctl', ['--user', 'show-environment'], 10000).catch(() => ({ code: -1, stdout: '', stderr: '' }))).code === 0
  if (systemd) {
    const file = bootFile(o, 'systemd')
    const text = systemdUnit(o)
    const changed = io.read(file) !== text
    try {
      if (changed) {
        io.write(file, text)
        await io.runner('systemctl', ['--user', 'daemon-reload'], 30000)
      }
      const e = await io.runner('systemctl', ['--user', 'enable', SYSTEMD_UNIT], 30000)
      if (e.code !== 0) return { manager: 'systemd', file, changed, started: false, error: `systemctl enable: ${failed(e)}` }
      // a changed unit restarts onto the new command; an unchanged one only starts if stopped
      const s = await io.runner('systemctl', ['--user', changed ? 'restart' : 'start', SYSTEMD_UNIT], 30000)
      io.remove(bootFile(o, 'autostart'))
      return { manager: 'systemd', file, changed, started: s.code === 0, ...(s.code === 0 ? {} : { error: `systemctl start: ${failed(s)}` }) }
    } catch (err) { return { manager: 'systemd', file, changed, started: false, error: (err as Error).message } }
  }
  const file = bootFile(o, 'autostart')
  const text = autostartEntry(o)
  const changed = io.read(file) !== text
  try {
    if (changed) io.write(file, text)
    // autostart applies from the next login: start this session's host now
    io.detach(bootCommand(o))
    return { manager: 'autostart', file, changed, started: true }
  } catch (e) { return { manager: 'autostart', file, changed, started: false, error: (e as Error).message } }
}

/** Remove every registration this module may have made. */
export async function removeBootEngine(o: Pick<BootInputs, 'platform' | 'home' | 'appId'>, io: BootIo = realIo): Promise<void> {
  if (o.platform === 'darwin') {
    await io.runner('launchctl', ['bootout', `gui/${io.uid()}/${launchAgentLabel(o.appId)}`], 15000).catch(() => undefined)
    io.remove(bootFile(o, 'launchd'))
    return
  }
  await io.runner('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], 30000).catch(() => undefined)
  io.remove(bootFile(o, 'systemd'))
  await io.runner('systemctl', ['--user', 'daemon-reload'], 30000).catch(() => undefined)
  io.remove(bootFile(o, 'autostart'))
}
