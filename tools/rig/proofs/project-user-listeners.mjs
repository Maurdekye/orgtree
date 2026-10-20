// Proof: the USER registers a project event listener and a listener watch
// themselves (docket let-the-user-manually-hold-a-number-of-a-project; user
// 2026-10-20 13:03Z "allow them to register an event listener or listen
// watcher manually", 13:04Z "they both arrive as normal mail in your
// inbox"), through the real engine and the user's ops.
//   user_listener_register: an event listener with no agent owner; it
//   switches the project's event listeners on; the project's fire delivers
//   it as ordinary mail in the user's inbox; "once" is spent by its first fire
//   the user's listener COUNTS toward listener watches (an agent's watch
//   fires when the user's listener completes its count) and toward
//   action=listeners (named "user"); user_watch_register is a one-time
//   notification in their inbox when the count is reached (at once if it is)
//   the event-listeners OFF switch disables the user's dogs too, and ON
//   restores them; a restart keeps them
//   only the user ends them: user_registration_remove; one of each per project
//   refusals: a count out of range, an agent as target, a second of a kind
// Run: node tools/rig/rig.mjs run tools/rig/proofs/project-user-listeners.mjs

import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('project-user-listeners')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const settle = what => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what, timeout: 60000 }).catch(() => {})
  await settle('seed turns to settle')
  const said = r => (r?.ok ? JSON.stringify(r.json ?? r.v ?? r.text) : String(r?.text ?? r?.error)).slice(0, 400)
  const opTry = body => rig.op(body).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const safe = (fn, dflt) => { try { return fn() } catch { return dflt } }
  const org = () => rig.one(`SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active'`).id
  const node = name => rig.one(`SELECT id, name, state, scope FROM ot.agents WHERE org_id = ${org()} AND name = '${name}' AND state <> 'deleted'`)
  // the user's registrations (a red run has no owner_kind column)
  const userDogs = (kind) => safe(() => rig.sql(`SELECT id, uid, kind, state, once, fired, owner_agent_id, owner_kind, memo FROM ot.watchdogs
                                  WHERE owner_kind = 'user' ${kind ? `AND kind = '${kind}'` : ''} ORDER BY id`), [])
  const userMail = like => safe(() => rig.sql(`SELECT uid, sender, kind, body, recipient_kind, recipient_name, ev FROM ot.mail
                                  WHERE recipient_kind = 'user' AND body LIKE '%${like}%' ORDER BY id`), [])
  const agentMail = (who, like) => rig.sql(`SELECT body FROM ot.mail WHERE recipient_agent_id = ${node(who).id} AND body LIKE '%${like}%' ORDER BY id`)
  const dog = (who, name) => rig.one(`SELECT state, fired FROM ot.watchdogs WHERE owner_agent_id = ${node(who).id} AND name = '${name}' ORDER BY id DESC LIMIT 1`)
  const listen = (who, name, project, once = false) => rig.tool(who, 'orgtree_watchdog', { action: 'create', name, kind: 'project_listener', target: project, once, notice: true })
  const listeners = async (who = 'boss') => (await rig.tool(who, 'orgtree_project', { action: 'listeners', name: 'sync' })).json ?? {}
  const enabled = () => node('sync')?.scope?.event_listeners === true
  const tree = async () => {
    const s = await rig.api('GET', `/api/orgs/${rig.org}/records`)
    return (s.records ?? []).find(r => r.entity === 'org' && r.id === 'watchdogs')?.body ?? {}
  }

  // ------------------------------------------------------------ a project, three workers
  const made = await opTry({ op: 'create_project', name: 'sync', parent: 'boss', description: 'A rendezvous.' })
  const hires = []
  for (const n of ['sa', 'sb']) hires.push(await opTry({ op: 'hire', name: n, parent: 'sync', tier: 'haiku', grant: 0, title: `Worker ${n}` }))
  await settle('hire turns')
  p.check('a project with two workers; its event listeners start off', made.ok && hires.every(h => h.ok) && !enabled(), { made: made.ok })

  // ------------------------------------------------------------ the user listens
  const reg = await opTry({ op: 'user_listener_register', node: 'sync', once: false })
  const ud = userDogs('project_listener')[0]
  p.check('the user registers an event listener: a dog with no agent owner, armed', reg.ok && ud?.state === 'armed' && ud?.owner_agent_id === null
    && ud?.owner_kind === 'user' && ud?.once === false, { reg: reg.ok ? reg.v : reg.error, dogs: userDogs() })
  p.check('registering switched the project\'s event listeners on, as an agent\'s listener does', enabled(), node('sync')?.scope)
  const again = await opTry({ op: 'user_listener_register', node: 'sync' })
  p.check('the user keeps one event listener per project', !again.ok && /already keep/.test(again.error ?? ''), again)

  // ------------------------------------------------------------ the user's listener counts toward an agent's watch
  const watch = await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: 'pair', kind: 'listener_watch', target: 'sync', count: 2, once: true, notice: true })
  p.check('an agent\'s watch counts the user\'s listener (1 of 2 armed, so it waits)', watch.ok && /has 1 of 2 event listeners armed/.test(watch.text), said(watch))
  const la = await listen('sa', 'ready-a', 'sync')
  await rig.waitFor(() => agentMail('boss', 'sync now has 2 event listeners armed').length === 1,
    { what: 'the watch fires when the second listener (an agent) arrives', timeout: 30000 }).catch(() => {})
  p.check('the watch fires when an agent completes the count the user started', la.ok && agentMail('boss', 'sync now has 2 event listeners armed').length === 1
    && dog('boss', 'pair')?.state === 'spent', { la: said(la), mails: agentMail('boss', 'sync now has').length })
  const ls = await listeners('boss')
  p.check('action=listeners counts the user\'s listener and names it "user"', ls.listeners_armed === 2
    && (ls.listeners ?? []).map(l => l.agent).sort().join() === 'sa,user', ls)
  const lt = await tree()
  const links = (lt.watchdog_project_links ?? []).filter(w => w.owner === 'user')
  p.check('the tree carries the user\'s registration, owner "user", for the desk to draw as "you"', links.length === 1 && links[0].kind === 'project_listener'
    && links[0].id === `user/${ud?.uid}` && links[0].metadata_only === true, links.map(l => ({ id: l.id, kind: l.kind })))

  // ------------------------------------------------------------ the event arrives in the user's inbox
  const fired = await opTry({ op: 'fire_project_event', node: 'sync', body: 'go: start build 7' })
  await rig.waitFor(() => userMail('go: start build 7').length === 1 && agentMail('sa', 'go: start build 7').length === 1,
    { what: 'the event reaches the user and sa', timeout: 30000 }).catch(() => {})
  const m1 = userMail('go: start build 7')[0]
  p.check('a fired event reaches the user as normal mail in their inbox, beside the agents\'', fired.ok && userMail('go: start build 7').length === 1
    && m1?.kind === 'watchdog' && m1?.recipient_name === '@user' && /PROJECT EVENT/.test(m1?.body ?? '') && agentMail('sa', 'go: start build 7').length === 1,
    { fired: fired.ok ? fired.v : fired.error, mail: m1 && { kind: m1.kind, to: m1.recipient_name, body: m1.body?.slice(0, 160) } })
  p.check('the user\'s fire mail carries the watchdog event (a card, as an agent\'s)', /watchdog_fired/.test(JSON.stringify(m1?.ev ?? '')), m1?.ev)
  p.check('a continuous listener stays armed after its fire', userDogs('project_listener')[0]?.state === 'armed' && userDogs('project_listener')[0]?.fired === 1, userDogs('project_listener'))

  // ------------------------------------------------------------ once is spent by its fire
  const rm = await opTry({ op: 'user_registration_remove', node: 'sync', dog: ud?.uid })
  p.check('the user removes their own listener', rm.ok && userDogs('project_listener')[0]?.state === 'removed', { rm: rm.ok ? rm.v : rm.error, dogs: userDogs() })
  const lsAfter = await listeners('boss')
  p.check('removing it drops the count the watches read', lsAfter.listeners_armed === 1 && (lsAfter.listeners ?? []).map(l => l.agent).join() === 'sa', lsAfter)
  const reg2 = await opTry({ op: 'user_listener_register', node: 'sync', once: true })
  const fire2 = await opTry({ op: 'fire_project_event', node: 'sync', body: 'second call' })
  await rig.waitFor(() => userMail('second call').length === 1, { what: 'the one-shot user listener hears the event', timeout: 30000 }).catch(() => {})
  const spent = userDogs('project_listener').find(d => d.state === 'spent')
  p.check('a one-shot (next event only) listener is spent by its first fire', reg2.ok && fire2.ok && userMail('second call').length === 1 && !!spent && spent.fired === 1,
    userDogs('project_listener'))
  const fire3 = await opTry({ op: 'fire_project_event', node: 'sync', body: 'third call' })
  await settle('third fire')
  p.check('a spent user listener hears nothing more', fire3.ok && userMail('third call').length === 0 && agentMail('sa', 'third call').length === 1, { u: userMail('third call').length })

  // ------------------------------------------------------------ the user's watch
  const reg3 = await opTry({ op: 'user_listener_register', node: 'sync' })
  const w3 = await opTry({ op: 'user_watch_register', node: 'sync', count: 3 })
  const wdog = userDogs('listener_watch')[0]
  p.check('the user registers a listener watch (3): armed, one-shot, no notification yet', reg3.ok && w3.ok && wdog?.state === 'armed' && wdog?.once === true
    && userMail('LISTENERS READY').length === 0, { w3: w3.ok ? w3.v : w3.error, dogs: userDogs() })
  const lb = await listen('sb', 'ready-b', 'sync')
  await rig.waitFor(() => userMail('LISTENERS READY').length === 1, { what: 'the user\'s watch fires at three listeners', timeout: 30000 }).catch(() => {})
  const wm = userMail('LISTENERS READY')[0]
  p.check('the third listener (an agent) completes the count: one notification arrives in the user\'s inbox, and the watch is spent',
    lb.ok && !!wm && wm.recipient_kind === 'user' && /now has 3 event listeners armed/.test(wm.body) && userDogs('listener_watch')[0]?.state === 'spent',
    { lb: said(lb), mail: wm?.body?.slice(0, 200), dogs: userDogs('listener_watch') })
  const w4 = await opTry({ op: 'user_watch_register', node: 'sync', count: 2 })
  await rig.waitFor(() => userMail('LISTENERS READY').length === 2, { what: 'an already-satisfied watch fires at once', timeout: 30000 }).catch(() => {})
  p.check('a watch whose count is already reached fires at once', w4.ok && userMail('LISTENERS READY').length === 2, { w4: w4.ok ? w4.v : w4.error, n: userMail('LISTENERS READY').length })

  // ------------------------------------------------------------ the switch and a restart
  const off = await opTry({ op: 'set_event_listeners', node: 'sync', enabled: false })
  const paused = userDogs('project_listener').find(d => d.state === 'paused')
  p.check('the project\'s event-listeners OFF disables the user\'s listener too (paused, marked)', off.ok && !enabled() && !!paused && paused.memo?.listeners_off === true,
    { off: off.ok ? off.v : off.error, dogs: userDogs('project_listener') })
  const noFire = await opTry({ op: 'fire_project_event', node: 'sync', body: 'while off' })
  p.check('with the setting off nothing fires and nothing reaches the user', !noFire.ok && userMail('while off').length === 0, noFire)
  const on = await opTry({ op: 'set_event_listeners', node: 'sync', enabled: true })
  await settle('restore')
  const restored = userDogs('project_listener').find(d => d.state === 'armed')
  p.check('ON restores exactly the dogs the switch disabled, the user\'s listener among them', on.ok && enabled() && !!restored, { on: on.ok ? on.v : on.error, dogs: userDogs('project_listener') })
  await rig.restart()
  await settle('after restart')
  const fire4 = await opTry({ op: 'fire_project_event', node: 'sync', body: 'after restart' })
  await rig.waitFor(() => userMail('after restart').length === 1, { what: 'the user\'s listener still hears the event after a restart', timeout: 30000 }).catch(() => {})
  p.check('the user\'s listener survives an engine restart and hears the next event', fire4.ok && userMail('after restart').length === 1, { fire4: fire4.ok ? fire4.v : fire4.error })

  // ------------------------------------------------------------ refusals
  const keep = await opTry({ op: 'user_watch_register', node: 'sync', count: 50 })
  const badCount = await opTry({ op: 'user_watch_register', node: 'sync', count: 0 })
  const bigCount = await opTry({ op: 'user_watch_register', node: 'sync', count: 5000 })
  const onAgent = await opTry({ op: 'user_listener_register', node: 'sa' })
  const dupWatch = await opTry({ op: 'user_watch_register', node: 'sync', count: 2 })
  const noSuch = await opTry({ op: 'user_registration_remove', node: 'sync', dog: 'nosuchdog' })
  p.check('refused: a count out of range, an agent as the target, a second watch, an unknown registration',
    !badCount.ok && /count is how many/.test(badCount.error ?? '') && !bigCount.ok && !onAgent.ok && /agent/.test(onAgent.error ?? '')
    && !dupWatch.ok && /already keep/.test(dupWatch.error ?? '') && !noSuch.ok && /no event listener or listener watch/.test(noSuch.error ?? ''),
    { keep: keep.ok, badCount, bigCount, onAgent, dupWatch, noSuch })

  await settle('the last turns')
  p.file('user-dogs.json', userDogs())
  p.file('user-mail.json', userMail(''))
  p.keep(rig, { agents: ['sa', 'sb', 'boss'], grep: /listener|watch/i })
  return p.summary()
}
