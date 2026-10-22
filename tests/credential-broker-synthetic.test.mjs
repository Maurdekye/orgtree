import test from 'node:test'
import assert from 'node:assert/strict'
import { setup } from '../tools/rig/proofs/credential-broker.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fixtureEnvironment, assertFixture, agentCommand } from '../tools/rig/broker-synthetic.mjs'

test('credential-broker prepares synthetic tools before the rig engine starts', async () => {
  const config = await setup()
  assert.equal(typeof config.prepare, 'function',
    'the broker and hosted child must receive scratch executables and homes before launch')
  assert.equal(config.bootIsolated, true)
})

test('synthetic environment ignores inherited credentials and native tool search paths', () => {
  const env = fixtureEnvironment(path.resolve('fixture'), {
    SystemRoot: process.env.SystemRoot || path.resolve('system'), PATH: 'live-tools', GH_TOKEN: 'live-canary',
    GIT_CONFIG_GLOBAL: 'live-config', ORGTREE_CREDENTIAL_AUTH: 'live-capability',
  })
  assert.equal(env.GH_TOKEN, undefined)
  assert.equal(env.ORGTREE_CREDENTIAL_AUTH, undefined)
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(env.HOME, env.USERPROFILE)
  assert.equal(env.GIT_CONFIG_GLOBAL, path.join(env.HOME, 'gitconfig'))
  assert.ok(!env.PATH.includes('live-tools'))
})

test('preflight refuses inherited tokens, escaped executables and user config includes', () => {
  const dir = fs.mkdtempSync(path.join(process.env.RIG_BROKER_TEST_TMP || os.tmpdir(), 'broker-synthetic-'))
  try {
    const env = fixtureEnvironment(dir, { SystemRoot: process.env.SystemRoot || path.resolve('system') })
    fs.mkdirSync(path.join(env.HOME, 'bin'), { recursive: true })
    for (const tool of ['git.exe', 'gh.exe']) fs.writeFileSync(path.join(env.HOME, 'bin', tool), 'inert-test-fixture')
    fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '')
    assert.equal(assertFixture(env).externalNetwork, false)
    assert.throws(() => assertFixture({ ...env, GH_TOKEN: 'canary' }), /credential override/)
    const bad = path.join(dir, 'other')
    fs.mkdirSync(bad)
    fs.writeFileSync(path.join(bad, 'gh.exe'), 'inert-outside-fixture')
    assert.throws(() => assertFixture({ ...env, PATH: bad + path.delimiter + env.PATH }), /escaped/)
    fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[include]\npath=live-config')
    assert.throws(() => assertFixture(env), /empty/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the Windows fake-CLI command preserves quoted Node paths and spaced arguments', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(process.env.RIG_BROKER_TEST_TMP || os.tmpdir(), 'broker-command-'))
  try {
    const script = path.join(dir, 'args.mjs')
    fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))')
    const engine = path.join(dir, 'engine.exe'), out = path.join(dir, 'output with spaces')
    const command = agentCommand(dir, [process.execPath, script, engine, out], 'helper')
    const r = spawnSync('cmd.exe', ['/D', '/C', command], { encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), [engine, out, 'helper'])
    assert.throws(() => agentCommand(dir, [process.execPath], 'helper & bad'), /unsafe/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
