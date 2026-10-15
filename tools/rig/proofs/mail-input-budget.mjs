// All data and CLIs are synthetic. Use the candidate fake CLI on BOTH engines:
// it enforces Codex's observed 1,048,576-character field limit and supplies safe
// input-size receipts for Muse/ACP. No real mailbox, profiles or provider calls.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Proof } from '../proof.mjs'
import { setup as keysSetup } from './openrouter-keys.mjs'
export async function setup() { return { ...(await keysSetup()), name: 'mail-input-budget' } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const size = s => Buffer.byteLength(s ?? '', 'utf8')

export default async function (rig) {
  const p = new Proof('mail-input-budget')
  rig.scenario({ agents: {
    budgetsteer: { turns: [{ name: 'hold', match: 'STEER-HOLD', once: true,
      steps: [{ text: 'Waiting for mail.' }, { poll_mail: { every_ms: 100, timeout_ms: 20000 } }] }] },
    budgetrefuse: { turns: [{ name: 'refuse', match: 'LENGTH-REFUSE', times: 2,
      steps: [{ start_error: 'Input exceeds the maximum length of 1048576 characters' }] }] },
  }, default: { turns: [{ name: 'ok', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => !rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length,
    { what: 'seed turns settle', timeout: 60000 })
  await rig.waitFor(async () => !(await rig.api('GET', '/api/providers')).checking, { what: 'discovery', timeout: 30000 })
  await rig.api('PUT', '/api/openrouter/keys/openrouter-1', { harness: 'opencode' })
  const id = n => rig.agentRow(n).id
  const hire = async (n, tier = 'luna') => rig.op({ op: 'hire', name: n, parent: 'boss', tier, title: 'Mail budget fixture', grant: 1 })
  const hold = n => rig.op({ op: 'halt', nodes: [n] })
  const wake = n => rig.op({ op: 'unhalt', nodes: [n] })
  const wait = (fn, what, timeout = 30000) => rig.waitFor(fn, { what, timeout }).catch(() => null)
  const logs = (n, kind) => rig.fakeLog(n).filter(x => x.kind === kind)
  const delivered = uid => ['delivered', 'read'].includes(rig.one(`SELECT state FROM ot.mail WHERE uid='${uid}'`)?.state)
  const record = (n, marker) => rig.one(`SELECT uid,id FROM ot.mail WHERE recipient_agent_id=${id(n)} AND body LIKE '${marker}%' ORDER BY id DESC LIMIT 1`)
  const observed = n => {
    if (n === 'budgetoc') {
      const scratch = rig.one(`SELECT scratch_dir FROM ot.agents WHERE id=${id(n)}`).scratch_dir
      try { return fs.readFileSync(path.join(scratch, 'acp-observed.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse).at(-1) } catch { return null }
    }
    if (n === 'budgetmuse') return logs(n, 'turn_start').at(-1)
    const last = logs(n, 'turn').at(-1)
    return last && { input_text_bytes: size(last.prompt), mail_reference: last.prompt?.includes('MAIL BY REFERENCE') }
  }

  // Existing terminal failure state + giant original: the next ordinary wake
  // succeeds; no fresh session, compact, unstick or mailbox deletion is needed.
  for (const [n, tier, ceiling] of [['budgetcodex','luna',1_000_000], ['budgetclaude','haiku',262144],
    ['budgetagy','flash',262144], ['budgetmuse','wonder',262144], ['budgetoc','or-rig-fake-model',262144]]) {
    await hire(n, tier)
    await rig.userMail(n, 'GIANT-SEED', { notice: true })
    const row = record(n, 'GIANT-SEED')
    rig.exec(`UPDATE ot.mail SET body='GIANT-ORIGINAL ' || repeat('x',1100000) || ' ORIGINAL-END', notice=false WHERE id=${row.id};
      UPDATE ot.agents SET last_error='turn/start: Input exceeds the maximum length of 1048576 characters', extra=extra || '{"hard_fail_run":2}'::jsonb WHERE id=${id(n)}`)
    await rig.userMail(n, 'Ordinary next wake: read your waiting mail.')
    await wait(() => delivered(row.uid) || logs(n,'turn_refused').length, `${n} completes or refuses`)
    const receipt = observed(n)
    p.check(`${n}: opening giant mail arrives by bounded reference`, receipt?.mail_reference === true
      && receipt.input_text_bytes > 0 && receipt.input_text_bytes <= ceiling, receipt)
    p.check(`${n}: previously stuck mailbox recovers on next wake`, delivered(row.uid)
      && !rig.agentRow(n).last_error, { delivered: delivered(row.uid), error: rig.agentRow(n).last_error })
    if (n === 'budgetcodex') {
      const fetched = await rig.tool(n, 'orgtree_inbox', { action:'fetch', message_ids:[row.uid] })
      const first = fetched.json?.messages?.[0]
      let full = first?.content ?? '', good = fetched.ok && first?.chunk_total > 1
      for (let i=1; i<(first?.chunk_total ?? 0); i++) {
        const part = await rig.tool(n, 'orgtree_inbox', { action:'chunk', message_id:row.uid, delivery_id:first.delivery_id, chunk_index:i })
        good &&= part.ok && size(part.json?.content) <= 65536
        full += part.json?.content ?? ''
      }
      const expected = 'GIANT-ORIGINAL ' + 'x'.repeat(1100000) + ' ORIGINAL-END'
      p.check('reference fetch/chunk recovers every original byte', good && full === expected && first?.body_sha256 === sha(expected),
        { bytes:size(full), chunks:first?.chunk_total })
    }
    await hold(n)
  }

  // Only the FIRST item wakes. The tail is passive, but belongs to an already
  // admitted delivery: budget deferral must drain it, not leave it starved.
  for (const [n, tier, count, ceiling] of [['budgetsplit','luna',24,1_000_000], ['budgetsmall','haiku',9,262144]]) {
    await hire(n, tier); await hold(n)
    for (let i=0; i<count; i++) await rig.userMail(n, `MEDIUM-${String(i).padStart(2,'0')}`, { notice:i>0 })
    const originals = rig.sql(`SELECT uid,id FROM ot.mail WHERE recipient_agent_id=${id(n)} AND body LIKE 'MEDIUM-%' ORDER BY id`)
    rig.exec(`UPDATE ot.mail SET body=body || ' ' || repeat('m',62000) WHERE recipient_agent_id=${id(n)} AND body LIKE 'MEDIUM-%'`)
    await wake(n)
    await wait(() => originals.every(m => delivered(m.uid)) || logs(n,'turn_refused').length, `${n} drain or refusal`, 60000)
    const turns = logs(n,'turn')
    const seen = turns.flatMap(t => originals.filter(m => t.prompt?.includes(m.uid)).map(m => m.uid))
    p.check(`${n}: medium aggregate splits in order and passive tail drains`, originals.every(m => delivered(m.uid))
      && turns.length > 1 && JSON.stringify(seen) === JSON.stringify(originals.map(m => m.uid)), { turns:turns.length, seen:seen.length })
    p.check(`${n}: every final input fits its lane ceiling`, turns.length > 1 && turns.every(t => size(t.prompt) <= ceiling), turns.map(t => size(t.prompt)))
    p.check(`${n}: original medium bodies remain intact`, rig.one(`SELECT count(*)::int AS n FROM ot.mail WHERE recipient_agent_id=${id(n)} AND body LIKE 'MEDIUM-%' AND octet_length(body)=62010`)?.n === count)
    await hold(n)
  }

  // The oldest waking item beyond the 64-row claim must not jump over
  // intermediate notices, even when all of those notices are small.
  await hire('budgetorder'); await hold('budgetorder')
  for (let i=0; i<70; i++) await rig.userMail('budgetorder', `ORDER-${i}`, { notice:true })
  await rig.userMail('budgetorder', 'ORDER-WAKING-LAST')
  const ordered = rig.sql(`SELECT uid FROM ot.mail WHERE recipient_agent_id=${id('budgetorder')} AND body LIKE 'ORDER-%' ORDER BY id`)
  await wake('budgetorder')
  await wait(() => ordered.every(m => delivered(m.uid)), 'small notice prefix drains in order', 30000)
  const observedOrder = logs('budgetorder','turn').flatMap(t => ordered.filter(m => t.prompt?.includes(m.uid)).map(m => m.uid))
  p.check('claim boundary keeps the waking item behind preceding notices', JSON.stringify(observedOrder) === JSON.stringify(ordered.map(m => m.uid)),
    { expected:ordered.length, seen:observedOrder.length })
  p.check('small notices before the last waking item all drain', ordered.length === 71 && ordered.every(m => delivered(m.uid)))
  await hold('budgetorder')

  await hire('budgetsteer')
  await rig.userMail('budgetsteer', 'STEER-HOLD')
  await wait(() => logs('budgetsteer','step').some(x => x.step?.poll_mail), 'steer boundary')
  await rig.userMail('budgetsteer', 'STEER-LARGE ' + 's'.repeat(1100000))
  await wait(() => logs('budgetsteer','steer').length > 0, 'bounded native steer')
  const steered = logs('budgetsteer','steer').at(-1)?.text ?? ''
  p.check('native mid-turn steer is a bounded reference', size(steered) > 0 && size(steered) <= 1_000_000
    && steered.includes('MAIL BY REFERENCE') && steered.includes('orgtree_inbox'), { bytes:size(steered) })
  await wait(() => rig.turns('budgetsteer').some(t => t.ended_at), 'steered turn settles')
  await hold('budgetsteer')

  // Explicit failed starts (small prompts), then explicit re-drive. The
  // repeated-alert fix must not turn the terminal failure into a retry loop.
  await hire('budgetrefuse')
  const reports = () => rig.sql(`SELECT ev FROM ot.mail WHERE recipient_agent_id=${id('boss')}
    AND ev->>'variant'='runtime.report_stalled' AND ev->>'report'='budgetrefuse' ORDER BY id`)
  await rig.userMail('budgetrefuse', 'LENGTH-REFUSE first')
  await wait(() => logs('budgetrefuse','turn_refused').length >= 1 && reports().length >= 1, 'first refused start reported')
  await sleep(7000)
  p.check('length refusal has no automatic retry loop', logs('budgetrefuse','turn_refused').length === 1)
  await hold('budgetrefuse'); await wake('budgetrefuse')
  await wait(() => logs('budgetrefuse','turn_refused').length >= 2, 'second actual failed attempt')
  await wait(() => reports().length >= 2, 'second stalled notice', 10000)
  const notices = reports()
  p.check('halt/unhalt refusal is re-announced with input sizes', notices.length === 2
    && notices.every(m => /UTF-8 bytes.*characters.*budget/.test(m.ev?.err ?? '')), notices.map(m => m.ev?.err))
  await sleep(7000)
  p.check('second refusal also stays terminal with original mail pending', logs('budgetrefuse','turn_refused').length === 2
    && rig.one(`SELECT count(*)::int AS n FROM ot.mail WHERE recipient_agent_id=${id('budgetrefuse')} AND body='LENGTH-REFUSE first' AND state='pending'`)?.n === 1)
  await rig.userMail('budgetrefuse', 'Next ordinary wake succeeds.')
  await wait(() => rig.turns('budgetrefuse').some(t => t.ended_at && !t.error), 'later wake recovery')
  p.check('successful next wake clears the failed run', rig.agentRow('budgetrefuse').extra?.hard_fail_run == null
    && !rig.agentRow('budgetrefuse').last_error)
  p.keep(rig, { agents:['budgetcodex','budgetsplit','budgetsteer','budgetrefuse'], grep:/mail input budget|maximum length|turn could not start/ })
  return p.summary()
}
