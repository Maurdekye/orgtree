// Proof: the live "compacting" desk row (docket show-a-live-compacting-for-xs-event-while-an-age).
// A harness that reports a compaction's start and end gets ONE desk row: it appears
// at the start (running, timed from the engine's receipt of the start) and becomes
// the finished record at the end. Nothing is invented.
//   cal (Claude): system status "compacting", a wait, status null + compact_boundary:
//     the row is running during the wait, then done with a start, an end and the size.
//   cat (Claude): compact_boundary alone (no start reported): one finished row, no
//     start time, no end time.
//   cox (Codex): item/started + item/completed contextCompaction then thread/compacted:
//     one row (not two), one notice.
//   cif (Claude): compaction fails (status null, compact_result failed): row "failed".
//   cdi (Claude): the CLI dies during the compaction: row "interrupted", no end time.
//   cam (Claude): the ENGINE is killed during the compaction: after the restart the
//     row is "interrupted" (it must not stay running forever).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/compaction-live.mjs

import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('compaction-live')
  const start = { system: { subtype: 'status', status: 'compacting' } }
  rig.scenario({
    agents: {
      cal: { turns: [{ name: 'live', match: 'PROOF-LIVE', once: true, steps: [
        start, { sleep_ms: 2500 },
        { system: { subtype: 'status', status: null, compact_result: 'success' } },
        { system: { subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } } },
        { text: 'Done compacting.' },
      ] }] },
      cat: { turns: [{ name: 'bare', match: 'PROOF-BARE', once: true, steps: [
        { system: { subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 70000 } } },
        { text: 'Done.' },
      ] }] },
      cox: { turns: [{ name: 'codex', match: 'PROOF-CODEX', once: true, steps: [
        { raw: { jsonrpc: '2.0', method: 'item/started', params: { threadId: '', turnId: '', item: { id: 'cc1', type: 'contextCompaction' } } } },
        { sleep_ms: 1500 },
        { raw: { jsonrpc: '2.0', method: 'item/completed', params: { threadId: '', turnId: '', item: { id: 'cc1', type: 'contextCompaction' } } } },
        { raw: { jsonrpc: '2.0', method: 'thread/compacted', params: { threadId: '', turnId: '' } } },
        { text: 'Still here.' },
      ] }] },
      cif: { turns: [{ name: 'fail', match: 'PROOF-FAIL', once: true, steps: [
        start, { sleep_ms: 500 },
        { system: { subtype: 'status', status: null, compact_result: 'failed' } },
        { text: 'It failed.' },
      ] }] },
      cdi: { turns: [{ name: 'die', match: 'PROOF-DIE', once: true, steps: [start, { sleep_ms: 500 }, { exit: 1 }] }] },
      cam: { turns: [{ name: 'crash', match: 'PROOF-CRASH', once: true, steps: [start, { sleep_ms: 120000 }] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  for (const [name, tier] of [['cal', 'haiku'], ['cat', 'haiku'], ['cox', 'luna'], ['cif', 'haiku'], ['cdi', 'haiku'], ['cam', 'haiku']]) {
    await rig.op({ op: 'hire', name, parent: 'boss', tier, title: 'Compaction agent' })
  }
  const id = name => rig.agentRow(name).id
  const rows = name => rig.sql(`SELECT body FROM ot.convo WHERE agent_id = ${id(name)} ORDER BY seq`).map(r => r.body).filter(b => b.kind === 'compact')
  const notices = (to, about) => rig.sql(`SELECT 1 FROM ot.mail WHERE recipient_agent_id = ${id(to)}
    AND ev->>'variant' = 'lifecycle.compacted' AND body LIKE '%${about}%'`)
  const ms = s => Date.parse(s)

  // ---------------------------------------------------------------- cal: start, wait, end
  await rig.userMail('cal', 'PROOF-LIVE: read everything.')
  const running = await rig.waitFor(() => rows('cal').find(b => b.compact_state === 'running'), { what: 'cal row to be running', timeout: 20000 }).catch(() => null)
  p.check('cal: while compacting there is one running row with a start time and no end time',
    !!running && typeof running.compact_started_at === 'string' && running.compact_ended_at === undefined && running.text === 'Compacting context', running)
  const [calTurn] = await rig.waitTurns('cal', 1)
  const done = rows('cal')
  p.check('cal: the same row becomes the finished record: one row, done, start before end, the size before',
    done.length === 1 && done[0].compact_state === 'done' && done[0].text === 'Context compacted' && done[0].pre_tokens === 150000
    && ms(done[0].compact_ended_at) - ms(done[0].compact_started_at) >= 2000, done)
  p.check('cal: the turn completes and the notice is sent once', !calTurn.error && notices('boss', 'cal').length === 1, calTurn.error)

  // ---------------------------------------------------------------- cat: an end with no reported start
  await rig.userMail('cat', 'PROOF-BARE: read everything.')
  await rig.waitTurns('cat', 1)
  const bare = rows('cat')
  p.check('cat: an end alone gives one finished row with no start and no end time (nothing invented)',
    bare.length === 1 && bare[0].text === 'Context compacted' && bare[0].compact_started_at === undefined
    && bare[0].compact_ended_at === undefined && bare[0].compact_state === undefined, bare)

  // ---------------------------------------------------------------- cox: Codex item, then thread/compacted
  await rig.userMail('cox', 'PROOF-CODEX: a long thread.')
  await rig.waitTurns('cox', 1)
  const cx = rows('cox')
  p.check('cox: the compaction item and thread/compacted give one done row with a start and an end',
    cx.length === 1 && cx[0].compact_state === 'done' && !!cx[0].compact_started_at && !!cx[0].compact_ended_at, cx)
  p.check('cox: the notice is sent once', notices('boss', 'cox').length === 1, notices('boss', 'cox').length)

  // ---------------------------------------------------------------- cif: the compaction fails
  await rig.userMail('cif', 'PROOF-FAIL: read everything.')
  await rig.waitTurns('cif', 1)
  const cf = rows('cif')
  p.check('cif: a failed compaction closes the row as failed, with its end', cf.length === 1 && cf[0].compact_state === 'failed'
    && !!cf[0].compact_ended_at && notices('boss', 'cif').length === 0, cf)

  // ---------------------------------------------------------------- cdi: the CLI dies
  await rig.userMail('cdi', 'PROOF-DIE: read everything.')
  const di = await rig.waitFor(() => rows('cdi').find(b => b.compact_state === 'interrupted'), { what: 'cdi row to be interrupted', timeout: 30000 }).catch(() => null)
  p.check('cdi: the CLI dying mid-compaction closes the row as interrupted, with a start and no end',
    !!di && !!di.compact_started_at && di.compact_ended_at === undefined, rows('cdi'))

  // ---------------------------------------------------------------- cam: the engine is killed
  await rig.userMail('cam', 'PROOF-CRASH: read everything.')
  const live = await rig.waitFor(() => rows('cam').find(b => b.compact_state === 'running'), { what: 'cam row to be running', timeout: 20000 }).catch(() => null)
  p.check('cam: the row is running before the crash', !!live, rows('cam'))
  await rig.crash()
  await rig.restart()
  const after = rows('cam')
  p.check('cam: after the engine restarts the row is interrupted (nothing ticks forever), still no end time',
    after.length === 1 && after[0].compact_state === 'interrupted' && after[0].compact_ended_at === undefined
    && after[0].text === 'Context compaction interrupted', after)

  p.keep(rig, { agents: ['cal', 'cat', 'cox', 'cif', 'cdi', 'cam'], grep: /compact/ })
  return p.summary()
}
