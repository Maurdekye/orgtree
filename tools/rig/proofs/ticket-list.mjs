// Proof: a fresh session starts with the agent's live docket items (decision
// 64; user 2026-10-09: "chats should receive a list of all their assigned
// tickets every time they start a fresh session so they dont drop work").
// Rulings: a one-time snapshot in the fresh-session note, never in the
// instructions or a fingerprint ("changing that set shouldnt invalidate their
// session, its only sent once at the start"), and live statuses only ("dont
// include terminal tickets that would be archived after enough time").
//   tara (Claude): owns an item in each live status (open, in_progress,
//   blocked, review, approved, deploy_ready), one backlogged, one done, one
//   dropped and one archived; she is the reviewer of boss's item in review
//   and of another still in progress. Cheap-compacted, her next turn's note
//   lists the live ones newest first with status and first next step, the
//   backlogged one apart, the one waiting for her review, and none of the
//   rest. Her instructions name none of them. A docket change afterwards
//   replaces no CLI, and her next turn does not repeat the list.
//   vic (Claude, switched to Codex): owns 33 open items. The provider switch
//   starts a fresh session whose note lists the 30 newest and says 3 more,
//   with the orgtree_work call that lists them all.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/ticket-list.mjs

import fs from 'node:fs'

import { Proof } from '../proof.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const HEAD = 'Your live docket items, as this session starts'

