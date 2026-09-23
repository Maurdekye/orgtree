// Keep Node-driven test rigs off the operator's real mail hub.
//
// The Node twin of tests/hub_isolation.py — read that file's docstring for
// the defect (fixture organisations of a test rig registered on the live hub)
// and the three routes that lead there:
//   1. an inherited ORGTREE_LOCAL_HUB_ADDRESS naming the live hub;
//   2. a fresh root with no mailhub-hosting.json, whose hub asks for the live
//      port 7370 and then names the LIVE hub, which answered /healthz, as its own;
//   3. a data root outside the engine's own temp directory, which turns off
//      net._under_os_temp, so the default hub is the live 127.0.0.1:7370.
// isolateDataRoot closes 2 and 3 (its own hub on a free port under a unique
// name, plus an explicit unroutable default); scrubInheritedHub closes 1.
// hubStatusProblems is the proof after boot: the hub the engine names as its
// own must be the rig's, by address and by name.
//
// The constants must equal the Python ones; test_hub_isolation pins them.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const LIVE_HUB_PORTS = Object.freeze([7370, 7371])
export const UNROUTABLE_HUB_ADDRESS = 'http://127.0.0.1:9'
export const INHERITED_HUB_ENV = Object.freeze(['ORGTREE_LOCAL_HUB_ADDRESS'])
export const RIG_HUB_PREFIX = 'test-rig-'

/** Remove the inherited hub address from `env`; return what was removed. */
export function scrubInheritedHub(env) {
  const removed = INHERITED_HUB_ENV.filter(key => key in env)
  for (const key of removed) delete env[key]
  return removed
}

/** The port an address reaches, read the way the engine's net module reads
 *  a hub address: no scheme means http, and http without a port means 7370. */
export function hubPort(address) {
  let text = String(address || '').trim()
  if (!text) return null
  if (!text.includes('://')) text = 'http://' + text
  let url
  try { url = new URL(text) } catch { return null }
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 7370
}

export function isLiveHubAddress(address) {
  return LIVE_HUB_PORTS.includes(hubPort(address))
}

/** A loopback port nobody holds right now, never one a live hub uses.
 *  Synchronous, because the acceptance roots are made synchronously. */
export function freePort() {
  for (;;) {
    const probe = spawnSync(process.execPath, ['-e',
      "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"],
      { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    const port = Number(probe.stdout)
    if (probe.status !== 0 || !Number.isInteger(port) || port <= 0) throw new Error('hub isolation: could not find a free port')
    if (!LIVE_HUB_PORTS.includes(port)) return port
  }
}

/** Configure a FRESH rig data root so its engine reaches only its own hub.
 *  Refuses a root that already holds either file. */
export function isolateDataRoot(data) {
  const defaults = path.join(data, 'defaults.json'), hosting = path.join(data, 'mailhub-hosting.json')
  for (const existing of [defaults, hosting]) {
    if (fs.existsSync(existing)) throw new Error(`${existing} already exists: hub isolation needs a fresh data root`)
  }
  const port = freePort()
  const name = RIG_HUB_PREFIX + crypto.randomBytes(6).toString('hex')
  fs.writeFileSync(defaults, JSON.stringify({ net_hub_address: UNROUTABLE_HUB_ADDRESS }))
  fs.writeFileSync(hosting, JSON.stringify({
    version: 2, port, bind: '127.0.0.1', name,
    retention_days: 1, org_retention_days: 1, public_listener: false,
  }))
  return { port, name, address: `http://127.0.0.1:${port}` }
}

/** The rig hub isolateDataRoot configured for `data`; throws unless the root
 *  is provably isolated (same rules as hub_isolation.read_rig_hub). */
export function readRigHub(data) {
  let hosting, defaults
  try {
    hosting = JSON.parse(fs.readFileSync(path.join(data, 'mailhub-hosting.json'), 'utf8'))
    defaults = JSON.parse(fs.readFileSync(path.join(data, 'defaults.json'), 'utf8'))
  } catch (error) {
    throw new Error(`${data} is not an isolated rig root: ${error.message}`)
  }
  const problems = []
  const port = hosting?.port, name = String(hosting?.name || ''), fallback = String(defaults?.net_hub_address || '')
  if (!Number.isInteger(port) || LIVE_HUB_PORTS.includes(port)) problems.push(`hub port ${port}`)
  if (!name.startsWith(RIG_HUB_PREFIX)) problems.push(`hub name ${JSON.stringify(name)}`)
  if (hosting?.bind !== '127.0.0.1' || hosting?.public_listener !== false) problems.push('hub is not loopback-only')
  if (!fallback || isLiveHubAddress(fallback)) problems.push(`default hub ${JSON.stringify(fallback)}`)
  if (problems.length) throw new Error(`${data} is not an isolated rig root: ${problems.join(', ')}`)
  return { port, name, address: `http://127.0.0.1:${port}` }
}

/** Compare the `status` block of /api/desktop/hub with the rig's hub. */
export function hubStatusProblems(status, hub) {
  const problems = []
  if (status?.address !== hub.address) problems.push(`address ${status?.address} != ${hub.address}`)
  if (status?.hub_name !== hub.name) problems.push(`hub_name ${status?.hub_name} != ${hub.name}`)
  if (!status?.healthy) problems.push('hub not healthy')
  return problems
}
