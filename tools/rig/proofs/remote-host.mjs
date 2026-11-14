// tools/rig/proofs/remote-host.mjs: a desktop lets other computers open its
// organizations (docs/rust-engine/remote-org.md, "A desktop as host"; test
// F-T10 of the amendment).
//
// Two real engines, each with its own database. The far one is somebody's own
// desktop engine ("PC-HOST"): its user turns remote access on for an
// organization and adds a computer with a one-time code. This run's own
// engine is that other computer ("PC-SAM"): it adds the hosting desktop with
// the code, opens the organization through its relay and works in it. A third
// computer ("PC-DANA") is played by the proof itself, straight at the door.
//
//   node tools/rig/rig.mjs run tools/rig/proofs/remote-host.mjs
//   node tools/rig/rig.mjs run tools/rig/proofs/remote-host.mjs --ui <renderer bundle>   (Session 0 only)
//
// Without a renderer bundle no window is opened, and it runs in any session.
// With one, two windows follow the engines' part, one after the other
// (tools/rig/desktop/remote-host.cjs): a window of the HOSTING desktop on its
// organization (the Remote access group, Add a computer, the chip, the App
// settings page), then a window of THIS desktop (the Add dialog taking one
// pasted line, Connection details, the hosting computer's settings, the
// banner of an organization that is no longer shared). 15 captures; the page
// script lists them.
//
// Nothing here touches this computer's Windows Firewall, asks for an
// administrator, or listens beyond loopback. The door stands on 127.0.0.1
// (ORGTREE_RIG_REMOTE_DOOR, which only a rig run of a debug build reads);
// what the hosting engine "reads from Windows Firewall" is a file this run
// writes (rig-home\rig-firewall\remote-access.txt); and the administrator
// prompt is the page script's planted bridge, which records what it was asked.
//
// At the base (before phase F) a desktop's engine has no door: every check
// from the first one fails.

import fs from 'node:fs'
import path from 'node:path'

import { runDesktop } from '../desktop.mjs'
import { farEngine } from '../far.mjs'
import { RIG_DIR, freePort, touch } from '../lib.mjs'
import { Proof } from '../proof.mjs'
import { control, sessionId } from '../steps.mjs'

/** what the planted desktop bridge reports as the app version (the status strip shows it) */
const VERSION = `${JSON.parse(fs.readFileSync(path.join(RIG_DIR, '..', '..', 'package.json'), 'utf8')).version}-rig`

const HOST = 'PC-HOST'
const ME = 'PC-SAM'
const DANA = 'PC-DANA'
/** what a desktop calls its own client on another engine */
const client = computer => `Orgtree desktop (${computer})`
const SCENARIO = { agents: {}, default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } }
/** an e-mail address anywhere in a text */
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/
/** a one-time code: 26 characters of Crockford's base 32 */
const CODE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** This computer has a name of its own in the story: an engine takes its computer's name from the
 *  environment, and the run's own engine is started after this. */
export function setup() { process.env.COMPUTERNAME = ME; return { fixture: 'basic' } }

/** One agent of a tree read. */
const nodeOf = (tree, id) => { const walk = nodes => { for (const n of nodes ?? []) { if (n.id === id) return n; const below = walk(n.children); if (below) return below } return null }; return walk(tree?.roots) }

