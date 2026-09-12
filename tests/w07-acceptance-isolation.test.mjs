import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  acceptanceEnvironment,
  acceptanceLaunchArgs,
  assertIsolatedEnvironment,
  isolatedRoot,
  preflightHelpers,
} from './acceptance/isolation.mjs'

test('W07 acceptance environment maps every writable selector into its disposable root', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-w07-test-'))
  try {
    const root = isolatedRoot(base)
    const env = acceptanceEnvironment(root, { env: { ORGTREE_ACCEPTANCE_APP: root } })
    assert.equal(assertIsolatedEnvironment(env, root), true)
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TEMP', 'TMP', 'TMPDIR', 'ORGTREE_LOG_DIR',
      'ORGTREE_BACKEND_ROOT', 'ORGTREE_CACHE_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
      'PYTHONPYCACHEPREFIX', 'ELECTRON_CACHE', 'ELECTRON_USER_DATA', 'ELECTRON_BUILDER_CACHE',
      'npm_config_cache', 'npm_config_userconfig', 'NPM_CONFIG_USERCONFIG',
      'npm_config_globalconfig', 'NPM_CONFIG_GLOBALCONFIG', 'PIP_CACHE_DIR',
      'PIP_CONFIG_FILE', 'YARN_CACHE_FOLDER', 'COREPACK_HOME', 'GIT_CONFIG_GLOBAL',
      'ORGTREE_DATA', 'ORGTREE_V2_DATA', 'ORGTREE_V2_PROFILE']) {
      assert.ok(env[key].startsWith(root), `${key} must stay below the acceptance root`)
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('W07 preflight reports helper syntax failures before a GUI is spawned', () => {
  const here = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-w07-preflight-'))
  try {
    fs.writeFileSync(path.join(here, 'bad.cjs'), 'if (')
    const result = preflightHelpers(here, process.execPath)
    assert.equal(result.status, 'FAIL')
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0].file, /bad\.cjs$/)
    assert.ok(result.failures[0].error)
  } finally {
    fs.rmSync(here, { recursive: true, force: true })
  }
})

test('W07 launch is quiet by default and visible only when explicitly requested', () => {
  const previous = process.env.ORGTREE_ACCEPTANCE_VISIBLE
  try {
    delete process.env.ORGTREE_ACCEPTANCE_VISIBLE
    assert.deepEqual(acceptanceLaunchArgs('probe.cjs'), ['probe.cjs', '--background'])
    process.env.ORGTREE_ACCEPTANCE_VISIBLE = '1'
    assert.deepEqual(acceptanceLaunchArgs('probe.cjs'), ['probe.cjs'])
  } finally {
    if (previous === undefined) delete process.env.ORGTREE_ACCEPTANCE_VISIBLE
    else process.env.ORGTREE_ACCEPTANCE_VISIBLE = previous
  }
})
