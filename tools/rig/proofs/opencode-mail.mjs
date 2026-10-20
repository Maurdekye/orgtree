// Real engine + explicit OpenCode 2.0.28 + synthetic loopback model, no auth.
// Run with --real-opencode <exe>. No installed profile or provider is read.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { startOpenCodeSynthetic } from '../opencode-synthetic.mjs'

export async function setup(flags) {
  if (typeof flags['real-opencode'] !== 'string') throw Error('explicit --real-opencode required')
  return { name: 'opencode-mail', fixture: {
    org: { name: 'Synthetic OpenCode mail' },
    agents: [{ name: 'boss', tier: 'sol', grant: 12 }],
  } }
}

export default async function (rig, { flags = {}, lifecycle = !!flags.lifecycle } = {}) {
  const p = new Proof('opencode-mail')
  const model = await startOpenCodeSynthetic()
  try {
    const registry = await rig.waitFor(async () =>
      (await rig.api('GET', '/api/harnesses')).harnesses?.find(h => h.id === 'opencode' && h.installed),
    { what: 'isolated OpenCode discovery' })
    p.check('real OpenCode negotiated the pinned 2.0.28 contract', registry.version === '2.0.28', registry.version)
    if (registry.version !== '2.0.28') throw Error('unmeasured OpenCode version')
    const added = await rig.api('POST', '/api/langservers', {
      preset: 'custom', address: model.url, base_path: 'v1', harness: 'opencode',
      label: 'Offline mail proof', models: [{ id: 'mail-fixture', context: 131072 }],
    })
    const tier = Object.values(added.server?.models ?? {})[0]?.tier
    if (!tier) throw Error('synthetic model not offered')
    await rig.op({ op: 'hire', name: 'mailprobe', parent: 'boss', tier, grant: 1,
      charter: 'Synthetic fixture. Read the requested fixture and answer.',
      tools: { bash: false, edit: false }, permission_mode: 'default' })
    const agent = rig.agentRow('mailprobe')
    const scratch = rig.one(`SELECT scratch_dir FROM ot.agents WHERE id=${agent.id}`).scratch_dir
    fs.mkdirSync(scratch, { recursive: true })
    const file = path.join(scratch, 'mail-proof.txt')
    fs.writeFileSync(file, 'Synthetic read fixture, no secrets.')
    const sent = async (body, urgent = false) => {
      const result = await rig.tool('boss', 'orgtree_message', { to: 'mailprobe', body,
        ...(urgent ? { urgent: true, urgent_reason: 'synthetic urgent control' } : {}) })
      if (!result.ok) throw Error(result.text)
    }
    const row = text => rig.one(`SELECT id,state,turn_id,extra FROM ot.mail
      WHERE recipient_agent_id=${agent.id} AND body='${text}' ORDER BY id DESC LIMIT 1`)
    const liveTurn = () => rig.turns('mailprobe').find(t => !t.ended_at)
    const awaitSettled = async () => rig.waitFor(() =>
      !rig.turns('mailprobe').some(t => !t.ended_at) && !rig.one(`SELECT id FROM ot.mail
        WHERE recipient_agent_id=${agent.id} AND state IN('pending','delivering') LIMIT 1`),
    { what: 'all synthetic mail to settle', timeout: 90000 })
    const claimTable = rig.one("SELECT to_regclass('ot.opencode_mail_batches')::text AS name")?.name

    // The baseline must fail this exact in-turn observation, while the next-turn
    // fallback control still passes. No sleeping race decides the assertion.
    const ordinary = model.arm('MAIL_CASE_ORDER', file)
    await rig.userMail('mailprobe', 'MAIL_CASE_ORDER')
    await ordinary.first()
    const firstTurn = liveTurn()?.id
    await sent('MAIL_CANARY_FIRST')
    await sent('MAIL_CANARY_SECOND')
    ordinary.releaseFirst()
    const second = await ordinary.second()
    const messages = JSON.stringify(second.body.messages)
    p.check('ordered mail reaches the next model request inside the same ACP turn',
      messages.includes('MAIL_CANARY_FIRST') && messages.indexOf('MAIL_CANARY_FIRST') < messages.indexOf('MAIL_CANARY_SECOND')
      && liveTurn()?.id === firstTurn, { firstTurn, active: liveTurn()?.id })
    p.check('positive mid-turn acknowledgement commits both exact rows before prompt completion',
      ['MAIL_CANARY_FIRST', 'MAIL_CANARY_SECOND'].every(x => row(x)?.state === 'delivered' && row(x)?.turn_id === firstTurn))
    ordinary.releaseSecond()
    await awaitSettled()
    p.check('ordinary fallback or hook leaves no lost mail', ['MAIL_CANARY_FIRST', 'MAIL_CANARY_SECOND']
      .every(x => row(x)?.state === 'delivered'))

    const dnd = model.arm('MAIL_CASE_DND', file)
    await rig.userMail('mailprobe', 'MAIL_CASE_DND')
    await dnd.first()
    const dndTurn = liveTurn()?.id
    const status = await rig.tool('mailprobe', 'orgtree_status', { status: 'working', dnd: true, summary: 'synthetic DND' })
    if (!status.ok) throw Error(status.text)
    await sent('MAIL_CANARY_HELD')
    await sent('MAIL_CANARY_URGENT', true)
    dnd.releaseFirst()
    const duringDnd = JSON.stringify((await dnd.second()).body.messages)
    p.check('urgent bypasses DND inside the original turn', duringDnd.includes('MAIL_CANARY_URGENT')
      && row('MAIL_CANARY_URGENT')?.turn_id === dndTurn && row('MAIL_CANARY_URGENT')?.state === 'delivered')
    p.check('nonurgent remains pending and absent from DND model input',
      !duringDnd.includes('MAIL_CANARY_HELD') && row('MAIL_CANARY_HELD')?.state === 'pending')
    dnd.releaseSecond()
    await awaitSettled()
    p.check('held nonurgent is delivered by the following turn', row('MAIL_CANARY_HELD')?.state === 'delivered'
      && row('MAIL_CANARY_HELD')?.turn_id !== dndTurn)
    if (claimTable) {
      p.check('no outstanding custody remains at the turn boundary',
        rig.one(`SELECT count(*)::int AS n FROM ot.opencode_mail_batches WHERE agent_id=${agent.id}`).n === 0)
    } else p.note('baseline has no custody table; runtime custody checks require the candidate')

    if (lifecycle) {
      if (!claimTable) throw Error('lifecycle mode requires candidate custody schema')
      const blockAck = () => rig.exec(`
        CREATE OR REPLACE FUNCTION ot.mail_proof_fail_ack() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic acknowledgement failure'; END $$;
        CREATE TRIGGER mail_proof_fail_ack BEFORE DELETE ON ot.opencode_mail_batches
          FOR EACH ROW WHEN(OLD.agent_id=${agent.id}) EXECUTE FUNCTION ot.mail_proof_fail_ack();`)
      const allowAck = () => rig.exec('DROP TRIGGER IF EXISTS mail_proof_fail_ack ON ot.opencode_mail_batches;')
      const held = () => rig.one(`SELECT message_id,session_id,turn_id,mail_ids FROM ot.opencode_mail_batches WHERE agent_id=${agent.id}`)
      const receiptCount = marker => rig.one(`SELECT count(*)::int AS n FROM ot.convo
        WHERE agent_id=${agent.id} AND body::text LIKE '%${marker}%'`).n

      // An acknowledgement can fail after admission. The next hook retries the
      // same durable provider ID, which must not add a second native message.
      const retry = model.arm('MAIL_CASE_RETRY', file, 2)
      await rig.userMail('mailprobe', 'MAIL_CASE_RETRY')
      await retry.first()
      const retryTurn = liveTurn()?.id
      blockAck()
      await sent('MAIL_CANARY_RETRY')
      retry.releaseFirst()
      await retry.second()
      const firstBatch = held()
      p.check('failed acknowledgement retains exact durable custody after native admission',
        !!firstBatch && firstBatch.turn_id === retryTurn && row('MAIL_CANARY_RETRY')?.state === 'delivering'
        && receiptCount('MAIL_CANARY_RETRY') === 0, firstBatch)
      allowAck()
      retry.releaseSecond()
      const retried = JSON.stringify((await retry.third()).body.messages)
      p.check('retry deduplicates native message and commits one transcript row',
        retried.split('MAIL_CANARY_RETRY').length - 1 === 1
        && row('MAIL_CANARY_RETRY')?.state === 'delivered' && receiptCount('MAIL_CANARY_RETRY') === 1
        && held() === null)
      retry.releaseThird()
      await awaitSettled()

      // Cancel at the next model request, after OpenCode admitted the batch but
      // the engine transaction failed. The stopped writer's native history is
      // sufficient to settle without another model delivery.
      const cancel = model.arm('MAIL_CASE_CANCEL', file)
      await rig.userMail('mailprobe', 'MAIL_CASE_CANCEL')
      await cancel.first()
      const cancelTurn = liveTurn()?.id
      blockAck()
      await sent('MAIL_CANARY_CANCEL')
      cancel.releaseFirst()
      await cancel.second()
      p.check('cancellation fixture has real unacknowledged custody', !!held())
      allowAck()
      await rig.api('POST', `/api/orgs/${rig.org}/nodes/mailprobe/interrupt`, {})
      cancel.releaseSecond()
      await awaitSettled()
      p.check('cancel reconciles admitted mail from stopped native history exactly once',
        row('MAIL_CANARY_CANCEL')?.state === 'delivered' && row('MAIL_CANARY_CANCEL')?.turn_id === cancelTurn
        && row('MAIL_CANARY_CANCEL')?.extra?.opencode_ambiguous !== true
        && receiptCount('MAIL_CANARY_CANCEL') === 1 && held() === null)

      // An engine crash cannot prove the old hosted writer has stopped. The
      // explicitly ruled fallback must carry a warning and end at the next turn.
      const crash = model.arm('MAIL_CASE_CRASH', file)
      await rig.userMail('mailprobe', 'MAIL_CASE_CRASH')
      await crash.first()
      const crashTurn = liveTurn()?.id
      blockAck()
      await sent('MAIL_CANARY_CRASH')
      crash.releaseFirst()
      await crash.second()
      p.check('restart fixture has real unacknowledged custody', !!held())
      allowAck()
      await rig.crash()
      crash.releaseSecond()
      const afterCrashRequest = model.requests.length
      await rig.restart()
      // Recovery runs before asynchronous harness discovery. A resumed turn can
      // therefore be refused by the existing startup installation guard. Check
      // custody immediately, then explicitly wake after discovery so this proof
      // measures mail recovery rather than that independent startup race.
      p.check('startup releases uncertain custody with the warning before the next turn',
        held() === null && row('MAIL_CANARY_CRASH')?.extra?.opencode_ambiguous === true)
      await rig.waitFor(async () =>
        (await rig.api('GET', '/api/harnesses')).harnesses?.some(h =>
          h.id === 'opencode' && h.installed && h.version === '2.0.28'),
      { what: 'OpenCode discovery after restart' })
      await rig.userMail('mailprobe', 'MAIL_CASE_POST_RESTART')
      await awaitSettled()
      const recoveryRequests = JSON.stringify(model.requests.slice(afterCrashRequest))
      p.check('uncertain crash custody returns once on the next turn with its warning',
        row('MAIL_CANARY_CRASH')?.state === 'delivered' && row('MAIL_CANARY_CRASH')?.turn_id !== crashTurn
        && row('MAIL_CANARY_CRASH')?.extra?.opencode_ambiguous === true && held() === null
        && receiptCount('MAIL_CANARY_CRASH') === 1
        && recoveryRequests.includes('may already have been delivered mid-turn'))
      p.check('uncertain restart emits exactly one content-free diagnostic',
        rig.engineLog().split('OpenCode mail admission unresolved; next-turn delivery').length - 1 === 1)
    }

    const logs = rig.engineLog()
    // The pre-existing /api/rig/tool HTTP request log echoes fixture inputs on
    // both engines. Exclude exactly those request lines; the bridge's warnings,
    // errors, receipts and all other diagnostics remain under this assertion.
    const bridgeLogs = logs.split(/\r?\n/).filter(line => !/ REQUEST .* POST \/api\/rig\/tool \| /.test(line)).join('\n')
    p.check('bridge diagnostics contain no private mail canaries', !bridgeLogs.includes('MAIL_CANARY_'))
    p.note('privacy check excludes only existing /api/rig/tool HTTP request echoes; baseline exhibits those too')
    p.check('synthetic model completed without handler errors', model.errors.length === 0, model.errors)
    p.file('turns.json', rig.turns('mailprobe'))
    p.keep(rig, { grep: /OpenCode|ACP|mail custody|mail admission/ })
    return p.summary()
  } finally {
    p.file('synthetic-model-requests.json', model.requests)
    p.file('synthetic-model-errors.json', model.errors)
    p.keep(rig, { grep: /OpenCode|ACP|mail custody|mail admission/ })
    await model.close()
  }
}
