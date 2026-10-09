// Proof: presence through the real engine and the hub it hosts (hub v2.0.2;
// docket hubchat-shows-an-org-as-online-while-its-orgtree). An org whose
// engine stops polling shows offline to a Hubchat-style watcher within the
// hub's 10 s grace, and online again as soon as it polls.
//   stop   the Connections toggle (auto-connect off) takes this computer's
//          hub out of A's list; the engine cancels A's poller, dropping its
//          parked long poll: the same cancellation an engine shutdown makes
//          (every poller's token is a child of the engine's shutdown token)
//   watch  a person registered over HTTP with one device reported in use
//          (POST /api/devices/active), parked in /api/sync (wait 55) as
//          Hubchat parks: when does an answer stop listing A? when does the
//          hub's roster say A is offline?
//   back   auto-connect on again: when does the watcher hear A is back?
// Times are taken from the engine's own log (when its poller ended) and the
// hub's request log (A's first poll back), so the engine's reaction to the
// toggle is reported apart from the hub's behaviour.
// A process kill can't be shown here: the hosted hub is the engine's child
// and dies with it, and a rig engine reaches no other hub. The hub's side of
// a kill (the connection closes) is the same hang-up; see the hub's
// tools/verify-docker.py and its scratch probe.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/presence.mjs --hub <orgtree-mailhub.exe> [--before]
//   --before: a hub older than v2.0.2; the times are reported, not judged

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export async function setup(flags) {
  return { hub: flags.hub ?? true }
}

const hex = n => crypto.randomBytes(n).toString('hex')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const s1 = ms => (ms === null ? null : Math.round(ms / 100) / 10)

/** When the engine's pollers ended (their parked poll dropped): its log,
 * local time, lines like `[2026-10-10 02:20:47.770270] T122 EX… net.poller(...) [3824.208 ms] -> ()`. */
function pollerEnds(rig) {
  const dir = path.join(rig.run.data, 'diagnostics', 'logs')
  const out = []
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.log')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const m = /\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3})\d*\] \S+ \S+ net\.poller\(\.\.\.\) \[[\d.]+ ms\] -> \(\)/.exec(line)
      if (m) out.push(new Date(`${m[1]}T${m[2]}`).getTime())
    }
  }
  return out
}

/** When the hub answered polls of `slug` (its request log, UTC). */
function hubPolls(rig, slug) {
  return fs.readFileSync(path.join(rig.run.data, 'mailhub', 'hub.log'), 'utf8').split('\n')
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(j => j && j.path === '/api/poll' && (j.slugs ?? []).includes(slug))
    .map(j => Date.parse(j.ts))
}

