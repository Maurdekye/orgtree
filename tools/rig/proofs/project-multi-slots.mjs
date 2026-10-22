// One lease reserves N slots, with all-or-nothing admission and strict FIFO.
import { Proof } from '../proof.mjs'
export async function setup() {
  return { recover: true, fixture: { org: { name: 'Multi slots' }, agents: [{ name: 'boss', tier: 'sol', grant: 100 }] } }
}
export default async function (rig) {
  const p = new Proof('project-multi-slots')
  rig.scenario({ default: { turns: [{ steps: [{ text: 'Grant received.' }] }] } })
  const settle = () => rig.waitFor(() => rig.sql('SELECT id FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'fixture turns', timeout: 60000 })
  await rig.op({ op: 'create_project', name: 'build', parent: 'boss' })
  await rig.op({ op: 'set_slots', node: 'build', capacity: 3 })
  for (const name of ['v', 'a', 'b', 'c', 'd']) await rig.op({ op: 'hire', name, parent: 'build', tier: 'sol', grant: 0 })
  await settle()
  let serial = 0
  const claim = (who, slots) => rig.tool(who, 'orgtree_watchdog', { action: 'create', name: `claim-${++serial}`, kind: 'slot', target: 'build', ...(slots === undefined ? {} : { slots }) })
  const status = async () => (await rig.tool('boss', 'orgtree_project', { action: 'slots', name: 'build' })).json
  const rows = () => rig.sql("SELECT l.uid,a.name AS holder,l.ended_at,l.end_reason, (to_jsonb(l)->>'slot_count')::int AS slots FROM ot.slot_leases l JOIN ot.agents a ON a.id=l.holder_agent_id ORDER BY l.id")
  const held = () => rows().filter(l => !l.ended_at)
  const release = async who => {
    const l = held().find(l => l.holder === who)
    return l ? rig.tool(who, 'orgtree_project', { action: 'release_slot', lease: l.uid, note: 'fixture complete' }) : { ok: false, text: 'no lease' }
  }
  for (const slots of [0, -1, 65, 1.5, '2', true, 4]) {
    const before = rig.one('SELECT count(*)::int AS n FROM ot.watchdogs').n
    const r = await claim('v', slots)
    p.check(`slots=${JSON.stringify(slots)} refused without a watchdog write`, !r.ok && rig.one('SELECT count(*)::int AS n FROM ot.watchdogs').n === before, r.text)
    if (r.ok) await release('v')
  }
  const wrong = await rig.tool('v', 'orgtree_watchdog', { action: 'create', name: 'wrong-kind', kind: 'project_listener', target: 'build', slots: 2 })
  p.check('slots only applies to a slot claim', !wrong.ok, wrong.text)
  if (wrong.ok) await rig.tool('v', 'orgtree_watchdog', { action: 'remove', id: 'wrong-kind' })
  const one = await claim('v')
  const oneStatus = await status()
  p.check('omitted slots keeps one-slot behavior and projects count one', one.ok && oneStatus?.held === 1 && oneStatus.holders[0]?.slots === 1 && held()[0]?.slots === 1, oneStatus)
  await release('v')

  const activity = who => rig.one(`SELECT
    (SELECT count(*) FROM ot.watchdogs WHERE owner_agent_id=a.id) AS dogs,
    (SELECT count(*) FROM ot.mail WHERE recipient_agent_id=a.id) AS mails,
    (SELECT count(*) FROM ot.turns WHERE agent_id=a.id) AS turns
    FROM ot.agents a WHERE a.org_id=(SELECT id FROM ot.orgs WHERE slug='${rig.org}') AND a.name='${who}'`)
  const inlineBefore = activity('a')
  const ca = await claim('a', 2)
  const first = await status()
  p.check('two slots are one lease and one holder', ca.ok && first?.held === 2 && first.holders.length === 1 && first.holders[0].slots === 2 && held().length === 1 && held()[0].slots === 2, { first, rows: held() })
  // USER 2026-10-21 18:05:58Z: ready one-shots return the full fire and
  // durable lease inline, without a watchdog, separate mail or holder wake.
  const inlineAfter = activity('a')
  p.check('grant result states the quantity', ca.ok && ca.json?.slots === 2 && ca.json?.resolved === true
    && ca.json?.registered === false && ca.json?.once === true && typeof ca.json?.lease === 'string'
    && ca.json.lease === first?.holders?.[0]?.lease && ca.json.lease === held()[0]?.uid
    && /You now hold 2 concurrency slots/.test(ca.json?.fire?.body ?? '')
    && Array.isArray(ca.json.fire.events) && ca.json.fire.events.length === 1 && ca.json.fire.events[0].includes(ca.json.lease)
    && JSON.stringify(inlineBefore) === JSON.stringify(inlineAfter),
    { result: ca.json, inlineBefore, inlineAfter, holder: first?.holders?.[0] })
  const cb = await claim('b', 2)
  const cc = await claim('c', 1)
  const queued = await status()
  p.check('head needing two blocks a smaller claim behind it even with one free', queued?.held === 2 && held().map(h => h.holder).join() === 'a' && queued.line.map(w => [w.agent, w.slots]).join('|') === 'b,2|c,1', queued)
  p.check('waiting result describes all-or-nothing FIFO without claiming every slot is held', cb.ok && cc.ok && /waiting for 2/.test(cb.text) && /FIFO/.test(cb.text) && !/every concurrency slot.*is held/.test(cb.text), cb.text)
  const list = await rig.tool('b', 'orgtree_watchdog', { action: 'list' })
  p.check('watchdog list preserves requested count and position', list.json?.watchdogs?.some(w => w.kind === 'slot' && w.slots === 2 && w.line_position === 1), list.json)
  await settle()
  const grantMails = rig.sql("SELECT body FROM ot.mail WHERE recipient_name='a' AND body LIKE '%SLOT GRANTED%'")
  // Keep the notification/once-delivery proof meaningful: this independent
  // project has a real queued watchdog, unlike a's immediately ready claim.
  await rig.op({ op: 'create_project', name: 'grant-proof', parent: 'v' })
  await rig.op({ op: 'set_slots', node: 'grant-proof', capacity: 2 })
  const blocker = await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: 'mail-blocker', kind: 'slot', target: 'grant-proof', slots: 2 })
  const queuedGrant = await rig.tool('v', 'orgtree_watchdog', { action: 'create', name: 'mail-two', kind: 'slot', target: 'grant-proof', slots: 2 })
  const queuedStatus = (await rig.tool('boss', 'orgtree_project', { action: 'slots', name: 'grant-proof' })).json
  const unblocked = await rig.tool('boss', 'orgtree_project', { action: 'release_slot', lease: blocker.json?.lease })
  await settle()
  const grantedStatus = (await rig.tool('boss', 'orgtree_project', { action: 'slots', name: 'grant-proof' })).json
  const grantMailRows = () => rig.sql("SELECT uid,body FROM ot.mail WHERE recipient_name='v' AND sender='mail-two' AND body LIKE '%SLOT GRANTED%'")
  const queuedMails = grantMailRows()
  const grantDog = rig.one("SELECT state,fired FROM ot.watchdogs WHERE name='mail-two' AND owner_agent_id=(SELECT id FROM ot.agents WHERE name='v' AND org_id=(SELECT id FROM ot.orgs WHERE slug='" + rig.org + "'))")
  const queuedLease = grantedStatus?.holders?.[0]?.lease
  const releasedNotification = await rig.tool('v', 'orgtree_project', { action: 'release_slot', lease: queuedLease })
  await settle()
  const onceMails = grantMailRows()
  const inlineSettled = activity('a')
  p.check('one grant notification names both slots', grantMails.length === 0
    && JSON.stringify(inlineBefore) === JSON.stringify(inlineSettled)
    && blocker.ok && blocker.json?.registered === false && queuedGrant.ok && unblocked.ok
    && queuedStatus?.line?.length === 1 && queuedStatus.line[0].agent === 'v' && queuedStatus.line[0].slots === 2
    && grantedStatus?.held === 2 && grantedStatus.holders.length === 1 && grantedStatus.holders[0].slots === 2
    && grantDog?.state === 'spent' && grantDog.fired === 1 && queuedMails.length === 1
    && /2 concurrency slots/.test(queuedMails[0].body) && typeof queuedLease === 'string' && queuedMails[0].body.includes(queuedLease)
    && releasedNotification.ok && releasedNotification.json?.slots === 2
    && onceMails.length === 1 && onceMails[0].uid === queuedMails[0].uid,
    { grantMails, inlineBefore, inlineSettled, queuedStatus, grantedStatus, queuedMails, grantDog, released: releasedNotification.json, onceMails })
  await rig.restart()
  await settle()
  const restored = await status()
  p.check('restart preserves held quantity and blocked FIFO order', restored?.held === 2 && restored.holders.length === 1 && restored.holders[0].slots === 2 && restored.line.map(w => [w.agent, w.slots]).join('|') === 'b,2|c,1', restored)

  const rel = await release('a')
  const filled = await status()
  p.check('release frees all two slots then grants two-plus-one as separate complete leases', rel.ok && rel.json?.slots === 2 && filled?.held === 3 && filled.holders.map(h => [h.agent, h.slots]).sort().join('|') === 'b,2|c,1' && filled.line.length === 0, { release: rel.json, filled })
  const bLease = held().find(h => h.holder === 'b')
  if (bLease) await rig.op({ op: 'slot_release', lease: bLease.uid, force: true })
  const forced = await status()
  p.check('force-release ends the whole lease and history retains its quantity', forced?.held === 1 && forced.history.some(h => h.lease === bLease?.uid && h.slots === 2 && /forced/.test(h.how)), forced)
  await claim('a', 3)
  await claim('d', 1)
  const headThree = await status()
  p.check('a three-slot head blocks the one-slot tail with two free', headThree?.held === 1 && headThree.line.map(w => [w.agent, w.slots]).join('|') === 'a,3|d,1', headThree)
  await rig.op({ op: 'halt', nodes: ['c'] })
  const halted = await status()
  p.check('halt reclaims a lease then grants the full head claim', halted?.held === 3 && halted.holders.length === 1 && halted.holders[0].agent === 'a' && halted.holders[0].slots === 3 && halted.line[0]?.agent === 'd', halted)
  await release('a')
  const tail = await status()
  p.check('releasing three slots admits the remaining tail once', tail?.held === 1 && tail.holders.length === 1 && tail.holders[0].agent === 'd' && tail.line.length === 0, tail)
  await release('d')
  await rig.op({ op: 'unhalt', nodes: ['c'] })

  // Simultaneous admissions serialize on the project row; neither gets a partial grant.
  await Promise.all([claim('b', 2), claim('c', 2)])
  const concurrent = await status()
  p.check('concurrent two-slot claims never oversubscribe or split a lease', concurrent?.held === 2 && concurrent.holders.length === 1 && concurrent.holders[0].slots === 2 && concurrent.line.length === 1 && concurrent.line[0].slots === 2, concurrent)
  const owner = concurrent?.holders?.[0]?.agent
  if (owner) await rig.op({ op: 'halt', nodes: [owner] })
  const reclaimed = await status()
  p.check('halting a multi-slot holder frees every unit for the next complete claim', reclaimed?.held === 2 && reclaimed.holders.length === 1 && reclaimed.holders[0].agent !== owner && reclaimed.holders[0].slots === 2 && reclaimed.line.length === 0, reclaimed)
  const latest = held()[0]
  if (latest) await release(latest.holder)
  await settle()
  p.file('leases.json', rows())
  p.keep(rig, { agents: ['a', 'b', 'c', 'd', 'boss'], grep: /slot|lease/i })
  return p.summary()
}
