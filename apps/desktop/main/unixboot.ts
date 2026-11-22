import { execFile, launchDetached } from './probe-host'
import fs from 'node:fs'
import path from 'node:path'

import { readDataLocationConfig } from './policy'
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
export const STARTUP_DEFAULT_FOLDER_ONLY = 'Run on startup is only available for the default data folder.'

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
  /** $APPIMAGE when running from an AppImage with a FUSE mount: the registration
   *  runs the AppImage file itself, which keeps its mount up (APPIMAGE_HOST_JS) */
  appImage?: string
  /** files that must also exist for the entry to do anything. Without FUSE `engine`
   *  is the engine's own copy (engine-runtime.ts) and this is the AppImage: deleting
   *  the AppImage makes the registration a no-op, as a removed installation does */
  requires?: string[]
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

/** The PATH of the engine the desktop starts itself, on macOS and Linux: the one the
 *  background engine's registration gets (bootPath), so the provider CLIs are found
 *  the same way whichever engine serves the session. The desktop's own PATH depends
 *  on how it was opened: under Steam it is /usr/local/bin:/usr/bin, without
 *  ~/.local/bin. undefined (the PATH is left as it is) on Windows and in a
 *  development run, which is started from the developer's shell. */
export function managedEnginePath(o: { packaged: boolean; platform: NodeJS.Platform; home: string; shellPath?: string }): string | undefined {
  if (!o.packaged || o.platform === 'win32') return undefined
  return bootPath(o.home, o.platform, o.shellPath)
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
    execFile(shell, [flags, script], { env, cwd: home || undefined, timeout: timeoutMs, killSignal: 'SIGKILL', input: '' },
      (_error, stdout) => resolve(parseShellPath(String(stdout ?? ''))))
  })
  const [login, interactive] = await Promise.all([read('-ilc'), read('-ic')])
  const seen = new Set<string>()
  return [...login.split(':'), ...interactive.split(':')].filter(d => d && !seen.has(d) && !!seen.add(d)).join(':')
}

export interface OwnershipFs {
  realpathSync: { native(p: string): string }
  readFileSync: typeof fs.readFileSync
  lstatSync?: typeof fs.lstatSync
  readlinkSync?: typeof fs.readlinkSync
  statSync?: typeof fs.statSync
}

export interface DataRootGuardInputs {
  /** Process environment inspected for ORGTREE_V2_DATA / ORGTREE_V2_PROFILE overrides. */
  env?: Record<string, string | undefined>
  /** The installation's default profile directory (`app.getPath('userData')` before
   *  any profile override). Resolved independently of `dataRoot` to read the saved
   *  `data-location.json` effective default root and compare `ORGTREE_V2_PROFILE`. */
  defaultUserData?: string
  /** The active profile directory (`app.getPath('userData')`). Defaults to `defaultUserData`. */
  userData?: string
  /** When true (3.0.0-alpha.0), ignores saved `data-location.json` and uses `<defaultUserData>/data`. */
  ownDataRootOnly?: boolean
  /** Optional explicit resolved data root (if already computed by the caller). */
  dataRoot?: string
  /** Explicit effective default data root when `defaultUserData` is omitted. */
  defaultDataRoot?: string
  /** Optional filesystem test seam (defaults to `node:fs`). */
  fs?: Partial<OwnershipFs>
}

export interface UnixStartupOwnership {
  /** True when a non-default data folder or profile is in use, or when path
   *  canonicalisation fails (fail closed). */
  nonDefault: boolean
  /** The effective default data root for the primary profile, or null if unknown. */
  effectiveDefaultRoot: string | null
  /** The verified data root passed to both the boot host and the engine:
   *  - when an env override was accepted, the canonicalised physical path;
   *  - on an ordinary launch with no env override, `effectiveDefaultRoot` unchanged
   *    (preserving byte-identical 4.6.8 registration files);
   *  - null when `nonDefault` is true. */
  hostDataRoot: string | null
  /** Normalised ORGTREE_V2_DATA override (blank/whitespace treated as unset),
   *  computed once here so the guard, data-root resolver, missing-folder recovery
   *  and managed engine environment all share the same verdict. */
  dataRootOverride: string | undefined
  /** Short detail naming why registration is skipped (when `nonDefault` is true). */
  reason?: string
}

export interface BootRegistrationInputs extends DataRootGuardInputs {
  packaged: boolean
  platform: NodeJS.Platform
  appId: string
  releaseAppId: string
  version: string
  hasEngine: boolean
  /** Pre-computed ownership verdict from `resolveUnixStartupOwnership` so startup
   *  computes the guard once and shares its exact result across all paths. */
  ownership?: UnixStartupOwnership
}

