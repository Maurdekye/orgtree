#!/usr/bin/env node
// The background engine on macOS and Linux, for real (docket
// mac-and-linux-background-engine-that-starts-auto): register the PACKAGED
// app's engine the way the installed desktop does (apps/desktop/main/unixboot.ts),
// let launchd / systemd --user (or, without systemd --user, the autostart
// fallback's start-now) run `orgtree-engine host`, wait for the attach
// descriptor, check the desktop's POSIX trust rule accepts it and the engine
// answers on its port as that data folder, then unregister and check the
// engine is gone.
//
//   node .github/ci/boot-engine-smoke.mjs <packaged resources/engine/orgtree-engine> [--appimage <file>]
//
// macOS:  "$APP/Contents/Resources/engine/orgtree-engine"
// Linux:  release/linux-unpacked/resources/engine/orgtree-engine (deb layout),
//         or --appimage release/Orgtree-<v>.AppImage (with any engine path).
// A throwaway data folder under $RUNNER_TEMP (or the OS temp); the
// registration is removed at the end, also on failure. Exit 0 = proven.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const engine = path.resolve(argv[0] ?? '')
const appImageAt = argv.indexOf('--appimage')
const appImage = appImageAt >= 0 ? path.resolve(argv[appImageAt + 1]) : undefined
if (!argv[0] || !fs.existsSync(engine)) { console.error(`usage: boot-engine-smoke.mjs <packaged orgtree-engine> [--appimage <file>] (got ${engine})`); process.exit(2) }

const tmp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'orgtree-boot-smoke-'))
const load = async (source, name) => {
  const out = path.join(tmp, `${name}.cjs`)
  await build({ entryPoints: [path.join(ROOT, source)], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' })
  return createRequire(import.meta.url)(out)
}
const boot = await load('apps/desktop/main/unixboot.ts', 'unixboot')
const policy = await load('apps/desktop/main/policy.ts', 'policy')

const dataRoot = path.join(tmp, 'data')
fs.mkdirSync(dataRoot, { recursive: true })
const inputs = { platform: process.platform, home: os.homedir(), appId: 'com.maurdekye.orgtree', engine, appImage, dataRoot }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log('[boot-smoke]', ...a)
const descriptorFile = path.join(dataRoot, 'engine-attach.json')
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
let failed = ''
let descriptor = null
try {
  const outcome = await boot.ensureBootEngine(inputs)
  log('registered:', JSON.stringify(outcome))
  log(fs.readFileSync(outcome.file, 'utf8'))
  if (!outcome.started) throw Error(`the ${outcome.manager} registration did not start the host: ${outcome.error ?? ''}`)
  // the first start creates the PostgreSQL cluster: allow a few minutes
  const deadline = Date.now() + 300000
  while (!fs.existsSync(descriptorFile)) {
    if (Date.now() > deadline) throw Error('no engine-attach.json within 5 minutes')
    await sleep(1000)
  }
  descriptor = JSON.parse(fs.readFileSync(descriptorFile, 'utf8'))
  log('descriptor:', JSON.stringify({ ...descriptor, token: '<redacted>' }))
  const trust = await policy.verifyDescriptorTrust(fs.realpathSync(descriptorFile))
  log('trust:', JSON.stringify(trust))
  if (!trust.ok) throw Error('the desktop would refuse this descriptor: ' + trust.detail)
  const r = await fetch(`http://127.0.0.1:${descriptor.port}/api/desktop/identity`, { headers: { [policy.TOKEN_HEADER]: descriptor.token }, signal: AbortSignal.timeout(10000) })
  const identity = await r.json()
  log('identity:', r.status, JSON.stringify(identity))
  if (r.status !== 200 || identity.protocol !== 1 || identity.pid !== descriptor.enginePid) throw Error('the engine did not answer as the descriptor says')
  if (fs.realpathSync(identity.dataRootId) !== fs.realpathSync(dataRoot)) throw Error(`the engine serves ${identity.dataRootId}, not ${dataRoot}`)
  log(`PASS: ${outcome.manager} started the host; engine pid ${descriptor.enginePid} answers on 127.0.0.1:${descriptor.port} for the smoke's data folder`)
} catch (e) { failed = e.message }
finally {
  await boot.removeBootEngine(inputs)
  // the autostart fallback's host has no manager to stop it
  if (descriptor?.hostPid && alive(descriptor.hostPid)) { try { process.kill(descriptor.hostPid, 'SIGTERM') } catch { /* gone */ } }
  const deadline = Date.now() + 60000
  while (descriptor && (alive(descriptor.enginePid) || fs.existsSync(descriptorFile)) && Date.now() < deadline) await sleep(500)
  if (descriptor && alive(descriptor.enginePid)) failed ||= `engine pid ${descriptor.enginePid} still runs a minute after unregistering`
  else if (descriptor) log('unregistered: the engine stopped and its descriptor is gone')
  const hostLog = path.join(dataRoot, 'diagnostics', 'boot-host.log')
  if (fs.existsSync(hostLog)) log('boot-host.log:\n' + fs.readFileSync(hostLog, 'utf8'))
}
if (failed) { console.error('[boot-smoke] FAIL:', failed); process.exit(1) }
