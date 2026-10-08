// Proof: an effort change reaches a running Claude turn, as 3.x sent it
//   (supervisor.py send_live_effort, from the settings route, orgtree_retool
//   and the operator's retool), and every other change takes it from the
//   next turn on a process started with the new level.
//   ada (opus) runs a long turn, and within it:
//     boss's orgtree_retool to max answers effort_delivery {sent, max}, her
//     CLI is sent apply_flag_settings {effortLevel: max} and her card shows
//     no next-turn effort (the running turn has it);
//     the user's settings route to low answers {sent, low} and sends low;
//     a clear back to the org default (medium) sends medium, never "";
//     medium set on her answers {unchanged} and sends nothing.
//   Her next turn starts a fresh CLI with --effort medium on her session. A
//   change while she is idle answers {next_turn, "no turn is running"} and
//   her next turn starts with it.
//   lu (luna, Codex): a change answers {next_turn, "only Claude turns ..."};
//   its next turn/start carries the new effort, after a change while its
//   app-server was parked and after a retool mid-turn (whose card shows the
//   next level while the turn runs).
//   An effort-only retool restarts nobody else: kid (ada's report) keeps its
//   parked CLI.
//   With --ui, the desk as the user sees it: after boss's retool mid-turn the
//   desk shows no next-turn effort card, and the composer's effort dots set
//   low with the toast "sent to the running agent".
// Run: node tools/rig/rig.mjs run tools/rig/proofs/live-effort.mjs [--ui <bundle>]

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const ONLY_CLAUDE = 'only Claude turns take an effort change mid-turn'