/** Treat an unset, empty, or whitespace-only environment override as unset. */
export function trimmedEnvOverride(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value
}

function splitAbsolutePath(raw: string): { root: string; parts: string[] } | null {
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw)) return null
  const parsed = path.parse(raw)
  if (!parsed.root) return null
  const rest = raw.slice(parsed.root.length)
  const sep = process.platform === 'win32' ? /[\\/]+/ : /\/+/
  return { root: parsed.root, parts: rest.split(sep).filter(Boolean) }
}

function stripTrailingSep(resolved: string): string {
  const root = path.parse(resolved).root
  if (!root || resolved === root) return resolved
  const re = process.platform === 'win32' ? /[\\/]+$/ : /\/+$/
  return resolved.replace(re, '') || root
}

/** Canonicalise an existing absolute directory path without discarding `..`
 *  lexically before resolving symlinks or verifying intermediate existence.
 *  Fails closed (returns null) if the path is relative, missing, traverses a
 *  missing or non-directory intermediate, is not a directory, or realpath fails. */
export function canonicalizeExistingPath(
  raw: string,
  pathFs: Pick<OwnershipFs, 'realpathSync' | 'statSync'> = fs,
): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const split = splitAbsolutePath(raw)
  if (!split) return null
  try {
    let resolved: string
    if (split.parts.includes('..')) {
      let cur = split.root
      for (const seg of split.parts) {
        if (seg === '.') {
          cur = pathFs.realpathSync.native(cur)
          if (typeof pathFs.statSync === 'function' && !pathFs.statSync(cur).isDirectory()) return null
          continue
        }
        if (seg === '..') {
          cur = pathFs.realpathSync.native(cur)
          if (typeof pathFs.statSync === 'function' && !pathFs.statSync(cur).isDirectory()) return null
          cur = path.dirname(cur)
        } else {
          cur = path.join(cur, seg)
        }
      }
      resolved = pathFs.realpathSync.native(cur)
    } else {
      resolved = pathFs.realpathSync.native(raw)
    }
    if (typeof resolved !== 'string' || !resolved || !path.isAbsolute(resolved)) return null
    if (typeof pathFs.statSync === 'function' && !pathFs.statSync(resolved).isDirectory()) return null
    const norm = splitAbsolutePath(resolved)
    if (!norm || norm.parts.includes('..')) return null
    if (norm.parts.includes('.')) resolved = path.normalize(resolved)
    return stripTrailingSep(resolved)
  } catch {
    return null
  }
}

/** The effective default data root for a normal launch with no env override:
 *  the validated saved `<defaultUserData>/data-location.json` target when
 *  present (unless `ownDataRootOnly`), otherwise `<defaultUserData>/data`. */
export function effectiveDefaultDataRoot(
  defaultUserData: string,
  ownDataRootOnly = false,
  pathFs: Pick<OwnershipFs, 'readFileSync' | 'lstatSync' | 'readlinkSync'> = fs,
): string {
  const own = path.join(defaultUserData, 'data')
  if (ownDataRootOnly) return own
  return readDataLocationConfig(defaultUserData, pathFs)?.dataRoot ?? own
}

/** Shared Unix startup-ownership resolver used by early login-item checks,
 *  the startup switch capability, engine dataRoot normalisation, and boot
 *  service registration. Compares any non-blank ORGTREE_V2_DATA or
 *  ORGTREE_V2_PROFILE override against the EFFECTIVE default root (including
 *  saved `data-location.json`) and independent `defaultUserData` profile dir.
 *  Fails closed whenever canonicalisation fails. */