export default async function (rig) {
  const p = new Proof('ticket-list')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'tara', parent: 'boss', tier: 'haiku', title: 'Ticket holder' })
  await rig.op({ op: 'hire', name: 'vic', parent: 'boss', tier: 'haiku', title: 'Busy ticket holder' })
  const idle = name => rig.turns(name).every(t => t.ended_at)
  const settle = (...names) => rig.waitFor(() => names.every(idle), { what: `${names.join(', ')} to be idle`, timeout: 90000 })
  const turn = async (name, text) => {
    await settle(name)
    const done = rig.turns(name).length
    await rig.userMail(name, text)
    await rig.waitTurns(name, done + 1)
  }
  const work = async (who, args) => {
    const r = await rig.tool(who, 'orgtree_work', args)
    if (!r.ok) throw new Error(`${who} orgtree_work ${args.action}: ${r.text}`)
    return r.json
  }
  // an item owned by `who`, then one update to `status` with its next step
  const item = async (who, key, status, extra = {}) => {
    const slug = (await work(who, { action: 'create', kind: 'code', title: `${who} ${key} ticket`, owner: who,
      objective: `The ${key} ticket of the ticket-list proof.\n\nNothing depends on it.` })).slug
    if (status) {
      await work(who, { action: 'update', slug, status, done_so_far: ['started'], working_on_next: [`NEXT-${key} first step`, 'a later step'], ...extra })
    }
    return slug
  }
  const prompts = name => rig.fakeLog(name).filter(l => l.kind === 'turn').map(l => l.prompt ?? '')
  const starts = name => rig.fakeLog(name).filter(l => l.kind === 'start')
  const identity = name => {
    const args = starts(name).at(-1)?.args ?? []
    const at = args.indexOf('--append-system-prompt-file')
    const file = at >= 0 ? args[at + 1] : null
    return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  }
  const section = text => {
    const i = text.indexOf(HEAD)
    return i < 0 ? '' : text.slice(i, text.indexOf('\n\n', i) + 1 || undefined)
  }

  // ---------------------------------------------------------------- tara
  await turn('tara', 'Hello tara, first turn.')
  const t = {}
  t.open = await item('tara', 'open', 'open')
  t.progress = await item('tara', 'progress', 'in_progress')
  t.blocked = await item('tara', 'blocked', 'blocked', { blocked_reason: 'waiting for the proof to finish' })
  t.review = await item('tara', 'review', 'review', { reviewer: 'boss' })
  t.approved = await item('tara', 'approved', 'approved')
  t.backlog = await item('tara', 'backlog', 'backlogged')
  t.done = await item('tara', 'done', 'done')
  t.dropped = await item('tara', 'dropped', 'dropped', { dropped_reason: 'cancelled by the proof; nothing would make it worth resuming' })
  t.archived = await item('tara', 'archived', 'done')   // archive closes only finished items
  await work('tara', { action: 'archive', slug: t.archived })
  t.deploy = await item('tara', 'deploy', 'deploy_ready')
  const reviewing = await item('boss', 'reviewing', 'review', { reviewer: 'tara' })
  const notYet = await item('boss', 'not-yet', 'in_progress', { reviewer: 'tara' })
  await settle('tara', 'boss')

  const cc = await rig.tool('boss', 'orgtree_cheap_compact', { node: 'tara' })
  p.check('tara: her superior cheap-compacts her', cc.ok, cc.text?.slice(0, 200))
  await turn('tara', 'Carry on after the compact, please.')
  const note = prompts('tara').at(-1) ?? ''
  const list = section(note)
  const live = ['open', 'progress', 'blocked', 'review', 'approved', 'deploy']
  const status = { open: 'open', progress: 'in_progress', blocked: 'blocked', review: 'review', approved: 'approved', deploy: 'deploy_ready' }
  p.check('tara: her fresh-session note lists each live item she owns with its status and first next step',
    live.every(k => list.includes(`- ${t[k]} · ${status[k]} · `) && list.includes(`NEXT-${k} first step`)),
    { list: list.slice(0, 1600) })
  p.check('tara: newest updated first (deploy_ready, updated last, before open, updated first)',
    list.indexOf(t.deploy) >= 0 && list.indexOf(t.deploy) < list.indexOf(t.open), { deploy: list.indexOf(t.deploy), open: list.indexOf(t.open) })
  p.check('tara: the backlogged item is listed apart, as backlogged',
    /Backlogged, not started yet:\n- /.test(list) && list.indexOf(t.backlog) > list.indexOf('Backlogged, not started yet:'), { at: list.indexOf(t.backlog) })
  p.check('tara: boss\'s item in review that names her as reviewer is listed as waiting for her review; his item still in progress is not',
    list.indexOf(reviewing) > list.indexOf('Waiting for your review:') && list.includes(`(owner boss)`) && !list.includes(notYet),
    { reviewing: list.indexOf(reviewing), notYet: list.includes(notYet) })
  p.check('tara: no terminal item: the done, dropped and archived ones are not listed',
    !list.includes(t.done) && !list.includes(t.dropped) && !list.includes(t.archived), { list: list.slice(0, 400) })
  const own = identity('tara')
  p.check('tara: her instructions name none of her items (the list is not in the identity)',
    own.length > 0 && Object.values(t).every(s => !own.includes(s)) && !own.includes(HEAD), { bytes: own.length })

  // a docket change afterwards: no respawn, and the list is not sent again
  const cliBefore = starts('tara').length
  await work('tara', { action: 'update', slug: t.open, status: 'in_progress', done_so_far: ['moved on'], working_on_next: ['NEXT-later'] })
  await pause(25000)
  await turn('tara', 'One more turn, please.')
  const after = prompts('tara').at(-1) ?? ''
  p.check('tara: a docket change afterwards replaces no CLI, and her next turn does not repeat the list',
    starts('tara').length === cliBefore && !after.includes(HEAD), { starts: [cliBefore, starts('tara').length], repeated: after.includes(HEAD) })

  // ---------------------------------------------------------------- vic
  await turn('vic', 'Hello vic, first turn.')
  const vic = []
  for (let n = 1; n <= 33; n++) vic.push(await item('vic', `bulk-${String(n).padStart(2, '0')}`, 'open'))
  await settle('vic')
  const sw = await rig.op({ op: 'switch_model', node: 'vic', tier: 'luna' })
  p.check('vic: idle, his switch to Codex (luna) applies at once', sw?.queued !== true && sw?.tier === 'luna', sw)
  await turn('vic', 'Carry on after the switch, please.')
  const vlist = section(prompts('vic').at(-1) ?? '')
  const shown = vic.filter(s => vlist.includes(`- ${s} · `))
  p.check('vic: the provider switch\'s fresh session lists his 30 newest items and says 3 more, with the call that lists them all',
    shown.length === 30 && vic.slice(3).every(s => shown.includes(s))
      && vlist.includes('…and 3 more not shown: orgtree_work action=list include_backlogged=true'),
    { shown: shown.length, missing: vic.filter(s => !shown.includes(s)), tail: vlist.slice(-200) })

  p.keep(rig, { agents: ['tara', 'vic'] })
  return p.summary()
}