export default async function (rig, { flags }) {
  const before = !!flags.before
  const p = new Proof(before ? 'presence-before' : 'presence')
  rig.scenario({ default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 90000 })
  const A = rig.org
  const hub = rig.hubUrl
  const call = async (method, route, auth, body, timeoutMs = 90000) => {
    const res = await fetch(hub + route, {
      method, headers: { 'X-Org-Auth': auth, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }

  await rig.waitFor(async () => (await rig.api('GET', '/api/desktop/hub')).status?.healthy || null, { what: 'the hosted hub to answer', timeout: 120000 })
  const health = await (await fetch(`${hub}/healthz`)).json()
  p.note(`hosted hub version ${health.version}`, { version: health.version })

  // A connects: the Connections toggle adds this computer's hub to its list
  await rig.api('POST', `/api/orgs/${A}/settings`, { net_autoconnect: true })
  const aSlug = await rig.waitFor(async () => {
    const t = await rig.api('GET', `/api/orgs/${A}`)
    return (t.net?.hubs ?? []).some(h => h.connected) ? rig.one(`SELECT net->'identity'->>'slug' AS s FROM ot.orgs WHERE slug = '${A}' AND state = 'active'`).s : null
  }, { what: 'A to connect to the hosted hub', timeout: 90000 })

  // the watcher, as Hubchat: a person, one device in use, a parked sync
  const w = { slug: `watcher.rig.${hex(3)}`, secret: hex(16) }
  const wAuth = `${w.slug}:${w.secret}`
  const reg = await call('POST', '/api/register', wAuth, { slug: w.slug, org_name: 'Watcher', username: 'w', kind: 'person' })
  let cursor = null
  for (;;) {
    const s = await call('POST', '/api/sync', wAuth, cursor ? { device_id: 'w-desk', cursor, wait: 0 } : { device_id: 'w-desk', wait: 0 })
    cursor = s.json?.cursor
    if (!s.json?.more) break
  }
  const act = await call('POST', '/api/devices/active', wAuth, { device_id: 'w-desk', active: true })
  const online = async slug => (await call('GET', '/api/roster', wAuth)).json?.roster?.find(r => r.slug === slug)?.online === true
  p.check('A (the real engine\'s long poll) and the watcher (a person with a device in use) are on the hosted hub; A shows online',
    reg.status === 200 && act.status === 200 && await online(aSlug), { a: aSlug, watcher: w.slug, register: reg.status, active: act.status })

  /** Park the watcher's sync until an answer says `want` (A listed or not):
   * when that answer came (ms since the epoch), or null. */
  const hear = async (want, limitMs) => {
    const end = Date.now() + limitMs
    for (;;) {
      const left = end - Date.now()
      if (left <= 0) return null
      const s = await call('POST', '/api/sync', wAuth, { device_id: 'w-desk', cursor, wait: Math.min(55, Math.ceil(left / 1000)) }, left + 30000)
      cursor = s.json?.cursor ?? cursor
      if (Array.isArray(s.json?.online) && s.json.online.includes(aSlug) === want) return Date.now()
    }
  }
  const rosterFlip = async (want, limitMs) => {
    const end = Date.now() + limitMs
    while (Date.now() < end) {
      if (await online(aSlug) === want) return Date.now()
      await sleep(250)
    }
    return null
  }

  // ------------------------------------------------------------------ stop
  const limit = before ? 170000 : 60000
  const ended = pollerEnds(rig).length
  const heardOffP = hear(false, limit)
  await sleep(300)
  const tOff = Date.now()
  await rig.api('POST', `/api/orgs/${A}/settings`, { net_autoconnect: false })
  const [heardOff, rosterOff] = await Promise.all([heardOffP, rosterFlip(false, limit)])
  const hangUp = await rig.waitFor(() => pollerEnds(rig)[ended] ?? null, { what: 'the engine to end A\'s poller', timeout: 30000 })
  const stop = {
    engine_s: s1(hangUp - tOff), offline_after_hang_up_s: s1(rosterOff && rosterOff - hangUp),
    watcher_after_hub_s: s1(heardOff && rosterOff && heardOff - rosterOff),
    from_toggle: { roster_s: s1(rosterOff && rosterOff - tOff), watcher_s: s1(heardOff && heardOff - tOff) },
  }
  p.note(`stop: the engine dropped A's poll ${stop.engine_s} s after the toggle; the hub showed A offline ${stop.offline_after_hang_up_s} s after that; the watcher heard ${stop.watcher_after_hub_s} s after the hub (from the toggle: ${stop.from_toggle.roster_s} s, watcher ${stop.from_toggle.watcher_s} s)`, stop)
  if (!before) {
    p.check('stop: the hub shows A offline after its 10 s grace from the engine dropping its poll', stop.offline_after_hang_up_s !== null && stop.offline_after_hang_up_s >= 9.5 && stop.offline_after_hang_up_s <= 11.5, stop)
    p.check('stop: the watcher\'s parked sync (device in use) hears it within about a second of the hub', stop.watcher_after_hub_s !== null && stop.watcher_after_hub_s <= 1.5, stop)
  }

  // ------------------------------------------------------------------ back
  const polls = hubPolls(rig, aSlug).length
  const heardOnP = hear(true, before ? 120000 : 30000)
  await sleep(300)
  const tOn = Date.now()
  await rig.api('POST', `/api/orgs/${A}/settings`, { net_autoconnect: true })
  const heardOn = await heardOnP
  const polled = await rig.waitFor(() => hubPolls(rig, aSlug)[polls] ?? null, { what: 'A\'s first poll back', timeout: 30000 })
  const back = { engine_s: s1(polled - tOn), watcher_after_poll_s: s1(heardOn && heardOn - polled), from_toggle_s: s1(heardOn && heardOn - tOn) }
  p.note(`back: the engine polled ${back.engine_s} s after the toggle; the watcher heard A online ${back.watcher_after_poll_s} s after that poll (from the toggle: ${back.from_toggle_s} s)`, back)
  if (!before) {
    p.check('back: the watcher hears A online within about a second of its first poll (the hub wakes the device in use)',
      back.watcher_after_poll_s !== null && back.watcher_after_poll_s <= 1.5, back)
  }

  p.keep(rig, { grep: /hub|network|poll/i })
  return p.summary()
}