export function resolveUnixStartupOwnership(o: DataRootGuardInputs): UnixStartupOwnership {
  const pathFs: OwnershipFs = {
    realpathSync: o.fs?.realpathSync ?? fs.realpathSync,
    readFileSync: o.fs?.readFileSync ?? fs.readFileSync,
    lstatSync: o.fs && 'lstatSync' in o.fs ? o.fs.lstatSync : fs.lstatSync,
    readlinkSync: o.fs && 'readlinkSync' in o.fs ? o.fs.readlinkSync : fs.readlinkSync,
    statSync: o.fs && 'statSync' in o.fs ? o.fs.statSync : fs.statSync,
  }
  const effectiveDefaultRoot = o.defaultUserData
    ? effectiveDefaultDataRoot(o.defaultUserData, o.ownDataRootOnly === true, pathFs)
    : (o.defaultDataRoot ?? null)

  const envData = trimmedEnvOverride(o.env?.ORGTREE_V2_DATA)
  const envProfile = trimmedEnvOverride(o.env?.ORGTREE_V2_PROFILE)
  const verdict = (r: Omit<UnixStartupOwnership, 'dataRootOverride'>): UnixStartupOwnership => ({
    ...r,
    dataRootOverride: envData,
  })
  const hasDataOverride = envData !== undefined
  const hasProfileOverride = envProfile !== undefined
  const profileRedirected = Boolean(o.userData && o.defaultUserData && o.userData !== o.defaultUserData)

  if (profileRedirected) {
    const canonDefaultProfile = canonicalizeExistingPath(o.defaultUserData!, pathFs)
    const canonUserProfile = canonicalizeExistingPath(o.userData!, pathFs)
    if (!canonDefaultProfile || !canonUserProfile || canonUserProfile !== canonDefaultProfile) {
      return verdict({ nonDefault: true, effectiveDefaultRoot, hostDataRoot: null, reason: `userData=${o.userData}` })
    }
  }

  if (!hasDataOverride && !hasProfileOverride) {
    const explicitData = trimmedEnvOverride(o.dataRoot)
    if (explicitData && effectiveDefaultRoot && explicitData !== effectiveDefaultRoot) {
      const canonDefault = canonicalizeExistingPath(effectiveDefaultRoot, pathFs)
      const canonData = canonicalizeExistingPath(explicitData, pathFs)
      if (!canonDefault || !canonData || canonData !== canonDefault) {
        return verdict({ nonDefault: true, effectiveDefaultRoot, hostDataRoot: null, reason: explicitData })
      }
      return verdict({ nonDefault: false, effectiveDefaultRoot, hostDataRoot: canonData })
    }
    return verdict({ nonDefault: false, effectiveDefaultRoot, hostDataRoot: effectiveDefaultRoot })
  }

  if (!effectiveDefaultRoot) {
    return verdict({
      nonDefault: true,
      effectiveDefaultRoot: null,
      hostDataRoot: null,
      reason: envData ? `ORGTREE_V2_DATA=${envData}` : `ORGTREE_V2_PROFILE=${envProfile}`,
    })
  }

  if (hasProfileOverride) {
    if (!o.defaultUserData) {
      return verdict({ nonDefault: true, effectiveDefaultRoot, hostDataRoot: null, reason: `ORGTREE_V2_PROFILE=${envProfile}` })
    }
    const canonDefaultProfile = canonicalizeExistingPath(o.defaultUserData, pathFs)
    const canonEnvProfile = canonicalizeExistingPath(envProfile, pathFs)
    if (!canonDefaultProfile || !canonEnvProfile) {
      return verdict({
        nonDefault: true,
        effectiveDefaultRoot,
        hostDataRoot: null,
        reason: `ORGTREE_V2_PROFILE=${envProfile} (could not be canonicalised)`,
      })
    }
    if (canonEnvProfile !== canonDefaultProfile) {
      return verdict({ nonDefault: true, effectiveDefaultRoot, hostDataRoot: null, reason: `ORGTREE_V2_PROFILE=${envProfile}` })
    }
  }

  if (hasDataOverride) {
    const canonDefault = canonicalizeExistingPath(effectiveDefaultRoot, pathFs)
    const canonEnvData = canonicalizeExistingPath(envData, pathFs)
    if (!canonDefault || !canonEnvData) {
      return verdict({
        nonDefault: true,
        effectiveDefaultRoot,
        hostDataRoot: null,
        reason: `ORGTREE_V2_DATA=${envData} (could not be canonicalised)`,
      })
    }
    if (canonEnvData !== canonDefault) {
      return verdict({ nonDefault: true, effectiveDefaultRoot, hostDataRoot: null, reason: `ORGTREE_V2_DATA=${envData}` })
    }
    const explicitData = trimmedEnvOverride(o.dataRoot)
    if (explicitData) {
      const canonExplicit = canonicalizeExistingPath(explicitData, pathFs)
      if (!canonExplicit || canonExplicit !== canonDefault) {
        return verdict({ nonDefault: true, effectiveDefaultRoot, hostDataRoot: null, reason: explicitData })
      }
    }
    return verdict({ nonDefault: false, effectiveDefaultRoot, hostDataRoot: canonEnvData })
  }

  const explicitData = trimmedEnvOverride(o.dataRoot)
  if (explicitData && explicitData !== effectiveDefaultRoot) {
    const canonDefault = canonicalizeExistingPath(effectiveDefaultRoot, pathFs)
    const canonExplicit = canonicalizeExistingPath(explicitData, pathFs)
    if (!canonDefault || !canonExplicit || canonExplicit !== canonDefault) {
      return verdict({ nonDefault: true, effectiveDefaultRoot, hostDataRoot: null, reason: explicitData })
    }
    return verdict({ nonDefault: false, effectiveDefaultRoot, hostDataRoot: canonExplicit })
  }
  return verdict({ nonDefault: false, effectiveDefaultRoot, hostDataRoot: effectiveDefaultRoot })
}

