// All executable/config/credential seams for the broker proof are local fixtures.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

export const fixtureSource = fileURLToPath(new URL('./synthetic-credential-tool.cs', import.meta.url))
export const quotePS = s => "'" + String(s).replace(/'/g, "''") + "'"

// The rig keeper deliberately drops all GH_* variables. Restore only these
// scratch settings in the hosted checker; retain its bridge adapter PATH/grant.
export function hostedEnvironment(base = process.env) {
  const root = base.RIG_BROKER_FIXTURE
  if (!root || !path.isAbsolute(root)) throw Error('missing synthetic fixture root')
  return { ...base, GH_HOST: 'rig-proof.example', GH_CONFIG_DIR: path.join(root, 'gh') }
}

// fakecli passes the spawn step through cmd /C. Put quoted executable paths in
// a batch file rather than transporting embedded quotes through CreateProcess.
export function agentCommand(dir, args, phase) {
  const wrapper = path.join(dir, 'agent-check.cmd')
  if (/[\s"&|<>^%!]/.test(wrapper) || !['helper', 'handback', 'none'].includes(phase)) throw Error('unsafe synthetic command path or phase')
  if (args.some(s => !path.isAbsolute(s) || /[\r\n"&|<>^%!]/.test(s))) throw Error('unsafe synthetic command argument')
  fs.writeFileSync(wrapper, '@echo off\r\n' + args.map(s => '"' + s + '"').join(' ') + ' "%~1"\r\n')
  return wrapper + ' ' + phase
}

export function fixtureEnvironment(dir, inherited = process.env) {
  const root = inherited.RIG_BROKER_OUTPUT ? path.join(inherited.RIG_BROKER_OUTPUT, 'synthetic-home') : path.join(dir, 'synthetic-home')
  if (!path.isAbsolute(root)) throw Error('absolute synthetic output required')
  const system = inherited.SystemRoot || inherited.SYSTEMROOT
  if (!system || !path.isAbsolute(system)) throw Error('absolute SystemRoot required')
  const env = {
    SystemRoot: system, WINDIR: system, ComSpec: path.join(system, 'System32', 'cmd.exe'),
    PATH: [path.join(root, 'bin'), path.join(system, 'System32'), path.join(system, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter),
    PATHEXT: '.COM;.EXE;.BAT;.CMD', OS: 'Windows_NT',
    HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'), TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'),
    GH_CONFIG_DIR: path.join(root, 'gh'), GH_HOST: 'rig-proof.example',
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_SYSTEM: path.join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    RIG_BROKER_FIXTURE: root,
  }
  for (const key of ['ORGTREE_AGENT', 'ORGTREE_RIG_HOME', 'ORGTREE_RIG_BROKER', 'CARGO_TARGET_DIR', 'RIG_BROKER_OUTPUT']) if (inherited[key]) env[key] = inherited[key]
  return env
}

export function assertFixture(env) {
  const root = fs.realpathSync(env.RIG_BROKER_FIXTURE)
  for (const key of ['HOME', 'USERPROFILE']) if (fs.realpathSync(env[key]) !== root) throw Error('home escaped synthetic fixture')
  for (const key of Object.keys(env)) if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GIT_CONFIG_PARAMETERS|GIT_ASKPASS|SSH_ASKPASS)$/i.test(key)) throw Error('inherited credential override')
  for (const tool of ['git.exe', 'gh.exe']) {
    const resolved = env.PATH.split(path.delimiter).map(d => path.join(d, tool)).find(p => fs.existsSync(p))
    if (!resolved || fs.realpathSync(resolved) !== path.join(root, 'bin', tool)) throw Error('native tool escaped synthetic fixture')
  }
  if (fs.readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8') !== '') throw Error('synthetic Git config must be empty')
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  return { home: root, path: env.PATH, git: path.join(root, 'bin', 'git.exe'), gh: path.join(root, 'bin', 'gh.exe'),
    sourceSha256: hash(fixtureSource), exeSha256: hash(path.join(root, 'bin', 'git.exe')), externalNetwork: false }
}

export function prepareFixture({ dir }) {
  const env = fixtureEnvironment(dir)
  for (const folder of [env.HOME, path.join(env.HOME, 'bin'), env.APPDATA, env.LOCALAPPDATA, env.TEMP, env.GH_CONFIG_DIR]) fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '')
  const git = path.join(env.HOME, 'bin', 'git.exe')
  const powershell = path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; Add-Type -Path " + quotePS(fixtureSource) + ' -OutputAssembly ' + quotePS(git) + ' -OutputType ConsoleApplication'],
  { windowsHide: true, timeout: 60000, stdio: 'pipe', env })
  fs.copyFileSync(git, path.join(env.HOME, 'bin', 'gh.exe'))
  const audit = assertFixture(env)
  fs.writeFileSync(path.join(dir, 'synthetic-preflight.json'), JSON.stringify(audit, null, 2))
  // The keeper inherits only this allowlist. Its own rig-only variables are added
  // normally; no live auth/store configuration can leak into hosted children.
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
}
