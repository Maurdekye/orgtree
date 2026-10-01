// tests/hub_isolation.mjs — the Node twin of tests/hub_isolation.py. Nothing
// here boots an engine or opens a connection to a hub.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LIVE_HUB_PORTS, UNROUTABLE_HUB_ADDRESS, hubPort, isLiveHubAddress, scrubInheritedHub,
  isolateDataRoot, readRigHub, hubStatusProblems,
} from './hub_isolation.mjs'

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-hub-isolation-'))

test('live hub ports are recognised however the address is spelled', () => {
  for (const address of ['http://127.0.0.1:7370', 'http://localhost:7370/api/register', '127.0.0.1',
    'hub.lan', 'http://0.0.0.0:7371/healthz', 'http://[::1]:7370/api/poll']) {
    assert.equal(isLiveHubAddress(address), true, address)
  }
  for (const address of [UNROUTABLE_HUB_ADDRESS, 'http://127.0.0.1:51234', 'https://quiet-hub.trycloudflare.com', '', 'http://[bad']) {
    assert.equal(isLiveHubAddress(address), false, address)
  }
  assert.equal(hubPort('hub.lan:7411'), 7411)
})

test('the inherited address is scrubbed and reported', () => {
  const env = { ORGTREE_LOCAL_HUB_ADDRESS: 'http://127.0.0.1:7370', KEEP: '1' }
  assert.deepEqual(scrubInheritedHub(env), ['ORGTREE_LOCAL_HUB_ADDRESS'])
  assert.deepEqual(env, { KEEP: '1' })
})

test('a rig root gets its own hub and a dead default, and reads back as proof', () => {
  const data = fresh()
  const hub = isolateDataRoot(data)
  assert.ok(!LIVE_HUB_PORTS.includes(hub.port))
  assert.deepEqual(readRigHub(data), hub)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'defaults.json'), 'utf8')), { net_hub_address: UNROUTABLE_HUB_ADDRESS })
  // a configured root is refused, not overwritten
  assert.throws(() => isolateDataRoot(data), /already exists/)
  assert.deepEqual(readRigHub(data), hub)
})

test('a root that is not provably isolated is refused', () => {
  const cases = {
    'no hub of its own': data => fs.rmSync(path.join(data, 'mailhub-hosting.json')),
    'the live port': data => rewrite(data, 'mailhub-hosting.json', { port: 7370 }),
    'a non-rig name': data => rewrite(data, 'mailhub-hosting.json', { name: 'operator-hub' }),
    'a public listener': data => rewrite(data, 'mailhub-hosting.json', { public_listener: true }),
    'a live default': data => rewrite(data, 'defaults.json', { net_hub_address: 'http://127.0.0.1:7370' }),
  }
  for (const [label, damage] of Object.entries(cases)) {
    const data = fresh()
    isolateDataRoot(data)
    damage(data)
    assert.throws(() => readRigHub(data), /not an isolated rig root/, label)
  }
})

test('the engine status must name the rig hub by address and name', () => {
  const hub = { address: 'http://127.0.0.1:51234', name: 'test-rig-abc' }
  const good = { address: hub.address, hub_name: hub.name, healthy: true }
  assert.deepEqual(hubStatusProblems(good, hub), [])
  assert.notDeepEqual(hubStatusProblems({ ...good, address: 'http://127.0.0.1:7370' }, hub), [])
  assert.notDeepEqual(hubStatusProblems({ ...good, hub_name: 'operator-hub' }, hub), [])
  assert.notDeepEqual(hubStatusProblems({ ...good, healthy: false }, hub), [])
})

function rewrite(data, file, change) {
  const target = path.join(data, file)
  fs.writeFileSync(target, JSON.stringify({ ...JSON.parse(fs.readFileSync(target, 'utf8')), ...change }))
}
