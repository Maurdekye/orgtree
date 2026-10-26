// App content in a woken agent's turn input stays out of the engine log, and
// ordinary agent mail keeps its diagnostics (docket
// custom-panels-persistent-canvas-pinnable-html-pa, 2026-10-26). The app's
// mail, its docket item's assignment and its named event's delivery are written
// inside the app's private request; the recipient's actor reads them back from
// the database outside it. Disposable PG, fake CLIs and synthetic content only.
import assert from 'node:assert/strict'
import {Proof} from '../proof.mjs'

export function setup() {
  return {recover: true, fixture: {org: {name: 'App mail wake privacy proof'}, agents: [
    {name: 'boss', tier: 'sol', grant: 40, charter: 'Synthetic recipient.'},
    {name: 'writer', tier: 'sol', parent: 'boss', grant: 0, charter: 'Synthetic app author.'},
  ]}}
}

const APP = 'PRIVATE_APP_WAKE_BODY_88412'
const ORDINARY = 'ORDINARY_WAKE_CONTROL_88412'
const MIXED = 'ORDINARY_MIXED_CONTROL_88412'

export default async function (rig) {
  const p = new Proof('app-mail-wake-privacy'), root = '/api/orgs/' + rig.org
  const apps = v => rig.api('POST', root + '/apps', v), bridge = v => rig.api('POST', root + '/apps/bridge', v)
  const tool = async (who, name, args) => { const r = await rig.tool(who, name, args); assert(r.ok, r.text); return r.json }
  const boss = rig.agentRow('boss')
  // the woken actor's logged turn input: the calls of its turn start that carry the mail
  const wakeLines = from => rig.engineLog().slice(from).split(/\r?\n/).filter(l => l.includes(` agent:${boss.id}/boss `)
    && /Actor\.start_turn@EX[0-9a-f]+ runtime\.(actor\.Actor\.(session_notes|rels_of)|envelope\.ping_for|watchdogs\.events\.alert_turn)\(/.test(l))
  // the turn that took a mail, once it has ended
  const tookIt = (where, what) => rig.waitFor(() => {
    const m = rig.one(`SELECT turn_id FROM ot.mail WHERE recipient_agent_id = ${boss.id} AND state <> 'pending' AND turn_id IS NOT NULL AND ${where}`)
    const t = m && rig.turns('boss').find(x => x.id === m.turn_id)
    return t?.ended_at ? t : null
  }, {what, timeout: 90000})
  const prompts = () => rig.fakeLog('boss').filter(l => l.kind === 'turn').map(l => String(l.prompt ?? ''))

  // 1. ordinary agent mail alone wakes the recipient
  let mark = rig.engineLog().length
  await tool('writer', 'orgtree_message', {metadata: {to: 'boss'}, body: `Please review the draft. ${ORDINARY}`})
  await tookIt(`body LIKE '%${ORDINARY}%'`, 'the ordinary wake to end')
  const ordinaryWake = wakeLines(mark)
  p.file('ordinary-wake-lines.log', ordinaryWake.join('\n'))
  p.check('ordinary agent mail keeps its turn-input diagnostics', ordinaryWake.some(l => l.includes(ORDINARY)))

  // 2. an app the user opened, and the recipient listening for its named event
  const definition = {name: 'Wake notes', html: '<p>Synthetic wake app</p>', initial_state: {}, capabilities: [],
    events: [{name: 'submitted'}], width: 420, height: 360}
  const app = await tool('writer', 'orgtree_apps', {action: 'app_create', definition})
  let panel = await tool('writer', 'orgtree_apps', {action: 'panel_open', app: app.id, label: 'First'})
  panel = await apps({action: 'panel_open', panel: panel.id})
  const host = await bridge({action: 'session_open', panel: panel.id})
  const call = request => bridge({action: 'call', session: host.session, request})
  await tool('boss', 'orgtree_watchdog', {action: 'create', kind: 'app_listener', target: app.id, event_name: 'submitted',
    panel: panel.id, name: 'wake-listener', notice: true})

  // 3. one wake: an ordinary notice, then the app's mail, its event and its docket item (the waking mail)
  mark = rig.engineLog().length
  await tool('writer', 'orgtree_message', {metadata: {to: 'boss', notice: true}, body: `Draft notes attached. ${MIXED}`})
  const sent = await call({action: 'mail.send', to: 'boss', body: APP, notice: true})
  const fired = await call({action: 'events.fire', name: 'submitted', payload: {note: APP}})
  const delivery = await rig.waitFor(() => rig.sql(`SELECT uid FROM ot.mail WHERE recipient_agent_id = ${boss.id}
    AND extra->'app_event'->>'event' = '${fired.event}'`), {what: 'the app event delivery'})
  const work = await call({action: 'docket.create', title: 'Synthetic wake work', objective: APP, owner: 'boss'})
  const turn = await tookIt(`ev->>'variant' = 'docket.assigned'`, 'the app wake to end')
  const taken = rig.sql(`SELECT uid, sender, ev->'actor'->>'id' AS actor, extra ? 'app_event' AS event, body LIKE '%${MIXED}%' AS mixed
    FROM ot.mail WHERE recipient_agent_id = ${boss.id} AND turn_id = ${turn.id} ORDER BY id`)
  const appRows = taken.filter(r => r.sender.startsWith('app:') || r.actor?.startsWith('app:') || r.event)
  p.file('woken-batch.json', taken)
  p.check('the app actions ran and one woken turn took all three app mails with the ordinary notice',
    !!sent.sent && fired.accepted && fired.subscribers === 1 && delivery.length === 1 && !work.permission_required
      && appRows.length === 3 && taken.some(r => r.mixed))
  p.check('the woken agent still receives the app content', !!prompts().at(-1)?.includes(APP))
  const mixedWake = wakeLines(mark)
  p.file('mixed-wake-lines.log', mixedWake.join('\n'))
  p.check('ordinary mail in the same batch keeps its turn-input diagnostics', mixedWake.some(l => l.includes(MIXED)))
  p.check('the woken turn input names each app mail by its id',
    appRows.every(r => mixedWake.some(l => l.includes(`[private app mail ${r.uid} omitted]`))))
  p.check('the engine log never holds the app content', !rig.engineLog().includes(APP))

  // a limit, measured after the checks: the item's own objective, once read back, is ordinary docket
  // content. The desktop's read logs its RESPONSE line; the rig's test-only tool route logs no body at all.
  const slug = rig.one(`SELECT ev->'object'->>'slug' AS slug FROM ot.mail WHERE recipient_agent_id = ${boss.id}
    AND ev->>'variant' = 'docket.assigned'`)?.slug
  const read = await rig.api('GET', `${root}/work-items/${encodeURIComponent(slug)}`)
  p.note(`limit: after the desktop reads the app-created item (${read?.item?.slug === slug ? 'ok' : 'unexpected reply'}), the engine log `
    + (rig.engineLog().includes(APP) ? 'holds its objective as ordinary docket content' : 'still does not hold its objective'))
  return p.summary()
}
