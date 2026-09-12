import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Acceptance children inherit the parent process environment.  A disposable
// data directory alone is not enough on Windows: Electron, Python, provider
// SDKs, and the OS libraries can write through any of these profile/cache
// selectors before the application has had a chance to configure itself.
const ROOT_DIRS = [
  'data', 'profile', 'project', 'inherited-v1', 'home', 'appdata',
  'localappdata', 'xdg-config', 'xdg-cache', 'xdg-state', 'temp', 'logs',
  'backend', 'cache', 'runtime', 'electron-cache', 'electron-user-data', 'npm-cache',
  'pip-cache', 'yarn-cache', 'corepack', 'programdata',
]

function inside(root, candidate) {
  const relative = path.relative(root, path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

export function isolatedRoot(base = os.tmpdir()) {
  const canonicalBase = fs.realpathSync.native(base)
  const forbiddenPath = path.resolve(os.homedir(), 'orgtree')
  const forbidden = fs.existsSync(forbiddenPath) ? fs.realpathSync.native(forbiddenPath) : forbiddenPath
  const relative = path.relative(forbidden, canonicalBase)
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Acceptance data must be outside the live v1 tree')
  }
  const root = fs.mkdtempSync(path.join(canonicalBase, 'orgtree-v2-acceptance-'))
  for (const name of ROOT_DIRS) fs.mkdirSync(path.join(root, name), { recursive: true })
  return root
}

export function acceptanceEnvironment(root, options = {}) {
  const resolvedRoot = fs.realpathSync.native(root)
  const home = path.resolve(options.home || path.join(resolvedRoot, 'home'))
  if (!inside(resolvedRoot, home)) throw new Error('Acceptance home must be inside its disposable root')
  fs.mkdirSync(home, { recursive: true })
  const dir = name => path.join(resolvedRoot, name)
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: dir('appdata'),
    LOCALAPPDATA: dir('localappdata'),
    PROGRAMDATA: dir('programdata'),
    XDG_CONFIG_HOME: dir('xdg-config'),
    XDG_CACHE_HOME: dir('xdg-cache'),
    XDG_STATE_HOME: dir('xdg-state'),
    TEMP: dir('temp'),
    TMP: dir('temp'),
    TMPDIR: dir('temp'),
    ORGTREE_LOG_DIR: dir('logs'),
    ORGTREE_BACKEND_ROOT: dir('backend'),
    ORGTREE_CACHE_DIR: dir('cache'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    PYTHONPYCACHEPREFIX: path.join(resolvedRoot, 'runtime', 'pycache'),
    ELECTRON_CACHE: dir('electron-cache'),
    ELECTRON_BUILDER_CACHE: dir('electron-cache'),
    ELECTRON_USER_DATA: dir('electron-user-data'),
    npm_config_cache: dir('npm-cache'),
    npm_config_userconfig: path.join(dir('xdg-config'), 'npmrc'),
    NPM_CONFIG_USERCONFIG: path.join(dir('xdg-config'), 'npmrc'),
    npm_config_globalconfig: path.join(dir('xdg-config'), 'npm-globalrc'),
    NPM_CONFIG_GLOBALCONFIG: path.join(dir('xdg-config'), 'npm-globalrc'),
    PIP_CACHE_DIR: dir('pip-cache'),
    PIP_CONFIG_FILE: path.join(dir('xdg-config'), 'pip.conf'),
    YARN_CACHE_FOLDER: dir('yarn-cache'),
    COREPACK_HOME: dir('corepack'),
    GIT_CONFIG_GLOBAL: path.join(dir('xdg-config'), 'gitconfig'),
    ORGTREE_ACCEPTANCE_ROOT: resolvedRoot,
    ORGTREE_DATA: dir('inherited-v1'),
    ORGTREE_V2_DATA: dir('data'),
    ORGTREE_V2_PROFILE: dir('profile'),
    ...options.env,
  }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ORGTREE_PORT', 'ORGTREE_V1_ROOT',
    'ORGTREE_V2_TOKEN', 'ORGTREE_NET_HUB_ADDRESS', 'ORGTREE_ACCEPTANCE_IMPORT_FIXTURE']) {
    if (!(key in (options.env || {}))) delete env[key]
  }
  return env
}

export function assertIsolatedEnvironment(env, root) {
  const resolvedRoot = fs.realpathSync.native(root)
  const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TEMP', 'TMP', 'TMPDIR', 'ORGTREE_LOG_DIR',
    'ORGTREE_BACKEND_ROOT', 'ORGTREE_CACHE_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
    'PYTHONPYCACHEPREFIX', 'ELECTRON_CACHE', 'ELECTRON_USER_DATA',
    'ELECTRON_BUILDER_CACHE', 'npm_config_cache', 'npm_config_userconfig',
    'NPM_CONFIG_USERCONFIG', 'npm_config_globalconfig', 'NPM_CONFIG_GLOBALCONFIG',
    'PIP_CACHE_DIR', 'PIP_CONFIG_FILE', 'YARN_CACHE_FOLDER', 'COREPACK_HOME',
    'GIT_CONFIG_GLOBAL', 'ORGTREE_DATA', 'ORGTREE_V2_DATA',
    'ORGTREE_V2_PROFILE']
  for (const key of keys) {
    if (!env[key] || !inside(resolvedRoot, env[key])) throw new Error(`Acceptance root escaped for ${key}`)
  }
  return true
}

export function preflightHelpers(here, python) {
  const failures = []
  const helperDir = path.resolve(here)
  const files = fs.readdirSync(helperDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && (entry.name.endsWith('.cjs') || entry.name.endsWith('.py')))
    .map(entry => path.join(helperDir, entry.name))
    .sort()
  for (const file of files) {
    const command = file.endsWith('.cjs')
      ? [process.execPath, ['--check', file]]
      : [python, ['-c', 'import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), filename=sys.argv[1])', file]]
    const result = spawnSync(command[0], command[1], { cwd: helperDir, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    if (result.error || result.status !== 0) failures.push({ file, status: result.status, error: result.error?.message || result.stderr?.trim() || 'preflight failed' })
  }
  return { status: failures.length ? 'FAIL' : 'PASS', files, failures }
}

// A runner can opt into a visible acceptance with ORGTREE_ACCEPTANCE_VISIBLE=1.
// Otherwise --background reaches the real desktop entrypoint before it creates
// any window, so a probe never steals focus merely by being started.
export function acceptanceLaunchArgs(entry, extra = []) {
  const args = [entry, ...extra]
  if (process.env.ORGTREE_ACCEPTANCE_VISIBLE !== '1' && !args.includes('--background')) args.push('--background')
  return args
}
