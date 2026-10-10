// Proof: the usage history panel (docket
// track-usage-over-time-and-show-usage-analytics, phase 2) through the real
// engine route and the real renderer.
//   1. An empty install: /api/usage/history answers with no series and no
//      oldest reading, and the panel says there is no history instead of
//      drawing a 0 line. (The rig's browser has no native bridge, so it gets
//      the browser header and opens the panel from the button beside Usage;
//      the Orgtree menu entry is covered by tests/usagehistory.test.tsx §2.3.)
//   2. Seeded history (rig engines serve canned readings and never record, so
//      rows go straight into ot.usage_history, shaped as the recorder writes
//      them): two Claude logins and OpenRouter over 7 days, with a weekly
//      reset, 5-hour session resets, a 12-hour hole where the engine was
//      off, and a span where login B was unavailable.
//      The route downsamples per series (bounded bucket count), sends the
//      reset rows and B's availability changes; the panel draws one chart per
//      series grouped by account, breaks lines only at resets (joined across
//      the hole and the unavailable span, nothing marks them: user 2026-10-10),
//      shows the projection and the next-reset lines.
//   3. The recorder, with a secondary account present: canned readings for
//      the default Claude, Codex and Antigravity sign-ins and for a second
//      Claude and a second Codex login go through the real probes (the routes
//      the Usage window reads); every one of them lands in ot.usage_history -
//      the default sign-ins under claude/primary, openai/primary and
//      google/primary, labelled by their email - and the panel shows each
//      account.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/usage-history.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'

const MIN = 60e3
const ago = m => new Date(Date.now() - m * MIN).toISOString()
const sq = v => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)

function claudeHome(dir, email) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{}')
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  return dir
}

/** the seeded rows, as the phase-1 recorder writes them */
function seedRows(A, B) {
  const rows = []
  const row = (m, account, provider, win, fields) => rows.push({ observed_at: ago(m), account, provider, win,
    grp: fields.grp ?? win, model: fields.model ?? '', event: fields.event ?? 'reading', state: fields.state ?? 'ok',
    used_pct: fields.pct ?? null, amount: fields.amount ?? null, unit: fields.unit ?? null,
    resets_at: fields.resets ?? null, prev_pct: fields.prev ?? null, label: fields.label ?? null, detail: fields.detail ?? null })
  const WEEK = 7 * 24 * 60
  const engineOff = m => m > 2.5 * 24 * 60 && m < 2.5 * 24 * 60 + 12 * 60   // a 12-hour hole, every series
  // A, weekly: reset 5.8 days ago (80 % → 2 %), now 55 %, next reset in 1.2 days
  const wReset = 5.8 * 24 * 60
  for (let m = WEEK; m >= 5; m -= 20) {
    if (engineOff(m)) continue
    const before = m > wReset
    const pct = before ? 60 + 20 * (WEEK - m) / (WEEK - wReset) : 2 + 53 * (wReset - m) / wReset
    row(m, A, 'claude', 'weekly_all', { pct: +pct.toFixed(1), resets: before ? ago(wReset) : ago(-1.2 * 24 * 60),
      label: 'Current week (all models)' })
    if (before && m - 20 <= wReset) row(wReset, A, 'claude', 'weekly_all', { event: 'reset', pct: 2, prev: 80, resets: ago(-1.2 * 24 * 60), label: 'Current week (all models)' })
  }
  // A, session: 5-hour windows over the last 30 hours, the current one 2 h in
  for (let m = 30 * 60; m >= 5; m -= 10) {
    const into = (((120 - m) % 300) + 300) % 300            // minutes into its window
    const start = m + into
    const pct = Math.min(100, into * 0.22 + (Math.floor(start / 300) % 2) * into * 0.1)
    row(m, A, 'claude', 'session', { pct: +pct.toFixed(1), resets: ago(start - 300), label: 'Current session' })
    if (into < 10 && m < 30 * 60 - 10) row(m, A, 'claude', 'session', { event: 'reset', pct: +pct.toFixed(1), prev: 60, resets: ago(start - 300), label: 'Current session' })
  }
  // B: weekly 10 → 35 % (next reset in 3 days), Fable-scoped 0 → 20 %; unavailable 4 to 3.6 days ago
  const bDown = [4 * 24 * 60, 3.6 * 24 * 60]
  row(WEEK + 30, B, 'claude', '', {})
  row(bDown[0], B, 'claude', '', { state: 'unavailable', detail: 'usage service answered 401: the sign-in has expired' })
  row(bDown[1], B, 'claude', '', {})
  for (let m = WEEK; m >= 5; m -= 30) {
    if (engineOff(m) || (m < bDown[0] && m > bDown[1])) continue
    const t = (WEEK - m) / WEEK
    row(m, B, 'claude', 'weekly_all', { pct: +(10 + 25 * t).toFixed(1), resets: ago(-3 * 24 * 60), label: 'Current week (all models)' })
    row(m, B, 'claude', 'weekly_scoped', { model: 'Fable', pct: +(20 * t * t).toFixed(1), resets: ago(-3 * 24 * 60), label: 'Current week (Fable)' })
  }
  // OpenRouter: a prepaid balance spent from $25.00 to $18.57
  for (let m = WEEK; m >= 5; m -= 60) {
    if (engineOff(m)) continue
    row(m, 'openrouter', 'openrouter', 'credits', { grp: '', amount: +(25 - 6.43 * (WEEK - m) / WEEK).toFixed(2), unit: 'USD' })
  }
  return rows
}

