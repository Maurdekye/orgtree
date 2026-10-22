// Bounded fair-queue batches, message-level fairness and independent ACKs.
import { Proof } from '../proof.mjs'
export async function setup() {
  return { fixture: { org: { name: 'Queue batches' }, agents: [{ name: 'boss', tier: 'sol', grant: 100 }] } }
}
export default async function (rig) {
  const p = new Proof('project-queue-batch')
  let phase = 'setup'
  try {
  rig.scenario({ default: { turns: [{ steps: [{ text: 'Batch received.' }] }] } })
  const settle = () => rig.waitFor(() => rig.sql('SELECT id FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'fixture turns', timeout: 60000 })
  const create = (who, project, extra = {}) => rig.tool(who, 'orgtree_watchdog', { action: 'create', kind: 'fair_queue', target: project, name: `take-${project}`, notice: true, ...extra })
  const remove = (who, project) => rig.tool(who, 'orgtree_watchdog', { action: 'remove', id: `take-${project}` })
  const originals = project => rig.sql(`SELECT uid,body,state,extra FROM ot.mail WHERE recipient_name='${project}' AND body LIKE 'job-%' ORDER BY id`)
  const copies = (who, project) => rig.sql(`SELECT uid,body,state,read_at,delivered_at,extra,xmin::text AS tx FROM ot.mail WHERE recipient_name='${who}' AND extra->'via_project'->>'name'='${project}' ORDER BY id`)
  const dog = (who, project) => rig.one(`SELECT state,fired,memo FROM ot.watchdogs WHERE owner_agent_id=(SELECT id FROM ot.agents WHERE name='${who}') AND target='${project}' ORDER BY id DESC LIMIT 1`)
  const seed = (project, count, notice = true) => rig.exec(`INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,notice)
    SELECT 'm-batch-${project}-'||g,p.org_id,'@user','agent',p.id,p.name,'job-'||g,'pending',${notice}
    FROM ot.agents p CROSS JOIN generate_series(1,${count}) g WHERE p.name='${project}'`)
  const project = async (name, workers, ack = false) => {
    await rig.op({ op: 'create_project', name, parent: 'boss' })
    for (const who of workers) await rig.op({ op: 'hire', name: who, parent: name, tier: 'sol', grant: 0 })
    if (ack) await rig.op({ op: 'set_mail_queue', node: name, mode: 'ack' })
    await settle()
  }
  await project('validation', ['v'])
  for (const batch of [0, -1, 21, 1.5, '3', true]) {
    const r = await create('v', 'validation', { batch })
    p.check(`batch=${JSON.stringify(batch)} is refused without creating a dog`, !r.ok && !dog('v', 'validation'), r.text)
    if (r.ok) await remove('v', 'validation')
    // Removed rows are retained; only active rows count for the next case.
    rig.exec("DELETE FROM ot.watchdogs WHERE state='removed' AND owner_agent_id=(SELECT id FROM ot.agents WHERE name='v')")
  }
  const wrong = await rig.tool('v', 'orgtree_watchdog', { action: 'create', kind: 'project_listener', target: 'validation', name: 'wrong', batch: 2 })
  p.check('batch is refused on other watchdog kinds', !wrong.ok, wrong.text)
  if (wrong.ok) await rig.tool('v', 'orgtree_watchdog', { action: 'remove', id: 'wrong' })
  const legacy = await create('v', 'validation')
  const list = await rig.tool('v', 'orgtree_watchdog', { action: 'list' })
  p.check('omitted batch projects as one in tool list', legacy.ok && JSON.stringify(list.json).includes('"batch":1'), list.json)
  await remove('v', 'validation')

  // All three listeners are already armed before any mail arrives. The
  // scratch-only backlog models mails committed while the engine was down.
  await project('fair', ['a', 'b', 'c'], true)
  for (const [who, batch] of [['a', 3], ['b', 1], ['c', 2]]) await create(who, 'fair', { batch })
  seed('fair', 8)
  await rig.userMail('fair', 'dispatch trigger', { notice: true })
  const mails = originals('fair')
  p.check('three listeners are dealt one mail each before any second mail', JSON.stringify(mails.slice(0, 3).map(m => m.extra?.claimed?.by)) === JSON.stringify(['a', 'b', 'c']), mails)
  p.check('unequal capacities are filled fairly: a,b,c,a,c,a', JSON.stringify(mails.slice(0, 6).map(m => m.extra?.claimed?.by)) === JSON.stringify(['a', 'b', 'c', 'a', 'c', 'a']), mails)
  p.check('ACK caps are 3,1,2 with the overflow waiting', copies('a', 'fair').length === 3 && copies('b', 'fair').length === 1 && copies('c', 'fair').length === 2 && mails.slice(6).every(m => m.state === 'pending'), mails)
  p.check('all copies of the assignment round commit together', new Set(['a', 'b', 'c'].flatMap(w => copies(w, 'fair').map(m => m.tx))).size === 1, ['a', 'b', 'c'].map(w => copies(w, 'fair')))
  p.check('individual copies retain ACK provenance and passive delivery', ['a', 'b', 'c'].every(w => copies(w, 'fair').every(m => m.extra.via_project.ack === true)), mails)
  const first = copies('a', 'fair')[0]
  const ack = await rig.tool('a', 'orgtree_message', { metadata: { to: 'fair', reply_to: first.uid }, body: 'Finished this one.' })
  p.check('one ACK frees one place without overfilling the other listeners', ack.ok && copies('a', 'fair').length === 4 && copies('b', 'fair').length === 1 && copies('c', 'fair').length === 2 && originals('fair')[6]?.extra?.claimed?.by === 'a', { ack: ack.text, mails: originals('fair') })
  // Stop other consumers first, then abandon a partially acknowledged batch.
  await remove('b', 'fair'); await remove('c', 'fair'); await remove('a', 'fair')
  const abandoned = originals('fair')
  p.check('partial abandonment preserves the one ACK and returns every other mail', !!abandoned[0]?.extra?.claimed?.acked_at && abandoned.slice(1).every(m => m.state === 'pending'), abandoned)

  await project('one', ['one-worker'])
  phase = 'registered one-shot batch and prompt'
  const before = rig.turns('one-worker').filter(t => t.ended_at).length
  // Register while empty, then supply a backlog. A ready one-shot instead
  // consumes inline and cannot exercise a spent row or wake/prompt coverage.
  const once = await create('one-worker', 'one', { batch: 3, once: true, notice: false })
  seed('one', 5, false)
  await rig.userMail('one', 'dispatch trigger', { notice: true })
  await rig.waitFor(() => dog('one-worker', 'one')?.state === 'spent', { what: 'one batch spends the listener', timeout: 20000 })
  await rig.waitTurns('one-worker', before + 1)
  const prompt = rig.fakeLog('one-worker').filter(x => x.kind === 'turn').at(-1)?.prompt ?? ''
  p.check('a one-shot takes its full available batch then leaves the rest', once.ok && dog('one-worker', 'one')?.state === 'spent'
    && copies('one-worker', 'one').length === 3 && originals('one').filter(m => m.state === 'pending').length === 2, originals('one'))
  p.check('one wake delivers all three original mails in one real fakeCLI prompt', ['job-1', 'job-2', 'job-3'].every(s => prompt.includes(s)) && !prompt.includes('job-4')
    && rig.turns('one-worker').filter(t => t.ended_at).length === before + 1, prompt)
  p.check('handed count remains a message count', dog('one-worker', 'one')?.fired === 3, dog('one-worker', 'one'))

  await project('short', ['short-worker'], true)
  phase = 'inline short ACK batch'
  seed('short', 2)
  const shortTurns = rig.turns('short-worker').length
  const short = await create('short-worker', 'short', { batch: 20, once: true })
  await settle()
  const shortCopies = copies('short-worker', 'short'), messages = short.json?.messages
  const shortFireMails = rig.sql("SELECT uid FROM ot.mail WHERE recipient_name='short-worker' AND kind='watchdog'")
  p.check('a short batch is delivered immediately, without waiting for twenty', short.ok && short.json?.resolved === true && short.json?.registered === false
    && !dog('short-worker', 'short') && shortFireMails.length === 0 && rig.turns('short-worker').length === shortTurns
    && Array.isArray(messages) && messages.length === 2 && new Set(messages.map(m => m.id)).size === 2
    && JSON.stringify(messages.map(m => m.id)) === JSON.stringify(shortCopies.map(m => m.uid))
    && messages.every(m => m.state === 'read' && m.will_redeliver === false && m.content.includes(m.body))
    && shortCopies.length === 2 && shortCopies.every(m => m.state === 'read' && m.read_at && m.delivered_at && m.extra.manual_read === true
      && m.extra.via_project.inline === true && m.extra.via_project.dog === null), { result: short.json, shortCopies, shortTurns })
  await rig.userMail('short', 'dispatch again', { notice: true })
  await settle()
  // A later mail to an unlistened queue can legitimately warn/wake its
  // manager and cause ACK reminders. No-wake belongs to inline creation;
  // custody and absence of duplicate copies must survive that later action.
  p.check('spent one-shot still owns its unacked batch', originals('short').length === 2 && originals('short').every(m => m.extra?.claimed?.by === 'short-worker'
    && m.extra.claimed.inline === true && m.extra.claimed.dog === null && !m.extra.claimed.acked_at
    && m.extra.claimed.copy === shortCopies.find(c => c.extra.via_project.mail === m.uid)?.uid)
    && JSON.stringify(copies('short-worker', 'short').map(m => m.uid)) === JSON.stringify(shortCopies.map(m => m.uid))
    && !dog('short-worker', 'short'), { originals: originals('short'), copies: copies('short-worker', 'short'), turns: rig.turns('short-worker').length })
  p.keep(rig, { agents: ['one-worker', 'a'], grep: /batch|dispatch|error/ })
  return p.summary()
  } catch (error) {
    p.check(`project-queue-batch failed during ${phase}`, false, { error: error.message, stack: error.stack })
    return p.summary()
  }
}