/** True when ORGTREE_V2_DATA or ORGTREE_V2_PROFILE points to anything other
 *  than the effective default data root (saved data-location.json included) or
 *  default profile directory, or when path canonicalisation fails. */
export function isNonDefaultDataRoot(o: DataRootGuardInputs): boolean {
  return resolveUnixStartupOwnership(o).nonDefault
}

/** Whether THIS build owns the background engine's registration (the LaunchAgent,
 *  the systemd user unit, the autostart entry): the installed release using the
 *  effective default profile/data folder only. A build whose version carries a
 *  prerelease label (4.6.3-frame.1, an alpha, a release candidate) or a run
 *  started with a non-default ORGTREE_V2_DATA or ORGTREE_V2_PROFILE override
 *  is beside the default installation, and one registration serves the whole
 *  account: such a run would overwrite or disable the default org's unit or
 *  LaunchAgent. It never writes, enables, disables or removes any of them; it
 *  attaches to a host that already answers, or starts an engine of its own. */
export function registersBootEngine(o: BootRegistrationInputs): boolean {
  if (!o.packaged || o.platform === 'win32' || o.appId !== o.releaseAppId || !o.hasEngine) return false
  if (/^\d+\.\d+\.\d+-/.test(o.version.trim())) return false
  const ownership = o.ownership ?? resolveUnixStartupOwnership(o)
  if (ownership.nonDefault) return false
  return true
}

export function bootCommand(o: BootInputs): BootCommand {
  const env = { ORGTREE_V2_DATA: o.dataRoot, PATH: bootPath(o.home, o.platform, o.shellPath) }
  if (o.appImage) return { program: o.appImage, args: ['-e', APPIMAGE_HOST_JS], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  return { program: o.engine, args: ['host'], env }
}

/** What the registration is made from, by how the app runs. An AppImage without a
 *  FUSE mount (`extracted`) cannot be the registered program: it needs libfuse to
 *  start, and its extraction is deleted when the desktop exits. `engine` is then
 *  the engine's own copy, run directly. */
export function bootInputsFor(o: Omit<BootInputs, 'requires'> & { extracted: boolean }): BootInputs {
  const { extracted, appImage, ...rest } = o
  return extracted && appImage ? { ...rest, requires: [appImage] } : { ...rest, appImage }
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
    ...[c.program, ...(o.requires ?? [])].map(file => `ConditionPathExists=${file.replace(/%/g, '%%')}`),
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
  /** this process's environment (process.env when absent) */
  env?: NodeJS.ProcessEnv
  /** start the host now, outside any service manager (the autostart fallback) */
  detach(c: BootCommand): void
}

/** Chromium sets DBUS_SESSION_BUS_ADDRESS=disabled: in the desktop when the
 *  session has no D-Bus session bus (measured on the Linux CI runner). Every
 *  child inherits it, and `systemctl --user` then refuses ("Failed to connect
 *  to bus") instead of reaching the user manager through $XDG_RUNTIME_DIR.
 *  Only that value is dropped, and only for the children started here; the
 *  desktop's own environment is left as Chromium set it. */
export const busDisabled = (env: NodeJS.ProcessEnv) => env.DBUS_SESSION_BUS_ADDRESS === 'disabled:'

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!busDisabled(env)) return env
  const { DBUS_SESSION_BUS_ADDRESS: _dropped, ...rest } = env
  return rest
}

/** `systemctl --user ...`, through `env -u` when the bus address is disabled:
 *  the shared Runner has no environment parameter. */
function systemctl(io: BootIo, args: string[], timeoutMs: number) {
  return busDisabled(io.env ?? process.env)
    ? io.runner('env', ['-u', 'DBUS_SESSION_BUS_ADDRESS', 'systemctl', '--user', ...args], timeoutMs)
    : io.runner('systemctl', ['--user', ...args], timeoutMs)
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
  // started by the probe host, detached; a failure is moot: the desktop starts its own engine instead
  detach: c => { void launchDetached(c.program, c.args, { env: { ...childEnv(process.env), ...c.env } }) },
}