export default async function (rig) {
  const proof = new Proof('remote-host')
  const ui = !!rig.run.ui
  const session = sessionId()
  if (ui && session !== 0) {
    proof.check('the desktop part runs in Windows Session 0 only', false, { session, hint: 'orgtree_session use=0, or run without a renderer bundle for the engine part' })
    return proof.summary()
  }
  let ctl = null
  const far = farEngine(rig, { scenario: SCENARIO, role: 'the hosting desktop of proofs/remote-host.mjs', desktop: { computer: HOST } })
  /** The hosting desktop's own app: its desktop token on its own listener. Never throws on a refusal. */
  const host = (method, route, body) => far.call(method, route, { body })
  /** This computer's engine: `remote` is the window header of the connection. Never throws on a refusal. */
  const near = async (method, route, { body, remote } = {}) => {
    touch(rig.dir)
    const res = await fetch(rig.url + route, { method, headers: { 'X-Orgtree-Desktop-Token': rig.token, 'Content-Type': 'application/json', ...(remote ? { 'X-Orgtree-Remote': remote } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json, text }
  }
  const view = async () => ((await near('GET', '/api/remotes')).json?.remotes ?? [])[0] ?? null
  const until = (what, fn, timeout = 30000) => rig.waitFor(fn, { timeout, every: 250, what }).catch(() => null)
  const farTurns = () => far.fakeLog('lead').filter(l => l.kind === 'turn').length
  /** What the hosting engine reads in place of Windows Firewall: the rules as the read would print them,
   *  for the engine's own program (the run's copy), or no rule at all. */
  const rulesFile = path.join(far.data, 'rig-home', 'rig-firewall', 'remote-access.txt')
  const program = Buffer.from(path.join(rig.dir, 'bin', 'orgtree-engine.exe'), 'utf8').toString('base64')
  const windowsHas = (port, lan = false) => {
    fs.mkdirSync(path.dirname(rulesFile), { recursive: true })
    const rule = kind => `rule\t${kind}\tTrue\tInbound\tAllow\t${port}\t${program}`
    fs.writeFileSync(rulesFile, [...(port ? [rule('tailscale'), ...(lan ? [rule('lan')] : [])] : []), 'read', ''].join('\r\n'))
  }
  const lab = 'far-lab'
  const annex = 'far-annex'
  let id = null
  let port = 0
  try {
    // ------------------------------------------------------------ the hosting desktop
    await far.start()
    const slugs = []
    for (const name of ['Far Lab', 'Far Annex']) slugs.push((await far.api('POST', '/api/orgs', { name, dirs: [], net_autoconnect: false })).slug)
    await far.api('POST', `/api/orgs/${lab}/ops`, { op: 'hire', name: 'lead', tier: 'opus', grant: 24, title: 'Far lead', charter: 'You lead the far org. You exist only in test runs.' })
    const itself = await host('GET', '/api/host')
    const before = await host('GET', '/api/remote-access')
    proof.check('a desktop\'s own engine offers remote access, and nothing is shared at first', itself.json?.mode === 'desktop' && before.status === 200 && before.json?.computer === HOST
      && before.json?.door?.state === 'closed' && before.json?.orgs?.length === 2 && before.json.orgs.every(o => o.on === false) && JSON.stringify(slugs) === JSON.stringify([lab, annex]),
      { mode: itself.json?.mode, status: before.status, computer: before.json?.computer, door: before.json?.door, slugs })
    port = await freePort()
    const moved = await host('PUT', '/api/remote-access', { port })
    windowsHas(0)
    const asked = await host('GET', `/api/remote-access/orgs/${lab}?fresh=1`)
    proof.check('asked first, the engine says the switch could go on, and that Windows Firewall does not let the door in yet', moved.status === 200 && moved.json?.port === port && asked.status === 200
      && asked.json?.refusal === null && asked.json?.on === false && asked.json?.door?.firewall?.state === 'missing' && asked.json.door.firewall.present === false,
      { moved: moved.status, port: moved.json?.port, asked: asked.status, refusal: asked.json?.refusal, firewall: asked.json?.door?.firewall })
    // the administrator said yes (in the app the desktop's bridge adds the two rules; here the file says they are there)
    windowsHas(port)
    const on = await host('PUT', `/api/remote-access/orgs/${lab}`, { on: true })
    const door = `http://127.0.0.1:${port}`
    proof.check('the switch goes on: the door stands on loopback at the chosen port, and the rules let it in', on.status === 200 && on.json?.on === true && on.json?.door?.state === 'open'
      && on.json.door.addresses?.[0]?.url === door && on.json.door.addresses.length === 1 && on.json.door.firewall?.state === 'ok' && on.json.door.firewall.present === true,
      { status: on.status, detail: on.json?.detail, door: on.json?.door })
    const nobody = await far.door(port, 'GET', '/api/host')
    const itsOwn = await far.door(port, 'GET', `/api/orgs/${lab}`, { token: far.token })
    proof.check('the door opens for no request without a token, and the desktop\'s own token is nothing there', nobody.status === 403 && nobody.json?.detail === 'remote access token required'
      && itsOwn.status === 403, { nobody: [nobody.status, nobody.json?.detail], itsOwn: [itsOwn.status, itsOwn.json?.detail] })
    const invited = await host('POST', `/api/remote-access/orgs/${lab}/invitations`)
    const code = invited.json?.code ?? ''
    const hello = await far.door(port, 'GET', '/api/host', { token: code })
    const codeReads = await far.door(port, 'GET', `/api/orgs/${lab}`, { token: code })
    proof.check('a one-time code is made, valid for 15 minutes: it says whose door this is, and reads no organization', invited.status === 200 && CODE.test(code) && invited.json?.minutes === 15
      && hello.status === 200 && hello.json?.mode === 'host' && hello.json?.computer === HOST && codeReads.status === 403 && codeReads.json?.code === 'E17',
      { status: invited.status, detail: invited.json?.detail, length: code.length, minutes: invited.json?.minutes, hello: [hello.status, hello.json?.mode, hello.json?.computer], reads: [codeReads.status, codeReads.json?.code] })

    // ------------------------------------------------------------ the other computer adds it
    const added = await near('POST', '/api/remotes', { body: { url: door, token: code } })
    const first = await until('the connection to the hosting desktop', async () => { const v = await view(); return v?.state === 'connected' ? v : null }, 60000)
    id = first?.id ?? (await view())?.id ?? null
    proof.check('this desktop adds the hosting desktop with the code: it is called by that computer\'s name, and this desktop is a member there with a token of its own',
      added.status === 200 && first?.mode === 'host' && first?.scope === 'member' && first?.name === HOST && first?.own_token === true && first?.client_name === client(ME),
      first ? { mode: first.mode, scope: first.scope, name: first.name, own_token: first.own_token, client: first.client_name } : { status: added.status, detail: added.json?.detail, view: await view() })
    proof.check('its list holds the organization it was given and no other', JSON.stringify((first?.orgs ?? []).map(o => [o.remote_slug, o.gone])) === JSON.stringify([[lab, false]]), first?.orgs)
    /** this desktop's name for an organization of the hosting desktop */
    const alias = async slug => (await view())?.orgs?.find(o => o.remote_slug === slug)?.alias ?? slug
    const spent = await far.door(port, 'POST', '/api/standalone/clients', { token: code, body: { name: client('PC-THIRD') } })
    const kept = fs.readFileSync(path.join(rig.data, 'remote-engines.json'), 'utf8')
    proof.check('the code is spent, and this desktop did not keep it: a second computer gets nothing with it', spent.status === 403 && !kept.includes(code) && /"mode":\s*"host"/.test(kept),
      { status: spent.status, detail: spent.json?.detail, keptTheCode: kept.includes(code) })

    // ------------------------------------------------------------ what the owner sees
    const seen = await until('the owner to see the computer connected', async () => { const v = (await host('GET', `/api/remote-access/orgs/${lab}`)).json; return v?.computers?.[0]?.connected ? v : null })
    const pc = seen?.computers?.[0]
    proof.check('the owner sees the computer in the organization\'s list, by its name, connected', seen?.computers?.length === 1 && pc?.label === ME && pc?.name === client(ME) && pc?.connected === true
      && JSON.stringify(pc?.orgs) === JSON.stringify([lab]) && seen.invitations?.length === 0, pc ?? { computers: (await host('GET', `/api/remote-access/orgs/${lab}`)).json?.computers })
    const shared = (await host('GET', '/api/remote-access')).json?.orgs?.find(o => o.slug === lab)
    proof.check('the value the owner\'s windows are pushed counts it (the chip "1 computer connected")', shared?.on === true && shared?.computers === 1 && shared?.connected === 1
      && shared?.connected_now?.[0]?.label === ME, shared)

    // ------------------------------------------------------------ what a computer that was let in can do
    const asMe = (method, route, body) => near(method, route, { body, remote: id })
    const tree = await asMe('GET', `/api/orgs/${await alias(lab)}`)
    proof.check('the organization opens through this desktop\'s relay', tree.status === 200 && !!nodeOf(tree.json, 'lead'), { status: tree.status, detail: tree.json?.detail })
    const refusedWrite = await asMe('POST', '/api/defaults', { default_effort: 'high' })
    proof.check('a change to the hosting computer\'s own settings is refused there, and the answer reaches the window as it is', refusedWrite.status === 403 && refusedWrite.json?.code === 'E17'
      && refusedWrite.json?.detail === `This belongs to ${HOST}.`, { status: refusedWrite.status, body: refusedWrite.json })
    const accounts = await asMe('GET', '/api/accounts')
    const owners = await host('GET', '/api/accounts')
    proof.check('the hosting computer\'s accounts can be read, and no e-mail address comes with them', accounts.status === 200 && !ADDRESS.test(accounts.text),
      { status: accounts.status, theOwnersOwnListHasAnAddress: ADDRESS.test(owners.text), found: ADDRESS.exec(accounts.text)?.[0] ?? null })
    const at = farTurns()
    const sent = await asMe('POST', `/api/orgs/${await alias(lab)}/nodes/lead/message`, { text: 'a message from the other computer' })
    // In Session 0 with a user signed in, an engine holds its first turns for the sign-in helper until 60 s after its start.
    const taken = await until('the hosting desktop\'s agent to take the message', () => farTurns() > at, 150000)
    const box = (await host('GET', `/api/orgs/${lab}/nodes/lead/inbox`)).json ?? {}
    const row = ['pending', 'delivered', 'sent'].flatMap(k => box[k] ?? []).find(m => m.body === 'a message from the other computer')
    proof.check('a message from the other computer runs the agent on the hosting desktop, and the owner reads whose it was', sent.status === 200 && !!taken && row?.from === '@user'
      && row?.via?.name === ME && row?.via?.on === client(ME), row ? { from: row.from, via: row.via, taken: !!taken } : { status: sent.status, detail: sent.json?.detail })
    proof.check('the agent still reads "user": the name is for people', far.fakeLog('lead').some(l => JSON.stringify(l).includes('a message from the other computer'))
      && !far.fakeLog('lead').some(l => JSON.stringify(l).includes(ME)), { lines: far.fakeLog('lead').length })
    /** what the organization's history says of remote access, oldest first */
    const records = async slug => ((await host('GET', `/api/orgs/${slug}/events?last=200`)).json?.events ?? []).filter(e => e.op === 'remote_access')
    const written = await until('the records of remote access', async () => { const w = (await records(lab)).map(e => e.detail?.what); return ['on', 'code', 'computer_added', 'connected'].every(x => w.includes(x)) ? w : null }, 20000)
    const addition = (await records(lab)).find(e => e.detail?.what === 'computer_added')
    const switching = (await records(lab)).find(e => e.detail?.what === 'on')
    proof.check('the organization\'s history says what happened and who did it: switched on by its owner, a code, the computer added by itself, connected', !!written
      && addition?.actor === '@user' && addition?.detail?.computer?.label === ME && addition?.via?.name === ME && switching?.via?.id === 'local',
      { whats: (await records(lab)).map(e => e.detail?.what), addition: addition ? { detail: addition.detail, via: addition.via } : null, switching: switching?.via ?? null })

    // ------------------------------------------------------------ a second computer, straight at the door
    const second = await host('POST', `/api/remote-access/orgs/${lab}/invitations`)
    const dana = await far.door(port, 'POST', '/api/standalone/clients', { token: second.json?.code, body: { name: client(DANA) } })
    const asDana = (method, route, body) => far.door(port, method, route, { token: dana.json?.token, body })
    const hers = await asDana('GET', `/api/orgs/${lab}`)
    const answers = {
      'another organization': await asDana('GET', `/api/orgs/${annex}`),
      'the list of every organization': await asDana('GET', '/api/orgs'),
      'the owner\'s routes': await asDana('GET', '/api/remote-access'),
      'adding a computer': await asDana('POST', `/api/remote-access/orgs/${lab}/invitations`),
      'the deletion': await asDana('DELETE', `/api/orgs/${lab}`),
      'the usage': await asDana('GET', '/api/usage'),
    }
    proof.check('a member\'s token opens its organization at the door and is refused everything that is not its own, each with the hosting desktop\'s sentence', dana.status === 200 && !!dana.json?.token
      && hers.status === 200 && Object.values(answers).every(a => a.status === 403 && a.json?.code === 'E17' && a.json?.detail === `This belongs to ${HOST}.`),
      { made: dana.status, hers: hers.status, refused: Object.fromEntries(Object.entries(answers).map(([what, a]) => [what, [a.status, a.json?.code ?? a.json?.detail ?? null]])) })
    const inside = await far.call('GET', `/api/orgs/${lab}`, { token: dana.json?.token })
    const stillThere = (await host('GET', `/api/orgs/${lab}`)).status
    proof.check('and it is no token on the hosting desktop\'s own listener; nothing was deleted', [401, 403].includes(inside.status) && stillThere === 200, { inside: inside.status, stillThere })

    const third = await host('POST', `/api/remote-access/orgs/${lab}/invitations`)
    const tookBack = await host('DELETE', `/api/remote-access/orgs/${lab}/invitations/${third.json?.id}`)
    const late = await far.door(port, 'GET', '/api/host', { token: third.json?.code })
    proof.check('a code the owner took back opens nothing', third.status === 200 && tookBack.status === 200 && tookBack.json?.invitations?.length === 0 && late.status === 403
      && late.json?.detail === 'remote access token required', { made: third.status, tookBack: tookBack.status, open: tookBack.json?.invitations?.length, late: [late.status, late.json?.detail] })

    // ------------------------------------------------------------ a second organization, given without a code
    const annexOn = await host('PUT', `/api/remote-access/orgs/${annex}`, { on: true })
    const known = (await host('GET', `/api/remote-access/orgs/${annex}`)).json?.known ?? []
    const mine = known.find(c => c.label === ME)
    const given = await host('PUT', `/api/remote-access/orgs/${annex}/computers/${mine?.id}`)
    const both = await until('the given organization to arrive on the open connection', async () => { const v = await view(); return v?.orgs?.filter(o => !o.gone).length === 2 ? v : null })
    const annexTree = await asMe('GET', `/api/orgs/${await alias(annex)}`)
    proof.check('a second organization is given to a computer that is already known, with no code: it arrives on the open connection and opens', annexOn.status === 200 && known.length === 2 && !!mine
      && given.status === 200 && given.json?.computers?.some(c => c.id === mine.id) && !!both && annexTree.status === 200,
      { on: annexOn.status, known: known.map(c => c.label), given: given.status, detail: given.json?.detail, orgs: (await view())?.orgs?.map(o => [o.remote_slug, o.gone]), opens: annexTree.status })
    const danaAnnex = await asDana('GET', `/api/orgs/${annex}`)
    proof.check('the other computer was given nothing by that', danaAnnex.status === 403 && danaAnnex.json?.code === 'E17', { status: danaAnnex.status, code: danaAnnex.json?.code })

    // ------------------------------------------------------------ switched off, and on again
    const off = await host('PUT', `/api/remote-access/orgs/${lab}`, { on: false })
    const closed = await until('the switched-off organization to be refused', async () => { const r = await asMe('GET', `/api/orgs/${await alias(lab)}`); return r.status === 403 && r.json?.code === 'E16' ? r : null }, 60000)
    const marked = await until('this desktop\'s list to mark it', async () => { const v = await view(); return v?.state === 'connected' && v.orgs.find(o => o.remote_slug === lab)?.gone === true ? v : null }, 60000)
    const other = await asMe('GET', `/api/orgs/${await alias(annex)}`)
    proof.check('switched off: the organization is refused with the hosting desktop\'s own sentence, and the other organization stays open', off.status === 200 && off.json?.on === false
      && closed?.json?.detail === `${HOST} no longer shares this organization.` && other.status === 200, { off: off.status, closed: closed?.json ?? null, other: other.status })
    proof.check('this desktop\'s list marks it while the connection stays up (the window\'s banner is made of exactly that)', !!marked, { state: (await view())?.state, orgs: (await view())?.orgs?.map(o => [o.remote_slug, o.gone]) })
    const again = await host('PUT', `/api/remote-access/orgs/${lab}`, { on: true })
    const back = await until('the organization to open again', async () => (await asMe('GET', `/api/orgs/${await alias(lab)}`)).status === 200, 60000)
    proof.check('switched on again, the same computer is back in with no new code', again.status === 200 && !!back && again.json?.computers?.length === 2,
      { status: again.status, back: !!back, computers: again.json?.computers?.map(c => c.label) })

    // ------------------------------------------------------------ the other computer's user disconnects, and connects again
    const mineThere = async () => (await host('GET', `/api/remote-access/orgs/${lab}`)).json?.computers?.find(c => c.label === ME) ?? null
    const paused = await near('PATCH', `/api/remotes/${id}`, { body: { enabled: false } })
    const wentAway = await until('the owner to see it leave', async () => (await mineThere())?.connected === false)
    const lastSeen = (await mineThere())?.last_seen_at ?? null
    // who is connected is looked at every five seconds: it stays away until the history has it (a shorter absence leaves no record)
    const ofMine = async what => (await records(lab)).filter(e => e.detail?.what === what && e.detail?.computer?.label === ME).length
    const cameBefore = await ofMine('connected')
    const leaving = await until('the record of its leaving', async () => await ofMine('disconnected') > 0, 30000)
    const resumed = await near('PATCH', `/api/remotes/${id}`, { body: { enabled: true } })
    const returned = await until('the owner to see it back', async () => (await mineThere())?.connected === true, 60000)
    const coming = await until('the record of its coming back', async () => await ofMine('connected') > cameBefore, 30000)
    proof.check('its user disconnects and connects again: the owner sees it leave, with when it was last seen, and come back, and the history has both', paused.status === 200 && !!wentAway && !!lastSeen
      && !!leaving && resumed.status === 200 && !!returned && !!coming, { paused: paused.status, left: !!wentAway, lastSeen, recordedLeaving: !!leaving, resumed: resumed.status, returned: !!returned, recordedComing: !!coming })

    // ------------------------------------------------------------ the hosting desktop is restarted
    await far.stop()
    const away = await until('this desktop to notice', async () => (await view())?.state !== 'connected', 60000)
    await far.start()
    const after = (await host('GET', '/api/remote-access')).json
    proof.check('after a restart of the hosting desktop the switches, the port and the computers are as they were, and the door is open again', after?.port === port && after?.door?.state === 'open'
      && after.door.addresses?.[0]?.url === door && after.orgs?.filter(o => o.on).length === 2 && after.orgs.find(o => o.slug === lab)?.computers === 2,
      { port: after?.port, door: after?.door, orgs: after?.orgs?.map(o => [o.slug, o.on, o.computers]) })
    await near('POST', `/api/remotes/${id}/retry`)
    const rejoined = await until('this desktop to connect again by itself', async () => { const v = await view(); return v?.state === 'connected' ? v : null }, 120000)
    const reopened = rejoined ? await asMe('GET', `/api/orgs/${await alias(lab)}`) : { status: 0 }
    proof.check('this desktop noticed, and comes back with the token it has: no code is needed again', !!away && !!rejoined && reopened.status === 200, { away: !!away, state: (await view())?.state, error: (await view())?.last_error, opens: reopened.status })

    // ------------------------------------------------------------ revoked
    const revoked = await host('DELETE', `/api/remote-access/computers/${mine?.id}`)
    const out = await until('this desktop to be refused', async () => { const v = await view(); return v && v.state !== 'connected' ? v : null }, 60000)
    const afterRevoke = await asMe('GET', `/api/orgs/${await alias(lab)}`)
    const left = (await host('GET', `/api/remote-access/orgs/${lab}`)).json
    proof.check('a revoked computer is out of every organization at once; the other computer stays', revoked.status === 200 && revoked.json?.revoked === mine?.id && !!out && afterRevoke.status !== 200
      && JSON.stringify(left?.computers?.map(c => c.label)) === JSON.stringify([DANA]) && (await asDana('GET', `/api/orgs/${lab}`)).status === 200,
      { status: revoked.status, state: out?.state, refusal: out?.refusal ?? out?.last_error ?? null, relayed: afterRevoke.status, left: left?.computers?.map(c => c.label) })
    const revocations = await until('the records of the revocation', async () => { const r = [(await records(lab)), (await records(annex))].map(list => list.some(e => e.detail?.what === 'computer_revoked' && e.detail?.computer?.label === ME)); return r.every(Boolean) ? r : null }, 20000)
    proof.check('both organizations\' histories say the computer was revoked', !!revocations, { lab: (await records(lab)).map(e => e.detail?.what), annex: (await records(annex)).map(e => e.detail?.what) })

    // ------------------------------------------------------------ everything off
    const stopped = await host('POST', '/api/remote-access/stop')
    const ended = (await host('GET', '/api/remote-access')).json
    const shut = await far.door(port, 'GET', `/api/orgs/${lab}`, { token: dana.json?.token }).then(r => r.status, () => 'no listener')
    proof.check('"Stop all remote access" turns every switch off and takes the door away; the lists of computers stay', stopped.status === 200 && ended?.door?.state === 'closed'
      && ended.orgs?.every(o => o.on === false) && ended.orgs.find(o => o.slug === lab)?.computers === 1 && shut === 'no listener',
      { status: stopped.status, door: ended?.door?.state, orgs: ended?.orgs?.map(o => [o.slug, o.on, o.computers]), atTheDoor: shut })
    // every kind of record the engine writes, read back from the two organizations' histories
    const kinds = async slug => new Set((await records(slug)).map(e => e.detail?.what))
    const wanted = { [lab]: ['on', 'off', 'code', 'code_withdrawn', 'computer_added', 'connected', 'disconnected', 'computer_revoked'], [annex]: ['on', 'off', 'computer_given', 'computer_revoked'] }
    const complete = await until('every kind of record', async () => { for (const [slug, list] of Object.entries(wanted)) { const have = await kinds(slug); if (!list.every(what => have.has(what))) return null } return true }, 30000)
    proof.check('every kind of remote access record is in the histories: switched on and off, codes made and taken back, computers added, given, connected, disconnected and revoked', !!complete,
      { [lab]: [...await kinds(lab)], [annex]: [...await kinds(annex)] })

    // ------------------------------------------------------------ the windows (only with a renderer bundle)
    if (ui) {
      // this desktop forgets the connection it was revoked from; Windows Firewall has no rule (as on a computer that never shared)
      await near('DELETE', `/api/remotes/${id}`)
      id = null
      windowsHas(0)
      await host('GET', '/api/remote-access?fresh=1')
      const out1 = path.join(proof.dir, 'desktop-window')
      const connected = () => until('the connection of the window part', async () => { const v = await view(); return v?.state === 'connected' ? v : null }, 60000)
      // (the engines' part sent one from the same computer: the window looks for this one)
      const FOR_THE_WINDOW = 'a message from the other computer, for the window'
      const steps = {
        // the administrator said yes at the prompt: the two rules are in Windows Firewall
        'windows-yes': async () => { windowsHas(port); return { ok: true } },
        // somebody took the rules away (or the program moved): the engine reads it the next time the owner looks
        'windows-forgets': async () => { windowsHas(0); return { firewall: (await host('GET', '/api/remote-access?fresh=1')).json?.door?.firewall } },
        // the other computer pastes the line its user was sent: its Add dialog splits it into the two fields
        'other-adds': async sentLine => {
          const [url, token] = String(sentLine?.line ?? '').trim().split(/\s+/)
          const res = await near('POST', '/api/remotes', { body: { url, token } })
          const v = await connected()
          id = v?.id ?? null
          return { status: res.status, detail: res.json?.detail ?? null, connected: !!v }
        },
        'other-sends': async () => ({ status: (await near('POST', `/api/orgs/${await alias(lab)}/nodes/lead/message`, { body: { text: FOR_THE_WINDOW }, remote: id })).status }),
        // between the two windows: this desktop starts from nothing again, and the hosting desktop hands out a new code
        'new-code': async () => {
          if (id) await near('DELETE', `/api/remotes/${id}`)
          id = null
          windowsHas(port)
          await host('PUT', `/api/remote-access/orgs/${lab}`, { on: true })
          const made = await host('POST', `/api/remote-access/orgs/${lab}/invitations`)
          return { line: `${door} ${made.json?.code}`, status: made.status }
        },
        // the hosting desktop gives this computer its other organization too, then stops sharing the first
        'host-stops-sharing': async () => {
          id = (await view())?.id ?? null
          await host('PUT', `/api/remote-access/orgs/${annex}`, { on: true })
          // (the record of this computer's first visit is still in the list: the one that is connected now is meant)
          const me = ((await host('GET', `/api/remote-access/orgs/${annex}`)).json?.known ?? []).find(c => c.label === ME && c.connected)
          const gave = await host('PUT', `/api/remote-access/orgs/${annex}/computers/${me?.id}`)
          await until('the second organization on this desktop', async () => (await view())?.orgs?.filter(o => !o.gone).length === 2)
          const offNow = await host('PUT', `/api/remote-access/orgs/${lab}`, { on: false })
          return { gave: gave.status, off: offNow.status }
        },
      }
      ctl = await control(steps)
      const script = path.join(RIG_DIR, 'desktop', 'remote-host.cjs')
      const common = { version: VERSION, control: ctl.url, host: HOST, me: ME, dana: DANA, lab, port, said: FOR_THE_WINDOW }
      // ---- the hosting desktop's own window: the far engine serves the same renderer bundle
      const hosting = await runDesktop({ run: rig.run, dir: rig.dir, url: far.url, token: far.token, org: lab }, script,
        { org: lab, preset: '1100x800', timeout: 420000, out: out1, args: { ...common, part: 'host', org: lab } })
      const h = hosting.value ?? {}
      const quiet = used => (used.consoleErrors ?? []).filter(e => !/Electron Security Warning/.test(e))
      proof.note('desktop receipt (the hosting desktop\'s window)', { session: hosting.session, guards: hosting.guards, shots: hosting.shots?.map(s => path.basename(s.file)), consoleErrors: quiet(hosting).slice(0, 8) })
      // (the code was used a moment after it was shown; the evidence keeps its shape, not the code)
      proof.file('desktop-host.json', { value: { ...h, add: h.add ? { ...h.add, code: `(${String(h.add.code).length} characters)`, line: '(the address and the code)' } : null }, session: hosting.session, guards: hosting.guards })
      proof.check('the hosting desktop\'s window ran in Session 0 and to its end', hosting.ok === true && hosting.session?.electron === 0, hosting.ok ? hosting.session : { error: hosting.error, output: hosting.electronOutput })
      proof.check('Org settings, Connections has the group "Remote access" with the switch off and its plain sentence', h.off?.checked === false && /add only computers you would trust with this whole computer\.$/.test(h.off?.hint ?? '')
        && JSON.stringify(h.off?.rows) === JSON.stringify(['Let other computers open this organization']), h.off)
      proof.check('turning it on asks Windows through the desktop for the door\'s port, and a No leaves the switch off and says so', JSON.stringify(h.declined?.asked) === JSON.stringify({ add: [port, false] })
        && h.declined?.checked === false && h.declined?.note === 'Nothing changed: Windows Firewall stays as it was.', h.declined)
      proof.check('a Yes turns it on: the address with Copy, the computers, and "Add a computer..."', h.on?.checked === true && h.on?.address === door && (h.on?.rows ?? []).includes('Address')
        && (h.on?.rows ?? []).includes('Computers') && (h.on?.rows ?? []).includes('Let another computer in') && /can now open this organization/.test(h.on?.toast ?? '')
        && (h.on?.computers ?? []).some(c => c.startsWith(DANA)), h.on)
      proof.check('Add a computer shows the address, a one-time code and both in one line', h.add?.address === door && CODE.test(h.add?.code ?? '') && h.add?.line === `${door} ${h.add?.code}`
        && /Valid for 15 minutes, for one computer\.$/.test(h.add?.hint ?? '') && h.add?.masked === 'secret', { ...h.add, code: h.add?.code ? `(${h.add.code.length} characters)` : null, line: h.add?.line ? '(address and code)' : null })
      proof.check('the other computer used that line, and the owner sees it: in the list as connected, and as the chip on the status strip', h.added?.status === 200 && h.added?.connected === true
        && (h.listed ?? []).some(c => c.startsWith(`${ME} · ${client(ME)}`) && / · connected( since .+)?$/.test(c)) && h.chip?.text === '1 computer connected' && String(h.chip?.title).includes(ME), { added: h.added, listed: h.listed, chip: h.chip })
      proof.check('a message from the other computer reads "User · PC-SAM" on the hosting desktop', h.sent?.status === 200 && h.theirs === `User · ${ME}`, { sent: h.sent, theirs: h.theirs })
      proof.check('rules that went missing: "Windows Firewall is blocking this" with Allow, which asks Windows again and clears it', h.blocked?.row === true && JSON.stringify(h.blocked?.asked) === JSON.stringify({ add: [port, false] })
        && h.blocked?.cleared === true, h.blocked)
      proof.check('App settings has the page "Remote access": where it listens, the port, what the door does now, and the organizations', h.page?.listens === 'Tailscale' && h.page?.port === String(port)
        && h.page?.now === 'Listening' && (h.page?.addresses ?? []).includes(door) && (h.page?.orgs ?? []).some(o => /^Far Lab/.test(o) && /2 computers, 1 connected/.test(o))
        && h.page?.stop === true && String(h.page?.subtitle).includes(HOST), h.page)
      proof.check('Revoke asks first and says what goes; then the computer is out of the list', String(h.revoke?.text).includes(`Revoke ${DANA}?`) && /It is disconnected at once and can no longer open this organization\./.test(h.revoke?.text ?? '')
        && JSON.stringify(h.revoke?.left) === JSON.stringify([ME]) && /was revoked/.test(h.revoke?.toast ?? ''), h.revoke)
      proof.check('switching off while a computer is connected says first who loses it', /^Stop letting other computers open Far Lab\? The computer that is connected loses it at once\./.test(h.switchedOff?.asked ?? '')
        && h.switchedOff?.checked === false, h.switchedOff)
      proof.check('the hosting desktop\'s window logged no error', quiet(hosting).length === 0, quiet(hosting).slice(0, 5))

      // ---- this desktop's window: the homepage, then the organization
      const { line } = await steps['new-code']()
      const other = await runDesktop(rig, script, { org: '', preset: '1100x800', timeout: 420000, out: out1, args: { ...common, part: 'other', line } })
      const o = other.value ?? {}
      proof.note('desktop receipt (this desktop\'s window)', { session: other.session, guards: other.guards, shots: other.shots?.map(s => path.basename(s.file)), consoleErrors: quiet(other).slice(0, 8) })
      proof.file('desktop-other.json', { value: o, session: other.session, guards: other.guards })
      proof.check('this desktop\'s window ran in Session 0 and to its end', other.ok === true && other.session?.electron === 0, other.ok ? other.session : { error: other.error, output: other.electronOutput })
      proof.check('one pasted line fills both fields of "Add a remote engine"', o.pasted?.address === door && o.pasted?.token === 26 && o.pasted?.tokenType === 'password', o.pasted)
      proof.check('the hosting desktop is listed under its computer\'s name with the organization it shares', o.head === HOST && (o.rows ?? []).some(r => /Far Lab/.test(r)) && !o.addError, { head: o.head, rows: o.rows, error: o.addError })
      proof.check('Connection details says this desktop has these organizations only', String(o.signedIn).includes(client(ME)) && String(o.signedIn).includes('these organizations only'), { signedIn: o.signedIn })
      proof.check('in the organization\'s window App settings says whose computer it is and that a change is refused', String(o.note).includes(`${HOST} is somebody's own computer: its settings can be read here`), { note: o.note })
      proof.check('when the hosting desktop stops sharing the organization, its window says so', o.stopped?.gave === 200 && o.stopped?.off === 200 && o.banner === `${HOST} no longer shares this organization.`, { stopped: o.stopped, banner: o.banner })
      proof.check('this desktop\'s window logged no error', quiet(other).length === 0, quiet(other).slice(0, 5))
    }
  } catch (e) {
    proof.check(`the proof ran to its end (${String(e?.message ?? e).slice(0, 300)})`, false)
  } finally {
    try { await ctl?.close() } catch { /* closing */ }
    try { const v = await view(); if (v?.id) await near('DELETE', `/api/remotes/${v.id}`) } catch { /* closing */ }
    try { proof.file('remote-access.json', fs.readFileSync(path.join(far.data, 'remote-access.json'), 'utf8')) } catch { /* no file */ }
    try { await far.stop() } catch { /* the run's reap takes what is left */ }
    proof.file('far-fakecli-lead.jsonl', far.fakeLog('lead').map(l => JSON.stringify(l)).join('\n'))
    try { proof.file('remote-engines.json', fs.readFileSync(`${rig.data}/remote-engines.json`, 'utf8').replace(/"sealed_token":\s*"[^"]*"/g, '"sealed_token": "(sealed)"')) } catch { /* no file */ }
  }
  return proof.summary()
}