export default async function (rig) {
  const p = new Proof('live-effort')
  const long = ms => [{ text: 'Working.' }, { sleep_ms: ms }, { tool: 'Bash', args: { command: 'echo after' }, result: 'after' }, { text: 'Done.' }]
  rig.scenario({
    agents: {
      ada: { turns: [
        { name: 'long', match: 'PROOF-LONG', steps: long(20000) },
        { name: 'desk', match: 'PROOF-DESK', steps: long(240000) },
      ] },
      lu: { turns: [{ name: 'long', match: 'PROOF-LONG', steps: [{ text: 'Working.' }, { sleep_ms: 12000 }, { text: 'Done.' }] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { default_effort: 'medium' })
  await rig.op({ op: 'hire', name: 'ada', parent: 'boss', tier: 'opus', title: 'Effort subject', grant: 1 })
  await rig.op({ op: 'hire', name: 'kid', parent: 'ada', tier: 'haiku', title: 'Bystander' })
  await rig.op({ op: 'hire', name: 'lu', parent: 'boss', tier: 'luna', title: 'Codex subject' })
  for (const name of ['ada', 'kid', 'lu']) {
    await rig.userMail(name, `Hello ${name}, start a session.`)
    await rig.waitTurns(name, 1)
  }

  const id = name => rig.agentRow(name).id
  // the actor's published runtime (what the cards read): the feed snapshot's runtime frame
  const runtime = async name => (await rig.api('GET', `/api/orgs/${rig.org}/records`))?.runtime?.agents?.[String(id(name))] ?? {}
  const log = name => rig.fakeLog(name)
  const starts = name => log(name).filter(l => l.kind === 'start')
  const sends = name => log(name).filter(l => l.kind === 'recv' && l.line?.type === 'control_request'
    && l.line?.request?.subtype === 'apply_flag_settings')
  const turnStarts = name => log(name).filter(l => l.kind === 'recv' && l.line?.method === 'turn/start')
  const scope = (name, effort) => rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/scope`, { effort })
  const retool = async (name, effort) => {
    const r = await rig.tool('boss', 'orgtree_retool', { node: name, effort })
    return r.json ?? { text: r.text }
  }
  const delivered = (out, delivery, effort, reason) => {
    const d = out?.effort_delivery
    return d?.delivery === delivery && d?.effort === effort && (reason === undefined || d?.reason === reason)
  }
  // mail `text` (a scenario marker) and wait until its turn is playing: its `turn` log entry
  const play = async (name, text) => {
    const marker = text.split(':')[0]
    const plays = () => log(name).filter(l => l.kind === 'turn' && JSON.stringify(l).includes(marker))
    const before = plays().length
    await rig.userMail(name, text)
    await rig.waitFor(() => plays().length > before && rig.turns(name).some(t => !t.ended_at), { what: `${name}'s ${marker} turn` })
    return plays().at(-1)
  }

  // ---- ada mid-turn: retool, settings route, clear, unchanged
  const adaTurns = rig.turns('ada').length
  const turn = await play('ada', 'PROOF-LONG: work while your effort changes.')
  const session = starts('ada').filter(s => s.pid === turn.pid).at(-1)?.session
  const sentBefore = sends('ada').length
  const r1 = await retool('ada', 'max')
  p.check("orgtree_retool mid-turn answers effort_delivery {sent, max}", delivered(r1, 'sent', 'max'), r1)
  await sleep(500)
  const s1 = sends('ada').slice(sentBefore)
  p.check('...and her running CLI was sent apply_flag_settings {effortLevel: max}',
    s1.length === 1 && s1[0].line.request.settings?.effortLevel === 'max' && s1[0].pid === turn.pid, s1.map(l => l.line.request))
  const v1 = await runtime('ada')
  p.check('...and her card shows no next-turn effort: the running turn has max',
    v1.pending_effort == null && v1.effort_current === 'max', { effort_current: v1.effort_current, pending_effort: v1.pending_effort })
  const r2 = await scope('ada', 'low')
  p.check('the settings route mid-turn answers {sent, low}', delivered(r2, 'sent', 'low'), r2.effort_delivery)
  const r3 = await scope('ada', '')
  p.check('a clear back to the org default answers {sent, medium}', delivered(r3, 'sent', 'medium'), r3.effort_delivery)
  const r4 = await scope('ada', 'medium')
  p.check('medium set on her (the level she already resolves to) answers {unchanged}', delivered(r4, 'unchanged', 'medium'), r4.effort_delivery)
  await sleep(500)
  const s2 = sends('ada').slice(sentBefore).map(l => l.line.request.settings?.effortLevel)
  p.check('her running CLI was sent max, low, medium in order: the clear as the level it resolves to, nothing for unchanged',
    JSON.stringify(s2) === '["max","low","medium"]', s2)
  const v2 = await runtime('ada')
  p.check('...and her card still shows no next-turn effort', v2.pending_effort == null && v2.effort_current === 'medium',
    { effort_current: v2.effort_current, pending_effort: v2.pending_effort })
  const done = await rig.waitTurns('ada', adaTurns + 1)
  p.check('her long turn ran to its end', done.at(-1)?.ended_at && !done.at(-1)?.error && !done.at(-1)?.killed, done.at(-1))
  const adaStarts = starts('ada').length
  await rig.userMail('ada', 'Next turn, please.')
  await rig.waitTurns('ada', adaTurns + 2)
  const st = starts('ada').slice(adaStarts)
  p.check('her next turn starts a fresh CLI with --effort medium on her session',
    st.length === 1 && st[0].effort === 'medium' && st[0].pid !== turn.pid && st[0].resumed === true && st[0].session === session,
    st.map(s => ({ pid: s.pid, effort: s.effort, resumed: s.resumed, session: s.session, was: session })))

  // ---- ada idle
  const idleStarts = starts('ada').length
  const r5 = await scope('ada', 'xhigh')
  p.check('a change while she is idle answers {next_turn, xhigh, "no turn is running"}',
    delivered(r5, 'next_turn', 'xhigh', 'no turn is running'), r5.effort_delivery)
  await rig.userMail('ada', 'After the idle change.')
  await rig.waitTurns('ada', adaTurns + 3)
  const st2 = starts('ada').slice(idleStarts)
  p.check('her next turn runs on a CLI started with --effort xhigh (a process at another level is not reused)',
    st2.length === 1 && st2[0].effort === 'xhigh', st2.map(s => ({ pid: s.pid, effort: s.effort })))

  // ---- lu (Codex): parked app-server, then mid-turn
  const luTurns = rig.turns('lu').length
  const r6 = await scope('lu', 'low')
  p.check(`lu (Codex), parked: a change answers {next_turn, low, "${ONLY_CLAUDE}"}`, delivered(r6, 'next_turn', 'low', ONLY_CLAUDE), r6.effort_delivery)
  await rig.userMail('lu', 'Hello again.')
  await rig.waitTurns('lu', luTurns + 1)
  const t6 = turnStarts('lu').map(l => l.line.params?.effort)
  p.check('...and its next turn/start carries effort low', t6.at(-1) === 'low', t6)
  await play('lu', 'PROOF-LONG: work while your effort changes.')
  const r7 = await retool('lu', 'high')
  p.check(`lu mid-turn: orgtree_retool answers {next_turn, high, "${ONLY_CLAUDE}"}`, delivered(r7, 'next_turn', 'high', ONLY_CLAUDE), r7)
  await sleep(500)
  const v7 = await runtime('lu')
  p.check('...and its card shows the next level while the turn runs', v7.pending_effort === 'high' && v7.effort_current === 'low',
    { effort_current: v7.effort_current, pending_effort: v7.pending_effort })
  await rig.waitTurns('lu', luTurns + 2)
  await rig.userMail('lu', 'After the retool.')
  await rig.waitTurns('lu', luTurns + 3)
  const t7 = turnStarts('lu').map(l => l.line.params?.effort)
  p.check('...and its next turn/start carries effort high', t7.at(-1) === 'high', t7)

  // ---- an effort-only retool restarts nobody else
  const kidTurns = rig.turns('kid').length
  const kidStarts = starts('kid').length
  await rig.userMail('kid', 'A turn on your parked CLI.')
  await rig.waitTurns('kid', kidTurns + 1)
  p.check('control: kid\'s second turn ran on its parked CLI', starts('kid').length === kidStarts, starts('kid').map(s => s.pid))
  const r8 = await retool('ada', 'high')
  p.check('boss retools ada\'s effort while she is idle: {next_turn, high}', delivered(r8, 'next_turn', 'high', 'no turn is running'), r8)
  await rig.userMail('kid', 'After your superior\'s effort changed.')
  await rig.waitTurns('kid', kidTurns + 2)
  p.check('...and kid\'s next turn still runs on its parked CLI', starts('kid').length === kidStarts, starts('kid').map(s => s.pid))

  // ---- the desk, as the user sees it
  if (rig.run.ui) {
    const deskTurns = rig.turns('ada').length
    await play('ada', 'PROOF-DESK: work while the user changes your effort.')
    const deskSent = sends('ada').length
    const r = await runDesktop(rig, path.join(here, '../desktop/live-effort.cjs'),
      { args: { agent: 'ada', boss: 'boss', org: rig.org }, out: path.join(p.dir, 'desk'), timeout: 150000 })
    p.check('the desk script ran', r.ok, r.ok ? undefined : r)
    const v = r.value ?? {}
    p.check('desk: boss\'s retool mid-turn answers {sent, max}', delivered(v.retool?.json, 'sent', 'max'), v.retool?.json ?? v.retool)
    p.check('desk: after the retool the desk shows max and no next-turn effort card',
      v.afterRetool?.next?.length === 0 && v.afterRetool?.button === 'max', v.afterRetool)
    p.check('desk: the composer\'s effort dots set low and the toast says it was sent to the running agent',
      v.toast === 'ada thinking effort: low — sent to the running agent', v.toast)
    p.check('desk: after the composer change the desk shows low and no next-turn effort card',
      v.afterComposer?.next?.length === 0 && v.afterComposer?.button === 'low', v.afterComposer)
    const ds = sends('ada').slice(deskSent).map(l => l.line.request.settings?.effortLevel)
    p.check('desk: her running CLI was sent max, then low', JSON.stringify(ds) === '["max","low"]', ds)
    await rig.api('POST', `/api/orgs/${rig.org}/nodes/ada/interrupt`)
    await rig.waitTurns('ada', deskTurns + 1)
  } else {
    p.note('no --ui bundle: the desk checks were skipped')
  }

  p.keep(rig, { agents: ['ada', 'kid', 'lu'], grep: /effort|apply_flag_settings/i })
  return p.summary()
}
