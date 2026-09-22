// run-composition-probe.mjs — the held-event composition fixture's runner.
//
// ⚠ WHAT MAKES THIS DIFFERENT FROM EVERY EARLIER HELD-EVENT TEST. The three
// channels that decide whether a held event is received were, until
// `main/held-events.ts` was extracted, closures inside `app.whenReady()` —
// reachable only by booting the whole app, which needs the engine. So every
// test that claimed to cover them exercised a COPY of their shape, and a copy
// cannot catch a mistake that lives in the original: that is exactly how an
// acknowledgement handler reading `event.args[0]` — a property an
// `IpcMainEvent` does not have — stayed dead through a full review.
//
// This fixture bundles and runs, in one Electron process:
//
//   the PRODUCTION main handlers   registerHeldEventChannels from
//                                  apps/desktop/main/held-events.ts, with the
//                                  real resolveNativeSender it imports itself
//   the PRODUCTION registry        orgWindowRegistry / windowOutbox
//   the PRODUCTION preload         apps/desktop/preload/index.ts, unmodified,
//                                  including its private document token
//   a REAL renderer consumer       the shipping events/heldbus.ts and the
//                                  shipping useNativeNotifications hook
//
// ⚠ NO ENGINE IS STARTED AND NO LIVE DATA IS READ. A throwaway HTTP server on
// 127.0.0.1 serves the probe document and ONE canned `/api/desktop/notifications`
// body, so the renderer's real fetch path runs against a fixture response.
// Electron's own state is redirected with app.setPath and ORGTREE_DATA/HOME
// point into the out directory. Nothing is installed, launched or restarted.
//
// Usage: node tools/run-composition-probe.mjs <outdir>
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? '.probe-composition')
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(path.join(root, 'home'), { recursive: true })
fs.mkdirSync(path.join(root, 'data'), { recursive: true })

// the PRODUCTION preload, bundled exactly as tools/build.mjs bundles it
await build({
  entryPoints: ['apps/desktop/preload/index.ts'],
  outfile: path.join(root, 'preload.cjs'),
  bundle: true, format: 'cjs', platform: 'node', external: ['electron'],
  logLevel: 'warning',
})
// the fixture's main process — which imports the PRODUCTION channel
// registration rather than restating it
await build({
  entryPoints: ['tests/composition-heldevents.probe.ts'],
  outfile: path.join(root, 'main.cjs'),
  bundle: true, format: 'cjs', platform: 'node', external: ['electron'],
  logLevel: 'warning',
})
// the renderer document — the real heldbus and the real notifications hook
await build({
  entryPoints: ['apps/desktop/renderer/tests/heldconsumer-probe.tsx'],
  outfile: path.join(root, 'probe.js'),
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  logLevel: 'warning', define: { 'process.env.NODE_ENV': '"development"' },
})
fs.writeFileSync(path.join(root, 'probe.html'),
  '<!doctype html><meta charset="utf-8"><title>composition</title>'
  + '<body><div id="root"></div><script src="/probe.js"></script></body>')

const out = path.join(root, 'result.json')
const exe = createRequire(import.meta.url)('electron')
const env = {
  ...process.env,
  PROBE_OUT: out,
  PROBE_ROOT: root,
  ORGTREE_DATA: path.join(root, 'data'),
  HOME: path.join(root, 'home'),
}
// ⚠ or you get Node rather than Electron, and the failure is confusing
delete env.ELECTRON_RUN_AS_NODE
const r = spawnSync(exe, [path.join(root, 'main.cjs')],
  { env, encoding: 'utf8', timeout: 240000, windowsHide: true })
console.error('electron status', r.status, r.signal ?? '', String(r.error ?? ''))
if (r.stderr) console.error('--- stderr ---\n' + r.stderr.slice(-4000))
if (fs.existsSync(out + '.log')) console.error('--- main log ---\n' + fs.readFileSync(out + '.log', 'utf8'))
if (!fs.existsSync(out)) { console.log('NO RESULT FILE'); process.exitCode = 1 }
else {
  const result = JSON.parse(fs.readFileSync(out, 'utf8'))
  console.log(JSON.stringify(result, null, 2))
  // ⚠ RECORDING ROWS ARE NOT ASSERTIONS. F4 carries a measurement of a
  // known-open defect and stays green either way, so the exit status is
  // decided by the rows that COULD have failed — and the summary prints both
  // numbers so "26 passing" is never read as 26 things that could have.
  const s = result.summary
  const rows = result.checks ?? []
  const failed = rows.filter((c) => !c.ok && !c.recording)
  if (s) console.error(`checks ${s.total} = ${s.assertions} assertions + ${s.recordings} recording; failing ${s.failing}`)
  process.exitCode = failed.length || !rows.length ? 1 : 0
}
