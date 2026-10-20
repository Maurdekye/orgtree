// Proof: a project's event-listeners setting (docket
// project-event-listeners-an-enable-setting-off-by; user 2026-10-20 10:50Z,
// design approved by coordinator-opus 10:58Z), through the real engine.
//   OFF by default: the settings and the tree say so, and fire_event is
//   refused (the tool and the desk op), naming how to switch it on; a fire
//   never switches it on
//   a refused listener create (out of reach, a bad count) changes nothing;
//   the first listener an agent arms switches it ON and says so
//   members cannot configure it either way; agents never switch it off
//   (removing or pausing the last listener leaves it on)
//   a superior's OFF disables every armed listener and watch on the project
//   (paused, marked, with the reason; the tree's view carries `disabled`),
//   leaves an owner-paused dog unmarked and fair_queue dogs alone, and
//   tells each owner once, passively
//   ON (the user's desk op) re-arms exactly the marked dogs; a watch keeps
//   its edge (no re-fire); fire_event delivers again; owners are told
//   an agent's registration on an OFF project, and a resume, switch it on
//   and restore the others
//   a rehire while OFF brings the owner's listener back disabled; a runner
//   that finds its project off at engine start disables itself
//   migration 0043 switches on projects that had listeners, never
//   overwrites a written setting, and running it again changes nothing
// Run: node tools/rig/rig.mjs run tools/rig/proofs/project-listener-setting.mjs

