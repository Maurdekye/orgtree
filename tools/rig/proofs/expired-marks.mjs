// Proof: an expired account limit mark (docket
// expired-account-limit-marks-stay-on-the-account-c). The user's claude-5 card
// still read "default limited until 10/9/2026, 6:10:00 PM" a day after the
// limit ran out, and orgtree_account_mark clear answered "expired" and wrote
// nothing, so the mark could never go.
//   1. Marks seeded in the scratch DB, as the engine writes them: account B
//      with only an expired `default` (five_hour) mark, account C with an
//      expired `default` and a `fable` mark still in force.
//   2. The account list's standing carries only marks still in force: B is
//      ready with no marks, C is limited by its fable mark alone.
//   3. inspect still lists the expired mark as `expired`; clearing it (the
//      app route for B, the agent tool for C) deletes it, audited, with
//      was_expired; C's fable mark stays.
//   4. A clear with a stale fingerprint still answers `changed`, writing nothing.
// The hourly prune of marks a day past their horizon runs in the usage loop,
// which a rig engine does not run; it is not proved here.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/expired-marks.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

function claudeHome(dir, email) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{}')
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  return dir
}

/** a tool answer's JSON (the rig tool route answers `{ ok, text, json }`) */
function body(r) {
  if (r?.json) return r.json
  try { return JSON.parse(r?.text ?? '') } catch { return r ?? {} }
}

export default async function (rig) {
  const p = new Proof('expired-marks')
  const add = async (name, email) => (await rig.api('POST', '/api/accounts', { provider: 'claude', kind: 'imported',
    path: claudeHome(path.join(rig.data, 'rig-home', name), email) })).id
  const B = await add('claude-b', 'rig-b@example.invalid')
  const C = await add('claude-c', 'rig-c@example.invalid')

  // ---------------------------------------------------------------- 1. seed
  rig.exec(`INSERT INTO ot.account_marks (account, pool, until, provenance, win, at) VALUES
    ('${B}', 'default', now() - interval '18 hours', 'observed', 'five_hour', now() - interval '23 hours'),
    ('${C}', 'default', now() - interval '18 hours', 'observed', 'five_hour', now() - interval '23 hours'),
    ('${C}', 'fable', now() + interval '2 hours', 'observed', 'weekly', now() - interval '1 hour')`)
  // adding an account reloads the registry, marks included
  await add('claude-d', 'rig-d@example.invalid')

  // ---------------------------------------------------------------- 2. standing
  const list = await rig.api('GET', '/api/accounts')
  const rows = Array.isArray(list) ? list : list.accounts ?? list.rows ?? []
  const row = id => rows.find(r => r.id === id)
  p.check('B: only an expired mark — ready, no mark in its standing',
    row(B)?.standing?.state === 'ready' && Object.keys(row(B)?.standing?.marks ?? {}).length === 0, row(B)?.standing)
  p.check('C: limited by the fable mark alone; the expired default is not shown',
    row(C)?.standing?.state === 'limited' && JSON.stringify(Object.keys(row(C)?.standing?.marks ?? {})) === '["fable"]',
    row(C)?.standing)
  const usage = await rig.api('GET', `/api/accounts/${B}/usage`)
  p.check("B's usage readout (the card's standing) carries no mark", Object.keys(usage?.standing?.marks ?? {}).length === 0,
    usage?.standing)

  // ---------------------------------------------------------------- 3. inspect + clear
  const inspectB = await rig.api('GET', `/api/accounts/${B}/marks`)
  const markB = inspectB.marks?.find(m => m.pool === 'default')
  p.check('inspect still lists the expired mark as expired', markB?.state === 'expired' && markB?.window === 'five_hour', inspectB)
  const stale = await rig.api('POST', `/api/accounts/${B}/marks/clear`, { pool: 'default',
    expected: { ...markB.expected, until: markB.expected.until + 60 }, reason: 'rig: a stale fingerprint' })
  p.check('a clear with a stale fingerprint answers changed and writes nothing',
    stale.result === 'changed' && rig.one(`SELECT count(*)::int AS n FROM ot.account_marks WHERE account = '${B}'`).n === 1, stale)
  const clearB = await rig.api('POST', `/api/accounts/${B}/marks/clear`, { pool: 'default', expected: markB.expected,
    reason: 'rig: the limit ran out yesterday' })
  p.check('app clear of the expired mark deletes it (was_expired)', clearB.result === 'cleared' && clearB.was_expired === true
    && rig.one(`SELECT count(*)::int AS n FROM ot.account_marks WHERE account = '${B}'`).n === 0, clearB)
  p.check('the clear is audited', rig.one(`SELECT count(*)::int AS n FROM ot.account_mark_audit WHERE account = '${B}' AND pool = 'default'`).n === 1)

  const inspectC = body(await rig.tool('boss', 'orgtree_account_mark', { action: 'inspect', account: C }))
  const entries = inspectC.marks ?? inspectC.entries ?? []
  const markC = entries.find(m => m.pool === 'default')
  p.check('agent inspect lists C\'s expired default mark', markC?.state === 'expired', inspectC)
  const clearC = body(await rig.tool('boss', 'orgtree_account_mark', { action: 'clear', account: C, pool: 'default',
    source: markC?.source ?? 'registry', expected: markC?.expected, reason: 'rig: the limit ran out yesterday' }))
  const left = rig.sql(`SELECT pool FROM ot.account_marks WHERE account = '${C}' ORDER BY pool`).map(r => r.pool)
  p.check('agent clear deletes the expired mark and keeps the fable mark in force',
    clearC.result === 'cleared' && JSON.stringify(left) === '["fable"]', { clearC, left })

  const after = await rig.api('GET', '/api/accounts')
  const afterRows = Array.isArray(after) ? after : after.accounts ?? after.rows ?? []
  const c2 = afterRows.find(r => r.id === C)
  p.check('after the clears C still reads limited by fable', c2?.standing?.state === 'limited'
    && JSON.stringify(Object.keys(c2?.standing?.marks ?? {})) === '["fable"]', c2?.standing)

  const result = p.summary()
  if (!result.passed) throw Error(JSON.stringify(result))
  return result
}
