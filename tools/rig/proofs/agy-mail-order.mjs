// Synthetic stream-order regression, using the real agy mail hook and actor.
// Raw tool events deliberately allow a completion across a mail boundary;
// they execute no shell command. The existing agy-lane proof covers tool hooks.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/agy-mail-order.mjs
import { Proof } from '../proof.mjs'

const tool = (index, state, result) => ({ raw: {
  event: 'step_update', step_update: {
    step_index: index, step_type: 'tool', state, tool_name: 'run_command',
    tool_info: { parameters: { CommandLine: `echo order-${index}` }, ...(result ? { result } : {}) },
  },
} })
const poll = { poll_mail: { every_ms: 100, timeout_ms: 20000 } }

export default async function (rig) {
  const p = new Proof('agy-mail-order')
  const name = 'mail-order'
  rig.scenario({ agents: { [name]: { turns: [{ name: 'ordered', match: 'ORDER-START', once: true, steps: [
    tool(100, 'ACTIVE'), tool(100, 'DONE', 'before mail'),
    tool(101, 'ACTIVE'), poll,
    tool(102, 'ACTIVE'), tool(102, 'DONE', 'after first mail'),
    tool(101, 'DONE', 'original tool completed after mail'), poll,
    tool(103, 'ACTIVE'), tool(103, 'DONE', 'after second mail'),
  ] }] } }, default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name, parent: 'boss', tier: 'flash', title: 'Mail ordering proof' })
  const id = rig.agentRow(name).id
  const before = rig.one(`SELECT coalesce(max(seq), 0) AS seq FROM ot.convo WHERE agent_id = ${id}`).seq
  const rows = () => rig.sql(`SELECT seq, body FROM ot.convo WHERE agent_id = ${id} AND seq > ${before} ORDER BY seq`)
  const chips = rs => rs.flatMap(r => (r.body.tools ?? []).map(chip => ({ seq: r.seq, ...chip })))
  const chip = (rs, index) => chips(rs).filter(c => c.id === `agy-step-${index}`)
  const mail = (rs, marker) => rs.filter(r => r.body.role === 'user' && JSON.stringify(r.body).includes(marker))
  const log = kind => rig.fakeLog(name).filter(x => x.kind === kind)
  const waiting = count => rig.waitFor(() => log('step').filter(x => x.step?.poll_mail).length >= count,
    { what: `mail hook boundary ${count}`, timeout: 30000 })

  await rig.userMail(name, 'ORDER-START: begin the synthetic tool stream.')
  await waiting(1)
  const active = await rig.waitFor(() => {
    const found = chip(rows(), 101)[0]
    return found && !found.ended_at ? found : null
  }, { what: 'original tool active before mail' })
  p.check('original tool is active before the first mail', !active.ended_at, active)
  await rig.userMail(name, 'ORDER-MAIL-1: waking mid-turn delivery.')
  await waiting(2)
  const middle = await rig.waitFor(() => {
    const rs = rows()
    return chip(rs, 101)[0]?.ended_at && chip(rs, 102)[0]?.ended_at && mail(rs, 'ORDER-MAIL-1').length ? rs : null
  }, { what: 'first delivery and both completed tools' })
  p.file('middle-rows.json', middle)
  const firstMail = mail(middle, 'ORDER-MAIL-1')
  const pre = chip(middle, 100), held = chip(middle, 101), post = chip(middle, 102)
  p.check('pre-mail tool < delivered mail < new post-mail tool',
    pre.length === 1 && firstMail.length === 1 && post.length === 1
    && pre[0].seq < firstMail[0].seq && firstMail[0].seq < post[0].seq,
    { pre: pre[0]?.seq, mail: firstMail[0]?.seq, post: post[0]?.seq })
  p.check('in-flight tool completes exactly once on its original pre-mail row',
    held.length === 1 && held[0].seq === active.seq && held[0].seq < firstMail[0]?.seq
    && held[0].started_at === active.started_at && held[0].ended_at
    && held[0].result === 'original tool completed after mail' && !held[0].error, held)
  await rig.userMail(name, 'ORDER-MAIL-2: passive mid-turn notice.', { notice: true })
  const turns = await rig.waitTurns(name, 1)
  const final = rows()
  p.file('final-rows.json', final)
  const secondMail = mail(final, 'ORDER-MAIL-2'), last = chip(final, 103)
  p.check('first post-mail tool < second delivery < final tool',
    post.length === 1 && secondMail.length === 1 && last.length === 1
    && post[0].seq < secondMail[0].seq && secondMail[0].seq < last[0].seq,
    { post: post[0]?.seq, mail: secondMail[0]?.seq, last: last[0]?.seq })
  p.check('all four tools retain one completed result', [100, 101, 102, 103].every(i => {
    const found = chip(final, i)
    return found.length === 1 && found[0].ended_at && found[0].result && !found[0].error
  }), chips(final))
  const deliveries = rig.sql(`SELECT state, turn_id, notice FROM ot.mail WHERE recipient_agent_id = ${id} AND body LIKE 'ORDER-MAIL-%' ORDER BY id`)
  p.check('both deliveries stay in the original turn with their notice flags', deliveries.length === 2
    && deliveries.every(m => m.state === 'delivered' && m.turn_id === turns[0].id)
    && deliveries[0].notice === false && deliveries[1].notice === true, deliveries)
  p.check('both mails pass through the invocation hook', ['ORDER-MAIL-1', 'ORDER-MAIL-2'].every(marker =>
    log('hook_mail').some(x => x.text?.includes(marker) && x.termination === 'force_continue')))
  p.check('no interruption, error or extra turn', rig.turns(name).length === 1 && !turns[0].error && !turns[0].killed, turns)
  p.keep(rig, { agents: [name], grep: /agy|steer/ })
  return p.summary()
}