import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { REPO } from '../lib.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('project-listener-setting')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const settle = what => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what, timeout: 60000 }).catch(() => {})
  await settle('seed turns to settle')
  const said = r => (r?.ok ? JSON.stringify(r.json ?? r.v ?? r.text) : String(r?.text ?? r?.error)).slice(0, 500)
  const opTry = body => rig.op(body).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const org = () => rig.one(`SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active'`).id
  const node = name => rig.one(`SELECT id, name, state, scope, extra FROM ot.agents
                                  WHERE org_id = ${org()} AND name = '${name}' AND state <> 'deleted'`)
  const dog = (who, name) => rig.one(`SELECT state, fired, memo FROM ot.watchdogs
                                        WHERE owner_agent_id = ${node(who).id} AND name = '${name}' ORDER BY id DESC LIMIT 1`)
  // a dog as the desktop sees it (the tree's exact read)
  const view = async (who, name) => (await rig.api('GET', `/api/orgs/${rig.org}/watchdogs?id=${encodeURIComponent(`${who}/${name}`)}`))?.watchdogs?.[0]
  const treeNode = async id => {
    const t = await rig.api('GET', `/api/orgs/${rig.org}`)
    const all = []
    const walk = n => { all.push(n); for (const c of n.children ?? []) walk(c) }
    for (const r of t.roots ?? []) walk(r)
    return all.find(n => n.id === id)
  }
  const settings = async name => (await opTry({ op: 'project_settings', node: name })).v?.settings
  const setting = async name => (await settings(name))?.event_listeners
  const configure = (who, name, on) => rig.tool(who, 'orgtree_project', { action: 'configure', name, settings: { event_listeners: on } })
  const listen = (who, name, target, extra = {}) =>
    rig.tool(who, 'orgtree_watchdog', { action: 'create', name, kind: 'project_listener', target, once: false, notice: true, ...extra })
  const fire = (who, name, body) => rig.tool(who, 'orgtree_project', { action: 'fire_event', name, ...(body ? { body } : {}) })
  const mails = (who, like) => rig.sql(`SELECT body, notice FROM ot.mail WHERE recipient_agent_id = ${node(who).id}
                                         AND body LIKE '%${like}%' ORDER BY id`)
  const marked = d => d?.state === 'paused' && d?.memo?.listeners_off === true
  const armed = d => d?.state === 'armed' && !d?.memo?.listeners_off && !d?.memo?.paused_why
  const fires = name => Number(rig.one(`SELECT count(*) AS n FROM ot.project_fires WHERE project_id = ${node(name).id}`)?.n ?? 0)

  // ------------------------------------------------------------ OFF by default
  const made = await opTry({ op: 'create_project', name: 'ls', parent: 'boss', description: 'Listener setting testbed.' })
  const hires = []
  for (const n of ['la', 'lb', 'lc']) hires.push(await opTry({ op: 'hire', name: n, parent: 'ls', tier: 'haiku', grant: 0, title: `Worker ${n}` }))
  await settle('hire turns')
  p.check('the project and its workers exist', made.ok && hires.every(h => h.ok), { made: said(made), hires: hires.map(said) })
  const fresh = await treeNode('ls')
  p.check('a new project\'s event listeners are OFF: its settings and its tree node say so',
    (await setting('ls')) === false && fresh?.configured_scope?.event_listeners !== true,
    { settings: await settings('ls'), scope: fresh?.configured_scope })
  const offFire = await fire('boss', 'ls', 'nobody hears this')
  const offOp = await opTry({ op: 'fire_project_event', node: 'ls', body: 'nor this' })
  p.check('fire_event on an OFF project is refused, naming how to switch the listeners on, from the tool and the desk',
    !offFire.ok && /event listeners are off/.test(offFire.text) && /settings|registering a listener/.test(offFire.text)
    && !offOp.ok && /event listeners are off/.test(offOp.error ?? '') && fires('ls') === 0,
    { tool: said(offFire), op: said(offOp), kept: fires('ls') })
  p.check('a refused fire does not switch them on', (await setting('ls')) === false, await settings('ls'))
  const outsider = await listen('carol', 'nosey', 'ls')
  const badCount = await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: 'none', kind: 'listener_watch', target: 'ls', count: 0 })
  p.check('a listener create that does not end armed (out of reach, a bad count) leaves them OFF',
    !outsider.ok && !badCount.ok && (await setting('ls')) === false, { outsider: said(outsider), badCount: said(badCount), settings: await settings('ls') })

  // ------------------------------------------------------------ an agent's registration switches it on
  const first = await listen('la', 'la-ear', 'ls')
  p.check('the first listener an agent arms switches them ON, and its create result says so',
    first.ok && /turned them on/.test(first.text) && (await setting('ls')) === true
    && (await treeNode('ls'))?.configured_scope?.event_listeners === true, { said: said(first), settings: await settings('ls') })
  const second = await listen('lb', 'lb-ear', 'ls')
  p.check('a listener on a project already ON says nothing about switching', second.ok && !/turned them on/.test(second.text), said(second))
  const pair = await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: 'ls-pair', kind: 'listener_watch', target: 'ls', count: 2, notice: true })
  await rig.waitFor(() => (dog('boss', 'ls-pair')?.fired ?? 0) === 1, { what: 'the satisfied watch fires', timeout: 20000 }).catch(() => {})
  p.check('a watch armed at its count fires once (the edge the restore must keep)', pair.ok && dog('boss', 'ls-pair')?.fired === 1, dog('boss', 'ls-pair'))
  const listed = await rig.tool('boss', 'orgtree_project', { action: 'listeners', name: 'ls' })
  p.check('action=listeners says the setting', listed.ok && listed.json?.event_listeners === true, said(listed))
  const memberOff = await configure('la', 'ls', false)
  const memberOn = await configure('la', 'ls', true)
  p.check('members cannot configure the setting either way', !memberOff.ok && !memberOn.ok && (await setting('ls')) === true,
    { off: said(memberOff), on: said(memberOn) })

  // ------------------------------------------------------------ a superior's OFF
  const third = await listen('lc', 'lc-ear', 'ls')
  const ownPause = await rig.tool('lc', 'orgtree_watchdog', { action: 'pause', id: 'lc-ear' })
  const queueDog = await rig.tool('la', 'orgtree_watchdog', { action: 'create', name: 'la-queue', kind: 'fair_queue', target: 'ls', notice: true })
  await settle('dogs armed')
  const off = await configure('boss', 'ls', false)
  await settle('after OFF')
  p.check('a superior switches them OFF in the project\'s settings', off.ok && (await setting('ls')) === false
    && (await treeNode('ls'))?.configured_scope?.event_listeners === false, { said: said(off), settings: await settings('ls') })
  p.check('OFF disables every armed listener and watch on the project: paused, marked, with the reason',
    [dog('la', 'la-ear'), dog('lb', 'lb-ear'), dog('boss', 'ls-pair')].every(d => marked(d)
      && /project ls's event listeners were turned off by boss/.test(d?.memo?.paused_why ?? '')),
    { la: dog('la', 'la-ear'), lb: dog('lb', 'lb-ear'), pair: dog('boss', 'ls-pair') })
  p.check('a dog its owner paused stays as it was (unmarked); the mail-queue dog keeps working',
    ownPause.ok && third.ok && dog('lc', 'lc-ear')?.state === 'paused' && !dog('lc', 'lc-ear')?.memo?.listeners_off
    && queueDog.ok && dog('la', 'la-queue')?.state === 'armed', { lc: dog('lc', 'lc-ear'), queue: dog('la', 'la-queue') })
  const vla = await view('la', 'la-ear'), vlc = await view('lc', 'lc-ear')
  p.check('the desktop\'s view of a disabled dog carries the reason; an owner-paused one has none',
    /turned off by boss/.test(vla?.disabled ?? '') && vla?.state === 'paused' && vlc?.state === 'paused' && vlc?.disabled == null,
    { la: vla && { state: vla.state, disabled: vla.disabled }, lc: vlc && { state: vlc.state, disabled: vlc.disabled } })
  await rig.waitFor(() => mails('la', 'event listeners were turned OFF').length > 0 && mails('boss', 'event listeners were turned OFF').length > 0,
    { what: 'the OFF notices', timeout: 20000 }).catch(() => {})
  const offLa = mails('la', 'event listeners were turned OFF'), offBoss = mails('boss', 'event listeners were turned OFF')
  p.check('each owner of a disabled dog is told once, passively, naming its dogs; an owner with none is not',
    offLa.length === 1 && offLa[0].notice === true && /la-ear/.test(offLa[0].body) && !/la-queue/.test(offLa[0].body)
    && offBoss.length === 1 && /ls-pair/.test(offBoss[0].body) && mails('lc', 'event listeners were turned OFF').length === 0,
    { la: offLa, boss: offBoss.map(m => m.body.slice(0, 300)), lc: mails('lc', 'event listeners were turned OFF').length })
  const offAgain = await fire('boss', 'ls', 'still nobody')
  p.check('fire_event is refused again while OFF', !offAgain.ok && /event listeners are off/.test(offAgain.text), said(offAgain))

  // ------------------------------------------------------------ the user's ON restores
  const on = await opTry({ op: 'set_event_listeners', node: 'ls', enabled: true })
  await settle('after ON')
  await rig.waitFor(() => armed(dog('la', 'la-ear')), { what: 'the restore', timeout: 20000 }).catch(() => {})
  p.check('the user switches them ON from the desk; exactly the marked dogs re-arm',
    on.ok && (await setting('ls')) === true && armed(dog('la', 'la-ear')) && armed(dog('lb', 'lb-ear')) && armed(dog('boss', 'ls-pair'))
    && dog('lc', 'lc-ear')?.state === 'paused', { said: said(on), la: dog('la', 'la-ear'), lb: dog('lb', 'lb-ear'),
      pair: dog('boss', 'ls-pair'), lc: dog('lc', 'lc-ear') })
  await new Promise(r => setTimeout(r, 1500))
  p.check('a restored watch keeps its edge: it does not fire again', dog('boss', 'ls-pair')?.fired === 1, dog('boss', 'ls-pair'))
  await rig.waitFor(() => mails('la', 're-armed').length > 0, { what: 'the ON notice', timeout: 20000 }).catch(() => {})
  const onLa = mails('la', 're-armed')
  p.check('owners are told their dogs are back, passively', onLa.length === 1 && onLa[0].notice === true && /la-ear/.test(onLa[0].body), onLa)
  const back = await fire('boss', 'ls', 'welcome back')
  p.check('fire_event delivers again', back.ok && back.json?.delivered === 2
    && [...(back.json?.delivered_to ?? [])].sort().join() === 'la,lb', said(back))

  // ------------------------------------------------------------ agents never switch it off
  await rig.tool('la', 'orgtree_watchdog', { action: 'remove', id: 'la-ear' })
  await rig.tool('lb', 'orgtree_watchdog', { action: 'pause', id: 'lb-ear' })
  await settle('listeners gone')
  p.check('removing or pausing the last listener leaves them ON', (await setting('ls')) === true, await settings('ls'))

  // ------------------------------------------------------------ a registration on OFF restores the others
  await configure('boss', 'ls', false)
  await settle('OFF again')
  p.check('OFF marks the armed watch; owner-paused listeners stay unmarked',
    marked(dog('boss', 'ls-pair')) && !dog('lb', 'lb-ear')?.memo?.listeners_off, { pair: dog('boss', 'ls-pair'), lb: dog('lb', 'lb-ear') })
  const reg = await listen('la', 'la-ear2', 'ls')
  await settle('registration on OFF')
  await rig.waitFor(() => armed(dog('boss', 'ls-pair')), { what: 'the others restored', timeout: 20000 }).catch(() => {})
  p.check('an agent registering a listener on an OFF project switches it ON and restores the disabled dogs',
    reg.ok && /turned them on/.test(reg.text) && (await setting('ls')) === true && armed(dog('boss', 'ls-pair'))
    && dog('lb', 'lb-ear')?.state === 'paused', { said: said(reg), pair: dog('boss', 'ls-pair'), lb: dog('lb', 'lb-ear') })
  await configure('boss', 'ls', false)
  await settle('OFF a third time')
  const resumed = await rig.tool('lb', 'orgtree_watchdog', { action: 'resume', id: 'lb-ear' })
  await settle('resume on OFF')
  await rig.waitFor(() => armed(dog('la', 'la-ear2')), { what: 'the resume restores', timeout: 20000 }).catch(() => {})
  p.check('a resume on an OFF project switches it ON too, and restores the others',
    resumed.ok && /turned them on/.test(resumed.text) && (await setting('ls')) === true && armed(dog('lb', 'lb-ear'))
    && armed(dog('la', 'la-ear2')) && armed(dog('boss', 'ls-pair')), { said: said(resumed), la: dog('la', 'la-ear2'), pair: dog('boss', 'ls-pair') })

  // ------------------------------------------------------------ a rehire while OFF
  const ld = await opTry({ op: 'hire', name: 'ld', parent: 'ls', tier: 'haiku', grant: 0, title: 'Worker ld' })
  await settle('ld hired')
  const ldEar = await listen('ld', 'ld-ear', 'ls')
  const retired = await opTry({ op: 'retire', node: 'ld' })
  await settle('ld retired')
  await configure('boss', 'ls', false)
  await settle('OFF for the rehire')
  const archivedDog = dog('ld', 'ld-ear')
  const rehired = await opTry({ op: 'rehire', node: 'ld' })
  await settle('ld rehired')
  p.check('a rehire while OFF brings the owner\'s listener back disabled, not armed',
    ld.ok && ldEar.ok && retired.ok && archivedDog?.state === 'paused' && !archivedDog?.memo?.listeners_off
    && rehired.ok && marked(dog('ld', 'ld-ear')) && (await setting('ls')) === false,
    { ld: said(ld), ear: said(ldEar), retired: said(retired), archived: archivedDog, rehired: said(rehired), now: dog('ld', 'ld-ear') })
  await configure('boss', 'ls', true)
  await settle('ON after the rehire')
  await rig.waitFor(() => armed(dog('ld', 'ld-ear')), { what: 'ld restored', timeout: 20000 }).catch(() => {})
  p.check('the next ON restores it with the others', armed(dog('ld', 'ld-ear')) && armed(dog('la', 'la-ear2')), { ld: dog('ld', 'ld-ear') })

  // ------------------------------------------------------------ the runner's guard at engine start
  rig.exec(`UPDATE ot.agents SET scope = jsonb_set(coalesce(scope, '{}'::jsonb), '{event_listeners}', 'false') WHERE id = ${node('ls').id}`)
  await rig.restart()
  await settle('after restart')
  await rig.waitFor(() => marked(dog('la', 'la-ear2')), { what: 'the start guard', timeout: 30000 }).catch(() => {})
  p.check('a listener armed on a project found OFF at engine start disables itself',
    marked(dog('la', 'la-ear2')) && marked(dog('ld', 'ld-ear')) && marked(dog('boss', 'ls-pair')),
    { la: dog('la', 'la-ear2'), ld: dog('ld', 'ld-ear'), pair: dog('boss', 'ls-pair') })

  // ------------------------------------------------------------ migration 0043
  const projects = []
  for (const n of ['mx', 'my', 'mz', 'mw']) projects.push(await opTry({ op: 'create_project', name: n, parent: 'boss', description: `Migration case ${n}.` }))
  const myDog = await listen('boss', 'my-ear', 'my')
  // as before 0043: no setting written; mx and mw had a listener once, my keeps one, mz never had any
  rig.exec(`UPDATE ot.agents SET scope = scope - 'event_listeners', extra = extra - 'listeners_seen_at'
             WHERE org_id = ${org()} AND name IN ('mx', 'my', 'mz', 'mw');
            UPDATE ot.agents SET extra = extra || '{"listeners_seen_at": "2026-10-20T06:00:00Z"}'::jsonb
             WHERE org_id = ${org()} AND name IN ('mx', 'mw');
            UPDATE ot.agents SET scope = jsonb_set(coalesce(scope, '{}'::jsonb), '{event_listeners}', 'false')
             WHERE org_id = ${org()} AND name = 'mw';`)
  const sqlFile = path.join(REPO, 'engine', 'rs', 'orgtree-engine', 'migrations', '0043_event_listeners_setting.sql')
  const state = () => Object.fromEntries(['mx', 'my', 'mz', 'mw'].map(n => [n, node(n).scope?.event_listeners ?? null]))
  let ran = null, once = null, twice = null
  try {
    const sql = fs.readFileSync(sqlFile, 'utf8')
    rig.exec(sql); once = state()
    rig.exec(sql); twice = state()
    ran = 'ok'
  } catch (e) { ran = e.message.slice(0, 300) }
  p.check('0043 switches ON projects that have or had a listener, leaves the others and a written setting alone, and a rerun changes nothing',
    projects.every(r => r.ok) && myDog.ok && ran === 'ok'
    && JSON.stringify(once) === JSON.stringify({ mx: true, my: true, mz: null, mw: false })
    && JSON.stringify(twice) === JSON.stringify(once), { ran, once, twice, myDog: said(myDog) })

  p.keep(rig, { agents: ['boss', 'la', 'lb', 'lc', 'ld'], grep: /listener|watchdog|project_event|event_listeners/ })
  return p.summary()
}
