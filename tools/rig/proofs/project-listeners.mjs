// Proof: project event listeners (docket
// project-event-listeners-sync-monitor-watchdogs-l; user 2026-10-19
// 07:40Z), through the real engine.
//   agents above or below a project arm `project_listener` watchdogs
//   (one per agent per project) and receive its fired events, one-shot
//   or continuous; `orgtree_project action=fire_event` fires to all of
//   them at once, carrying a message; only the line above/below may
//   a `listener_watch` fires at a count of armed listeners — at once
//   when already satisfied, and again only after a drop and re-cross
//   `fire_actions` run at fire time with the firing agent's authority:
//   a watch carrying fire_event releases every listener in one instant
//   a self-firing listener chain stops at the depth limit
//   listeners survive an engine restart; fair_queue refuses fire_actions
// Run: node tools/rig/rig.mjs run tools/rig/proofs/project-listeners.mjs

import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('project-listeners')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const settle = what => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what, timeout: 60000 }).catch(() => {})
  await settle('seed turns to settle')
  const said = r => (r?.ok ? JSON.stringify(r.json ?? r.text) : String(r?.text)).slice(0, 400)
  const opTry = body => rig.op(body).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const node = name => rig.one(`SELECT id, name, state FROM ot.agents
                                  WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active') AND name = '${name}'`)
  const mails = (who, like) => rig.sql(`SELECT body FROM ot.mail WHERE recipient_agent_id = ${node(who).id} AND body LIKE '%${like}%' ORDER BY id`)
  const dogState = (who, name) => rig.one(`SELECT state, fired FROM ot.watchdogs WHERE owner_agent_id = ${node(who).id} AND name = '${name}'`)
  const listen = (who, name, project, once = true, extra = {}) =>
    rig.tool(who, 'orgtree_watchdog', { action: 'create', name, kind: 'project_listener', target: project, once, ...extra })

  // ------------------------------------------------------------ the sync project
  const made = await opTry({ op: 'create_project', name: 'sync', parent: 'boss', description: 'A rendezvous.' })
  const hires = []
  for (const n of ['sa', 'sb']) hires.push(await opTry({ op: 'hire', name: n, parent: 'sync', tier: 'haiku', grant: 0, title: `Worker ${n}` }))
  await settle('hire turns')
  p.check('the project and its two workers exist', made.ok && hires.every(h => h.ok), { made: made.ok, hires: hires.map(h => h.ok) })

  const la = await listen('sa', 'ready-a', 'sync', true)
  const lb = await listen('sb', 'ready-b', 'sync', false)
  p.check('agents below the project arm event listeners on it', la.ok && lb.ok
    && /Each event fired on project sync/.test(la.text), { sa: said(la), sb: said(lb) })
  const twice = await listen('sa', 'second', 'sync', true)
  p.check('one event listener per agent per project', !twice.ok && /already/.test(twice.text), said(twice))
  const outsider = await listen('carol', 'nosey', 'sync', true)
  p.check('only agents above or below the project listen on it', !outsider.ok && /above or below/.test(outsider.text), said(outsider))
  const patterned = await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: 'p2', kind: 'project_listener', target: 'sync', pattern: 'go' })
  p.check('a listener takes every event: no pattern', !patterned.ok && /no pattern/.test(patterned.text), said(patterned))

  // The headline flow: the superior's watch is already satisfied, fires at
  // once, and its fire action releases everyone in the same instant.
  const watch = await rig.tool('boss', 'orgtree_watchdog', {
    action: 'create', name: 'all-in', kind: 'listener_watch', target: 'sync', count: 2, once: true,
    fire_actions: [{ tool: 'orgtree_project', args: { action: 'fire_event', name: 'sync', body: 'go: start build 7' } }],
  })
  await rig.waitFor(() => mails('sa', 'go: start build 7').length === 1 && mails('sb', 'go: start build 7').length === 1,
    { what: 'both workers released', timeout: 30000 }).catch(() => {})
  p.check('a satisfied watch fires at once, and its fire action releases every listener with the message',
    watch.ok && /FIRED at once/.test(watch.text)
    && mails('sa', 'go: start build 7').length === 1 && mails('sb', 'go: start build 7').length === 1,
    { watch: said(watch), sa: mails('sa', 'go: start build 7').length, sb: mails('sb', 'go: start build 7').length })
  await rig.waitFor(() => mails('boss', 'LISTENERS READY').length === 1, { what: 'the watch fire mail', timeout: 30000 }).catch(() => {})
  const bossMail = mails('boss', 'LISTENERS READY')[0]?.body ?? ''
  p.check('the watch mail carries the fire-action result (run as the superior, at fire time)',
    /Fire actions/.test(bossMail) && /orgtree_project: ok/.test(bossMail) && /delivered/.test(bossMail), bossMail.slice(0, 400))
  p.check('the one-shot listener is spent by the fire; the continuous one lives',
    dogState('sa', 'ready-a')?.state === 'spent' && dogState('sb', 'ready-b')?.state === 'armed',
    { sa: dogState('sa', 'ready-a'), sb: dogState('sb', 'ready-b') })

  // ------------------------------------------------------------ watch armed first, manual fire
  const made2 = await opTry({ op: 'create_project', name: 'sync2', parent: 'boss', description: 'Second rendezvous.' })
  for (const n of ['sd', 'se']) await opTry({ op: 'hire', name: n, parent: 'sync2', tier: 'haiku', grant: 0, title: `Worker ${n}` })
  await settle('sync2 hire turns')
  const early = await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: 'pair', kind: 'listener_watch', target: 'sync2', count: 2, once: true })
  p.check('a watch armed before its listeners waits, and says the count so far',
    made2.ok && early.ok && /has 0 of 2 event listeners armed/.test(early.text), said(early))
  await listen('sd', 'sd-here', 'sync2', false)
  await settle('one listener')
  p.check('one of two does not fire the watch', mails('boss', 'sync2 now has').length === 0, mails('boss', 'sync2 now has'))
  await listen('se', 'se-here', 'sync2', false)
  await rig.waitFor(() => mails('boss', 'sync2 now has 2 event listeners armed').length === 1,
    { what: 'the watch fires at the second listener', timeout: 30000 }).catch(() => {})
  p.check('arming the second listener fires the watch', mails('boss', 'sync2 now has 2 event listeners armed').length === 1,
    mails('boss', 'sync2 now has'))
  const firedManually = await rig.tool('boss', 'orgtree_project', { action: 'fire_event', name: 'sync2', body: 'manual release' })
  await rig.waitFor(() => mails('sd', 'manual release').length === 1 && mails('se', 'manual release').length === 1,
    { what: 'the manual fire lands', timeout: 30000 }).catch(() => {})
  p.check('fire_event delivers to every armed listener at once and reports who',
    firedManually.ok && firedManually.json?.delivered === 2
    && JSON.stringify([...(firedManually.json?.delivered_to ?? [])].sort()) === JSON.stringify(['sd', 'se'])
    && mails('sd', 'manual release').length === 1, said(firedManually))
  const carolFire = await rig.tool('carol', 'orgtree_project', { action: 'fire_event', name: 'sync2' })
  p.check('an agent off the line cannot fire the event', !carolFire.ok && /above or below/.test(carolFire.text), said(carolFire))
  const listed = await rig.tool('boss', 'orgtree_project', { action: 'listeners', name: 'sync2' })
  p.check('action=listeners names the listeners (a spent watch is gone, as in watchdog list)',
    listed.ok && listed.json?.listeners_armed === 2
    && (listed.json?.listeners ?? []).map(l => l.agent).sort().join() === 'sd,se'
    && !(listed.json?.watches ?? []).some(w => w.dog === 'pair'), said(listed))

  // ------------------------------------------------------------ continuous re-cross
  const again = await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: 'pair-again', kind: 'listener_watch', target: 'sync2', count: 2 })
  await rig.waitFor(() => (dogState('boss', 'pair-again')?.fired ?? 0) === 1, { what: 'the continuous watch fires at once', timeout: 30000 }).catch(() => {})
  p.check('a continuous watch armed when satisfied fires once, then stays quiet above the count',
    again.ok && (dogState('boss', 'pair-again')?.fired ?? 0) === 1, { said: said(again), dog: dogState('boss', 'pair-again') })
  await rig.tool('sd', 'orgtree_watchdog', { action: 'pause', id: 'sd-here' })
  await settle('below the count')
  p.check('dropping below the count does not fire (it re-arms the edge)',
    (dogState('boss', 'pair-again')?.fired ?? 0) === 1, dogState('boss', 'pair-again'))
  await rig.tool('sd', 'orgtree_watchdog', { action: 'resume', id: 'sd-here' })
  await rig.waitFor(() => (dogState('boss', 'pair-again')?.fired ?? 0) === 2, { what: 'the re-cross fires again', timeout: 30000 }).catch(() => {})
  p.check('crossing the count again fires a continuous watch a second time',
    (dogState('boss', 'pair-again')?.fired ?? 0) === 2, dogState('boss', 'pair-again'))

  // ------------------------------------------------------------ the depth limit
  await opTry({ op: 'create_project', name: 'loop', parent: 'boss', description: 'A self-firing testbed.' })
  await opTry({ op: 'hire', name: 'sl', parent: 'loop', tier: 'haiku', grant: 0, title: 'Looper' })
  await settle('loop hires')
  const selfFire = await listen('sl', 'echo', 'loop', false, {
    fire_actions: [{ tool: 'orgtree_project', args: { action: 'fire_event', name: 'loop' } }],
  })
  await rig.tool('boss', 'orgtree_project', { action: 'fire_event', name: 'loop' })
  await rig.waitFor(() => mails('sl', 'SKIPPED').length === 1, { what: 'the chain hits the depth limit', timeout: 60000 }).catch(() => {})
  const echoes = mails('sl', 'PROJECT EVENT')
  p.check('a listener whose fire action fires its own project stops at the depth limit (5 fires, the last skipped)',
    selfFire.ok && echoes.length === 5 && /depth limit \(4\)/.test(echoes.at(-1)?.body ?? ''),
    { count: echoes.length, last: (echoes.at(-1)?.body ?? '').slice(-300) })

  // ------------------------------------------------------------ refusals and restart
  const fqActions = await rig.tool('sa', 'orgtree_watchdog', {
    action: 'create', name: 'queue-dog', kind: 'fair_queue', target: 'sync',
    fire_actions: [{ tool: 'orgtree_chart' }],
  })
  p.check('a fair_queue watchdog cannot carry fire actions (its fire is a handed mail)',
    !fqActions.ok && /cannot carry fire_actions/.test(fqActions.text), said(fqActions))
  await rig.restart()
  await settle('after restart')
  p.check('armed listeners and watches survive an engine restart',
    dogState('sb', 'ready-b')?.state === 'armed' && dogState('boss', 'pair-again')?.state === 'armed',
    { sb: dogState('sb', 'ready-b'), watch: dogState('boss', 'pair-again') })
  const after = await rig.tool('boss', 'orgtree_project', { action: 'fire_event', name: 'sync', body: 'after the restart' })
  await rig.waitFor(() => mails('sb', 'after the restart').length === 1, { what: 'the post-restart fire lands', timeout: 30000 }).catch(() => {})
  p.check('and the surviving listener receives the next fire', after.ok && mails('sb', 'after the restart').length === 1, said(after))

  p.file('dogs.json', rig.sql(`SELECT kind, name, state, fired FROM ot.watchdogs WHERE kind IN ('project_listener','listener_watch') ORDER BY id`))
  p.keep(rig, { agents: ['sa', 'sb', 'sd', 'se', 'sl', 'boss'], grep: /listener|PROJECT EVENT|LISTENERS READY/i })
  return p.summary()
}