export interface BootOutcome {
  /** launchd | systemd | autostart */
  manager: 'launchd' | 'systemd' | 'autostart'
  file: string
  changed: boolean
  /** the host was asked to start now */
  started: boolean
  error?: string
  /** why systemd was not used, when the autostart entry was */
  systemdSkipped?: string
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
  const probe = await systemctl(io, ['show-environment'], 10000)
    .catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }))
  const systemd = probe.code === 0
  if (systemd) {
    const file = bootFile(o, 'systemd')
    const text = systemdUnit(o)
    const changed = io.read(file) !== text
    try {
      if (changed) {
        io.write(file, text)
        await systemctl(io, ['daemon-reload'], 30000)
      }
      const e = await systemctl(io, ['enable', SYSTEMD_UNIT], 30000)
      if (e.code !== 0) return { manager: 'systemd', file, changed, started: false, error: `systemctl enable: ${failed(e)}` }
      // a changed unit restarts onto the new command; an unchanged one only starts if stopped
      const s = await systemctl(io, [changed ? 'restart' : 'start', SYSTEMD_UNIT], 30000)
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
    return { manager: 'autostart', file, changed, started: true, systemdSkipped: `systemctl --user show-environment: ${failed(probe)}` }
  } catch (e) { return { manager: 'autostart', file, changed, started: false, error: (e as Error).message } }
}

/** "Run on startup" turned on mid-session: register the host for the next
 *  login WITHOUT starting it now. An engine already serves this session (the
 *  desktop's own, or a host), and a second one would find the data root
 *  taken. launchd reads ~/Library/LaunchAgents at login; systemd starts an
 *  enabled unit at login; the autostart entry is read at login. Never throws. */
export async function enableBootEngine(o: BootInputs, io: BootIo = realIo): Promise<BootOutcome> {
  if (o.platform === 'darwin') {
    const file = bootFile(o, 'launchd')
    const text = launchAgentPlist(o)
    const changed = io.read(file) !== text
    try {
      if (changed) io.write(file, text)
      return { manager: 'launchd', file, changed, started: false }
    } catch (e) { return { manager: 'launchd', file, changed, started: false, error: (e as Error).message } }
  }
  const probe = await systemctl(io, ['show-environment'], 10000)
    .catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }))
  if (probe.code === 0) {
    const file = bootFile(o, 'systemd')
    const text = systemdUnit(o)
    const changed = io.read(file) !== text
    try {
      if (changed) {
        io.write(file, text)
        await systemctl(io, ['daemon-reload'], 30000)
      }
      const e = await systemctl(io, ['enable', SYSTEMD_UNIT], 30000)
      if (e.code !== 0) return { manager: 'systemd', file, changed, started: false, error: `systemctl enable: ${failed(e)}` }
      io.remove(bootFile(o, 'autostart'))
      return { manager: 'systemd', file, changed, started: false }
    } catch (err) { return { manager: 'systemd', file, changed, started: false, error: (err as Error).message } }
  }
  const file = bootFile(o, 'autostart')
  const text = autostartEntry(o)
  const changed = io.read(file) !== text
  try {
    if (changed) io.write(file, text)
    return { manager: 'autostart', file, changed, started: false, systemdSkipped: `systemctl --user show-environment: ${failed(probe)}` }
  } catch (e) { return { manager: 'autostart', file, changed, started: false, error: (e as Error).message } }
}

/** "Run on startup" off: nothing starts at the next login, and a host that
 *  is running now is left running (the session it serves keeps its engine).
 *  macOS: the agent's file goes, so launchd does not load it at the next
 *  login (a loaded agent stays until then). Linux: the unit is disabled
 *  without --now, and the autostart entry goes. Never throws. */
export async function disableBootEngine(o: Pick<BootInputs, 'platform' | 'home' | 'appId'>, io: BootIo = realIo): Promise<void> {
  if (o.platform === 'darwin') {
    io.remove(bootFile(o, 'launchd'))
    return
  }
  await systemctl(io, ['disable', SYSTEMD_UNIT], 30000).catch(() => undefined)
  io.remove(bootFile(o, 'autostart'))
}

/** Remove every registration this module may have made. */
export async function removeBootEngine(o: Pick<BootInputs, 'platform' | 'home' | 'appId'>, io: BootIo = realIo): Promise<void> {
  if (o.platform === 'darwin') {
    await io.runner('launchctl', ['bootout', `gui/${io.uid()}/${launchAgentLabel(o.appId)}`], 15000).catch(() => undefined)
    io.remove(bootFile(o, 'launchd'))
    return
  }
  await systemctl(io, ['disable', '--now', SYSTEMD_UNIT], 30000).catch(() => undefined)
  io.remove(bootFile(o, 'systemd'))
  await systemctl(io, ['daemon-reload'], 30000).catch(() => undefined)
  io.remove(bootFile(o, 'autostart'))
}