export default async function (rig) {
  const p = new Proof('usage-history')
  const page = fileURLToPath(new URL('../desktop/usage-history.cjs', import.meta.url))

  // ---------------------------------------------------------------- 1. empty install
  const before = rig.one('SELECT count(*)::int AS n FROM ot.usage_history')
  p.check('a fresh rig install has no usage history', before.n === 0, before)
  const empty = await rig.api('GET', '/api/usage/history?range=7d')
  p.check('empty: the route answers no series, no resets, no oldest reading',
    empty.series?.length === 0 && empty.resets?.length === 0 && empty.oldest === null, empty)
  const bad = await rig.api('GET', '/api/usage/history?range=1y').catch(e => ({ error: e.message }))
  p.check('an unknown period is refused', !!bad.error, bad)
  if (rig.run.ui) {
    const ui = await runDesktop(rig, page, { preset: 'wide', out: path.join(p.dir, 'desktop-empty'),
      args: { shots: [{ name: 'empty-install' }] } })
    const s = ui.value?.shots?.[0]
    p.check('empty: the panel says there is no history and draws no chart',
      ui.ok && /No usage history yet/.test(s?.text ?? '') && s.cards === 0, s ?? ui)
  }

  // ---------------------------------------------------------------- 2. seeded history
  const B = (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'imported',
    path: claudeHome(path.join(rig.data, 'rig-home', 'claude-b'), 'rig-b@example.invalid') })).id
  const A = 'claude/primary'
  const rows = seedRows(A, B)
  const cols = ['observed_at', 'account', 'provider', 'win', 'grp', 'model', 'event', 'state', 'used_pct', 'amount',
    'unit', 'resets_at', 'prev_pct', 'label', 'detail']
  for (let i = 0; i < rows.length; i += 80) {
    const values = rows.slice(i, i + 80).map(r => `(${cols.map(c => sq(r[c])).join(',')})`).join(',')
    rig.exec(`INSERT INTO ot.usage_history (${cols.join(',')}) VALUES ${values}`)
  }
  p.note('seeded', { rows: rows.length, A, B })

  const week = await rig.api('GET', '/api/usage/history?range=7d')
  const find = (acct, win, model = '') => week.series.find(s => s.account === acct && s.window === win && s.model === model)
  p.check('7d: five series across three accounts', week.series.length === 5
    && new Set(week.series.map(s => s.account)).size === 3, week.series.map(s => `${s.account}/${s.window}/${s.model}`))
  const maxPoints = Math.max(...week.series.map(s => s.points.length))
  p.check('7d: downsampled in the database (at most ~255 buckets a series)', maxPoints <= 255 && week.bucket_s === 2400,
    { maxPoints, bucket_s: week.bucket_s })
  const aw = find(A, 'weekly_all')
  p.check('7d: A weekly is a percent series whose latest reading is 55 % with its next reset',
    aw?.kind === 'percent' && Math.abs(aw.latest.used_pct - 55) < 1 && !!aw.latest.resets_at, aw?.latest)
  p.check('7d: the weekly reset is sent with its previous reading', week.resets.some(r => r.account === A
    && r.window === 'weekly_all' && r.prev_pct === 80 && r.used_pct === 2), week.resets.filter(r => r.window === 'weekly_all'))
  const holeStart = Date.now() - (2.5 * 24 * 60 + 12 * 60) * MIN
  const holeEnd = Date.now() - 2.5 * 24 * 60 * MIN
  p.check('7d: no bucket lies inside the 12-hour hole (nothing is invented there)', week.series.every(s => s.points.every(b =>
    Date.parse(b.t1) < holeStart + MIN || Date.parse(b.t0) > holeEnd - MIN)))
  p.check("7d: B's unavailable span is sent as availability changes",
    week.states.some(s => s.account === B && s.state === 'unavailable' && /401/.test(s.detail ?? ''))
    && week.states.filter(s => s.account === B).at(-1)?.state === 'ok', week.states)
  const orr = find('openrouter', 'credits')
  p.check('7d: the OpenRouter balance is an amount in USD', orr?.kind === 'amount' && orr.unit === 'USD', orr && { kind: orr.kind, unit: orr.unit, latest: orr.latest })
  const day = await rig.api('GET', '/api/usage/history?range=24h')
  p.check('24h: 5-minute buckets, session resets in the period', day.bucket_s === 300
    && day.resets.filter(r => r.window === 'session').length >= 4, { bucket_s: day.bucket_s, resets: day.resets.length })
  // ---------------------------------------------------------------- 3. the recorder
  const usageDir = path.join(rig.data, 'rig-home', 'rig-usage')
  fs.mkdirSync(usageDir, { recursive: true })
  const put = (name, r) => fs.writeFileSync(path.join(usageDir, `${name}.json`), JSON.stringify(r))
  const later = h => new Date(Date.now() + h * 3600e3).toISOString()
  // the default login's reading continues its seeded windows (same reset
  // times, a little higher), so it is not recorded as a reset
  const claudeReading = (session, weekly, email, weekReset = 72) => ({ available: true, email, limits: [
    { kind: 'session', group: 'session', percent: session, resets_at: later(3), is_active: false, model: null },
    { kind: 'weekly_all', group: 'weekly_all', percent: weekly, resets_at: later(weekReset), is_active: true, model: null },
  ] })
  const codexReading = (five, week, email) => ({ available: true, label: email, email, limits: [
    { kind: 'session', group: 'primary', percent: five, resets_at: later(4), label: '5 h' },
    { kind: 'weekly_all', group: 'secondary', percent: week, resets_at: later(100), label: '7 d' },
  ] })
  const C = (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'imported',
    path: claudeHome(path.join(rig.data, 'rig-home', 'claude-c'), 'rig-c@example.invalid') })).id
  const homeD = path.join(rig.data, 'rig-home', 'codex-d')
  fs.mkdirSync(homeD, { recursive: true })
  const D = (await rig.api('POST', '/api/accounts', { provider: 'openai', kind: 'imported', path: homeD })).id
  put('claude', claudeReading(40, 56, 'rig-primary@example.invalid', 1.2 * 24))
  put('claude@claude-c', claudeReading(7, 59, 'rig-c@example.invalid'))
  put('openai', codexReading(5, 30, 'rig-codex@example.invalid'))
  put('openai@codex-d', codexReading(40, 92, 'rig-codex-d@example.invalid'))
  put('google', { available: true, email: 'rig-agy@example.invalid', label: 'rig-agy@example.invalid', limits: [
    { kind: 'usage', group: 'gemini-5h', percent: 25, resets_at: later(2), label: 'Gemini 5 h' }] })
  await rig.api('GET', '/api/usage?force=true')
  await rig.api('GET', '/api/codex/usage?force=true')
  await rig.api('GET', '/api/antigravity/usage?force=true')
  await rig.api('GET', `/api/accounts/${C}/usage?force=true`)
  await rig.api('GET', `/api/accounts/${D}/usage?force=true`)
  const recorded = rig.sql(`SELECT account, provider, count(*)::int AS n, max(label) FILTER (WHERE win = '') AS label
    FROM ot.usage_history WHERE observed_at > now() - interval '10 minutes' AND event = 'reading' GROUP BY account, provider ORDER BY account`)
  const got = Object.fromEntries(recorded.map(r => [r.account, r]))
  p.check('recorder: every signed-in account is recorded, the default sign-ins and the secondary ones',
    ['claude/primary', 'openai/primary', 'google/primary', C, D].every(a => got[a]?.n >= 2), recorded)
  p.check('recorder: the default sign-ins are labelled by their email',
    got['claude/primary']?.label === 'rig-primary@example.invalid' && got['openai/primary']?.label === 'rig-codex@example.invalid'
    && got['google/primary']?.label === 'rig-agy@example.invalid', recorded)
  const after = await rig.api('GET', '/api/usage/history?range=7d')
  const accts = new Set(after.series.map(s => s.account))
  p.check('route: the history now has every account (seeded and recorded)',
    ['claude/primary', 'openai/primary', 'google/primary', B, C, D, 'openrouter'].every(a => accts.has(a)), [...accts])
  const primaryLabel = after.series.find(s => s.account === 'openai/primary')?.account_label
  p.check('route: a default sign-in is named by its email, not its id', primaryLabel === 'rig-codex@example.invalid', primaryLabel)
  p.note('recorded', { C, D, recorded })

  if (rig.run.ui) {
    const ui = await runDesktop(rig, page, { preset: 'wide', out: path.join(p.dir, 'desktop-seeded'), args: { shots: [
      { name: 'seeded-7d' },
      { name: 'seeded-7d-hover-projection', hover: 0.9 },
      { name: 'seeded-24h', range: '24 hours' },
      { name: 'seeded-30d', range: '30 days' },
      { name: 'seeded-7d-account-b', range: '7 days', account: B },
    ] } })
    const [w, hov, d, m, fb] = ui.value?.shots ?? []
    p.check('7d: one chart per series, grouped by account: seven accounts, secondaries included',
      ui.ok && w?.cards === after.series.length && w?.accounts === 7, { cards: w?.cards, series: after.series.length, heads: w?.heads })
    p.check('7d: each account heading names its login', ['rig-primary@', 'rig-codex@', 'rig-agy@', 'rig-b@', 'rig-c@', 'rig-codex-d@']
      .every(e => (w?.heads ?? []).some(h => h.includes(e))), w?.heads)
    p.check('7d: lines break at resets only, resets and next-reset lines are drawn',
      w?.lines > 5 && w?.resets >= 1 && w?.nextResets >= 1, w)
    p.check('7d: no unavailable zone is marked (no hatched band anywhere)', w?.hatch === 0, w)
    p.check('seeded 7d: projections drawn and labelled', w?.projections >= 3 && /projected/.test(w?.text ?? ''), w)
    p.check('seeded 7d: stats show current, change since reset, min, max, average',
      /current/.test(w?.text) && /since reset/.test(w?.text) && /min/.test(w?.text) && /average/.test(w?.text), w?.text)
    p.check('hovering the future pane reads the projection', /projected/.test(hov?.tip ?? ''), hov?.tip)
    p.check('seeded 24h: session resets drawn', d?.resets >= 4, d)
    p.check('30d: the panel still renders every series', m?.cards === after.series.length, m)
    p.check("account filter: only B's two series, each one line joined across the 12-hour hole and B's unavailable span",
      fb?.cards === 2 && fb?.lines === 2 && fb?.hatch === 0, fb)
    const errors = (ui.value?.consoleErrors ?? []).filter(e => !/Electron Security Warning/.test(e))
    p.check('no console errors (the rig Electron CSP warning aside)', errors.length === 0, errors)
    p.note('screenshots', ui.out)
  }
  p.note('Sections 1-2 seed history by SQL (a week of it cannot be recorded live); section 3 proves the recorder itself on canned readings. The 60 s background pass over registered accounts does not run in rig mode, so secondaries are probed through their usage route.')
  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
