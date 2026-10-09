// How often the engine reads each provider's usage, measured from the rig's
// call log (rig-usage/calls.log: one line per reading asked for, written by
// the canned-reading stand-in for a probe). Phase 1: no window open. Phase 2:
// a window holds the app feed open. 3.x kept a window's readings a minute old.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '../desktop.mjs'
import { rigHome } from '../lib.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Usage cadence' },
    agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

const SPAN = 130000
const HOLD = 100000
const sleep = ms => new Promise(r => setTimeout(r, ms))

export default async function (rig) {
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turn complete', timeout: 60000 })
  const dir = path.join(rig.data, 'rig-home', 'rig-usage')
  fs.mkdirSync(dir, { recursive: true })
  const future = new Date(Date.now() + 3 * 3600e3).toISOString()
  for (const lane of ['claude', 'openai', 'google'])
    fs.writeFileSync(path.join(dir, `${lane}.json`), JSON.stringify({ available: true, limits: [
      { kind: 'usage', group: 'session', percent: 10, resets_at: future }] }))
  const log = path.join(dir, 'calls.log')
  const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter(Boolean)
    .map(l => { const [t, lane] = l.split(' '); return { t: +t, lane } })
  const summarize = (from, to) => {
    const out = {}
    for (const lane of ['claude', 'openai', 'google']) {
      const ts = read().filter(c => c.lane === lane && c.t >= from && c.t < to).map(c => c.t)
      out[lane] = { calls: ts.length, gapsSec: ts.slice(1).map((t, i) => Math.round((t - ts[i]) / 1000)) }
    }
    return out
  }
  const t0 = Date.now()
  await sleep(SPAN)
  const idle = summarize(t0, Date.now())
  console.error('idle phase: ' + JSON.stringify(idle))
  const t1 = Date.now()
  const res = await runDesktop(rig, path.join(path.dirname(fileURLToPath(import.meta.url)), '../desktop/hold-open.cjs'),
    { out: path.join(rigHome(), 'evidence', 'usage-cadence-' + Date.now()), args: { ms: HOLD }, timeout: HOLD + 150000 })
  if (!res.ok) throw Error(JSON.stringify(res).slice(0, 800))
  const windowOpen = summarize(t1 + 50000, Date.now())   // after the page has loaded and held the feed
  return { ok: true, spanSec: SPAN / 1000, idle, windowOpen }
}
