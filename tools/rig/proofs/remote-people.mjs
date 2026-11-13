// tools/rig/proofs/remote-people.mjs: several people on one organization
// (docs/rust-engine/remote-org.md, "Several people on one organization").
//
// One far engine in standalone mode runs the organization. Two computers use
// it: THIS desktop, through its own engine's relay, and a second desktop
// ("Dana"), which holds its own client token there and is driven here as its
// engine's relay would drive it. The proof checks what the far engine
// records about who did what, and what each of the two is shown of the other.
//
//   node tools/rig/rig.mjs run tools/rig/proofs/remote-people.mjs
//
// Engines only: no window is opened, so it runs in any session.
//
// At the base nothing records who an action came through: every check on a
// name fails. Before the save check exists, every save goes through and the
// checks on a refused save fail.

import crypto from 'node:crypto'
import fs from 'node:fs'

import { farEngine } from '../far.mjs'
import { touch } from '../lib.mjs'
import { Proof } from '../proof.mjs'

const NAME = 'Galaxy'
/** what this desktop's user chose to be called; unusual, so a search for it in an agent's input means something */
const SAM = 'Sam-7731'
const DANA_CLIENT = 'Orgtree desktop (PC-DANA)'
const SCENARIO = {
  agents: { lead: { turns: [
    { name: 'ask', match: ['ask me'], steps: [
      { tool: 'orgtree_ask', args: { question: 'Which colour should the far engine use?', header: 'Colour', options: [{ label: 'Blue' }, { label: 'Green' }] } },
      { text: 'Asked.' }] },
  ] } },
  default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
}

export function setup() { return { fixture: 'basic' } }

/** How a long text is named in `expect`: the first 16 hex digits of its SHA-256 (domain/expect.rs). */
const rev = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
/** One agent of a tree read. */
const nodeOf = (tree, id) => { const walk = nodes => { for (const n of nodes ?? []) { if (n.id === id) return n; const below = walk(n.children); if (below) return below } return null }; return walk(tree?.roots) }

export default async function (rig) {
  const proof = new Proof('remote-people')
  const far = farEngine(rig, { scenario: SCENARIO, role: 'the far standalone engine of proofs/remote-people.mjs' })
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
  const farTurns = () => far.fakeLog('lead').filter(l => l.kind === 'turn').length
  const org = 'far-lab'
  let id = null
  try {
    // ------------------------------------------------------------ one engine, two computers
    await far.start()
    const made = await far.api('POST', '/api/orgs', { name: 'Far Lab', dirs: [], net_autoconnect: false })
    await far.api('POST', `/api/orgs/${made.slug}/ops`, { op: 'hire', name: 'lead', tier: 'opus', grant: 24, title: 'Far lead', charter: 'You lead the far org. You exist only in test runs.' })
    const added = await near('POST', '/api/remotes', { body: { url: `http://127.0.0.1:${far.port}`, token: far.token, name: NAME } })
    proof.check('this desktop adds the far engine', added.status === 200 && made.slug === org, { status: added.status, detail: added.json?.detail, org: made.slug })
    const first = await rig.waitFor(async () => { const v = await view(); return v?.state === 'connected' ? v : null }, { timeout: 60000, every: 250, what: 'the connection to be connected' })
    id = first.id
    const dana = await far.api('POST', '/api/standalone/clients', { name: DANA_CLIENT })
    /** Dana's desktop: her own token, straight to the far engine as her engine's relay would send it. */
    const asDana = (method, route, body) => far.call(method, route, { body, token: dana.token })
    /** This desktop's user, in a window of the far organization. */
    const asSam = (method, route, body) => near(method, route, { body, remote: id })
    /** A tree read is built from the feed and follows a save by a moment: wait until it shows what is expected. */
    const shows = (read, pick, want) => rig.waitFor(async () => pick((await read('GET', `/api/orgs/${org}`)).json) === want,
      { timeout: 20000, every: 200, what: `the tree to show ${JSON.stringify(want)}` }).then(() => true, () => false)
    const charterOf = tree => nodeOf(tree, 'scout')?.charter ?? null

    // ------------------------------------------------------------ who is who
    const computer = /^Orgtree desktop \((.+)\)$/.exec(first.client_name ?? '')?.[1] ?? null
    proof.check('the far engine says who this desktop is there: the client it made, by its computer name', !!computer && first.me?.id && first.me?.name === computer.slice(0, 40).trim(),
      { me: first.me, client: first.client_name })
    const mine = first.me?.id
    const chosen = await near('PUT', '/api/remotes/shown-as', { body: { label: SAM } })
    const named = await rig.waitFor(async () => { const v = await view(); return v?.me?.name === SAM ? v : null }, { timeout: 30000, every: 250, what: 'the chosen name to reach the far engine' }).catch(() => null)
    const listed = (await far.api('GET', '/api/standalone/clients')).clients ?? []
    proof.check('the name this desktop\'s user chose is the label of its client on the far engine', chosen.status === 200 && !!named && listed.find(c => c.id === mine)?.label === SAM
      && listed.find(c => c.id === dana.id)?.label === 'PC-DANA', { status: chosen.status, labels: listed.map(c => [c.name, c.label]) })
    const people = await near('GET', `/api/remotes/${id}/people`)
    const me = people.json?.people?.find(p => p.you)
    proof.check('Connection details can list who is connected: this desktop, marked as itself', people.status === 200 && people.json?.supported === true && me?.label === SAM && me?.connected === true
      && people.json.people.some(p => p.id === dana.id && p.you === false), { status: people.status, people: people.json?.people?.map(p => [p.label, p.connected, p.you]) })
    const tree = await asSam('GET', `/api/orgs/${org}`)
    proof.check('the organization says its engine records who did what', tree.json?.capabilities?.attribution === true, tree.json?.capabilities)

    // ------------------------------------------------------------ a message
    const before = farTurns()
    const sent = await asSam('POST', `/api/orgs/${org}/nodes/lead/message`, { text: 'a message from the first computer' })
    proof.check('a message goes through the relay', sent.status === 200, { status: sent.status, detail: sent.json?.detail })
    /** every mail row of lead's mailbox, as a window reads it */
    const mailRows = async read => { const box = (await read('GET', `/api/orgs/${org}/nodes/lead/inbox`)).json ?? {}; return ['pending', 'delivered', 'sent'].flatMap(k => box[k] ?? []) }
    const row = (await mailRows(asDana)).find(m => m.body === 'a message from the first computer')
    proof.check('the other computer reads whose message it is: the name, and the computer it came through', row?.from === '@user' && row?.via?.id === mine && row?.via?.name === SAM
      && row?.via?.on === first.client_name, row ? { from: row.from, via: row.via } : null)
    // In Session 0 with a user signed in, an engine holds its first turns for the sign-in helper until 60 s after its start.
    await rig.waitFor(() => farTurns() > before, { timeout: 150000, what: 'the far agent to take the message' })
    const transcript = await rig.waitFor(async () => {
      const chat = (await asDana('GET', `/api/orgs/${org}/nodes/lead/chat?last=50`)).json
      const rows = (chat?.messages ?? []).flatMap(m => (m.segments ?? []).flatMap(s => s.rows ?? []))
      return rows.find(m => m.body === 'a message from the first computer') ?? null
    }, { timeout: 30000, every: 250, what: 'the delivered message in the transcript' }).catch(() => null)
    proof.check('the delivered message keeps it in the transcript', transcript?.via?.name === SAM && transcript?.via?.id === mine, transcript ? { via: transcript.via } : null)
    const heard = far.fakeLog('lead').filter(l => JSON.stringify(l).includes('a message from the first computer'))
    proof.check('the agent still reads "user": the name is for people', heard.length > 0 && !far.fakeLog('lead').some(l => JSON.stringify(l).includes(SAM)), { linesWithTheMessage: heard.length })

    // ------------------------------------------------------------ an operation and a settings change
    const hired = await asDana('POST', `/api/orgs/${org}/ops`, { op: 'hire', name: 'scout', tier: 'haiku', parent: 'lead', title: 'Scout' })
    const settings = await asSam('POST', `/api/orgs/${org}/settings`, { default_effort: 'high' })
    const events = async read => (await read('GET', `/api/orgs/${org}/events?last=200`)).json?.events ?? []
    const seenBySam = await events(asSam)
    const hire = seenBySam.findLast(e => e.op === 'hire' && e.detail?.node === 'scout')
    proof.check('a hire by the other computer carries her name in this window', hired.status === 200 && hire?.actor === '@user' && hire?.via?.id === dana.id && hire?.via?.name === 'PC-DANA'
      && hire?.via?.on === DANA_CLIENT, hire ? { actor: hire.actor, via: hire.via } : { status: hired.status, detail: hired.json?.detail })
    const changed = (await events(asDana)).findLast(e => e.op === 'settings')
    proof.check('a settings change by this desktop carries its name on the other computer', settings.status === 200 && changed?.via?.id === mine && changed?.via?.name === SAM,
      changed ? { via: changed.via } : { status: settings.status, detail: settings.json?.detail })
    const firstHire = seenBySam.find(e => e.op === 'hire' && e.detail?.node === 'lead')
    proof.check('what the startup token did says so', firstHire?.via?.id === 'startup' && firstHire?.via?.name === 'Startup token', firstHire?.via)
    const history = (await asDana('GET', `/api/orgs/${org}/history/events?limit=50`)).json
    const inHistory = (history?.items ?? []).find(e => e.op === 'settings')
    proof.check('the History window carries it too', inHistory?.via?.name === SAM, inHistory ? { via: inHistory.via } : { keys: Object.keys(history ?? {}) })

    // ------------------------------------------------------------ an agent's own record
    await far.api('POST', '/api/rig/tool', { org, agent: 'lead', tool: 'orgtree_status', args: { status: 'working', summary: 'A status from the agent itself.' } })
    const status = (await events(asSam)).findLast(e => e.op === 'status')
    proof.check('what an agent does carries no computer: the record is as it always was', !!status && status.actor === 'lead' && !('via' in status), status ? Object.keys(status) : null)

    // ------------------------------------------------------------ an answer
    const askedAt = farTurns()
    await asDana('POST', `/api/orgs/${org}/nodes/lead/message`, { text: 'ask me a question' })
    await rig.waitFor(() => farTurns() > askedAt, { timeout: 150000, what: 'the far agent to ask' })
    const openAsk = await rig.waitFor(async () => ((await asSam('GET', `/api/orgs/${org}`)).json?.asks ?? []).find(a => a.status === 'open' && a.node === 'lead') ?? null,
      { timeout: 30000, every: 250, what: 'the question in the window' }).catch(() => null)
    const answered = openAsk ? await asSam('POST', `/api/orgs/${org}/asks/${openAsk.id}/answer`, { selected: ['Blue'], rev: openAsk.rev }) : { status: 0 }
    const settled = await rig.waitFor(async () => ((await asDana('GET', `/api/orgs/${org}`)).json?.asks ?? []).find(a => a.id === openAsk?.id && a.status !== 'open') ?? null,
      { timeout: 30000, every: 250, what: 'the answered question on the other computer' }).catch(() => null)
    proof.check('an answered question says who answered it', answered.status === 200 && settled?.answered_via?.id === mine && settled?.answered_via?.name === SAM,
      settled ? { status: settled.status, answered_via: settled.answered_via } : { answered: answered.status, detail: answered.json?.detail })
    const answerMail = (await mailRows(asDana)).find(m => m.id === settled?.answer_mail)
    proof.check('the answer in the transcript is that person\'s', answerMail?.from === '@user' && answerMail?.via?.name === SAM, answerMail ? { via: answerMail.via } : null)

    // ------------------------------------------------------------ the docket
    const item = await far.api('POST', '/api/rig/tool', { org, agent: 'lead', tool: 'orgtree_work',
      args: { action: 'create', kind: 'non-code', title: 'People item', objective: 'A docket item two people look at.\n\nNothing depends on it.', owner: 'lead' } })
    const slug = /people-item[a-z0-9-]*/.exec(String(item.text))?.[0] ?? 'people-item'
    await far.api('POST', '/api/rig/tool', { org, agent: 'lead', tool: 'orgtree_work', args: { action: 'update', slug, owner: 'lead', attention: true, attention_reason: 'Please look at this.' } })
    const flag = (await asDana('GET', `/api/orgs/${org}/work-items/${slug}`)).json?.item?.manual_attention
    const dismissed = await asDana('POST', `/api/orgs/${org}/work-items/${slug}/dismiss-attention`, { set_rev: flag?.set_rev })
    const rows = (await asSam('GET', `/api/orgs/${org}/work-items/${slug}`)).json?.item?.history ?? []
    const dismissal = rows.findLast(h => h.op === 'dismiss_attention')
    proof.check('a docket change by the user says whose it was', dismissed.status === 200 && dismissal?.by === 'user' && dismissal?.via?.id === dana.id && dismissal?.via?.name === 'PC-DANA',
      dismissal ? { by: dismissal.by, via: dismissal.via } : { status: dismissed.status, detail: dismissed.json?.detail, ops: rows.map(h => h.op), flag })
    const byAgent = rows.find(h => h.op === 'create' || h.by?.node === 'lead')
    proof.check('a docket change by an agent carries no computer', !!byAgent && !('via' in byAgent), byAgent ? Object.keys(byAgent) : rows.map(h => h.op))

    // ------------------------------------------------------------ the undo history
    const saved = await asSam('POST', `/api/orgs/${org}/nodes/scout/scope`, { charter: 'You scout for the far org. You exist only in test runs.' })
    const undo = (await asDana('GET', `/api/orgs/${org}/undo-history`)).json
    const entry = (undo?.entries ?? [])[0]
    proof.check('an entry of the undo history says whose action it was', saved.status === 200 && entry?.via?.id === mine && entry?.via?.name === SAM,
      entry ? { kind: entry.kind, label: entry.label, via: entry.via } : { status: saved.status, detail: saved.json?.detail })

    // ------------------------------------------------------------ a renamed person keeps their old records
    await near('PUT', '/api/remotes/shown-as', { body: { label: 'Samantha' } })
    await rig.waitFor(async () => (await view())?.me?.name === 'Samantha', { timeout: 30000, every: 250, what: 'the new name to reach the far engine' }).catch(() => null)
    await asSam('POST', `/api/orgs/${org}/settings`, { default_effort: 'medium' })
    const both = (await events(asDana)).filter(e => e.op === 'settings').map(e => e.via?.name)
    proof.check('a record keeps the name its person had then', both.length >= 2 && both.at(-2) === SAM && both.at(-1) === 'Samantha', both)

    // ------------------------------------------------------------ a save that would replace someone's newer change
    proof.check('the organization says a save may say what it was based on', (await asSam('GET', `/api/orgs/${org}`)).json?.capabilities?.expect === true)
    // both open the agent's settings while its charter is this
    const opened = 'You scout for the far org. You exist only in test runs.'
    const sawIt = await shows(asSam, charterOf, opened) && await shows(asDana, charterOf, opened)
    const hers = await asDana('POST', `/api/orgs/${org}/nodes/scout/scope`, { charter: 'The charter as Dana left it.', expect: { charter: opened } })
    proof.check('a save based on what is stored goes through', sawIt && hers.status === 200 && await shows(asSam, charterOf, 'The charter as Dana left it.'),
      { sawIt, status: hers.status, detail: hers.json?.detail })
    const entriesBefore = ((await asSam('GET', `/api/orgs/${org}/undo-history`)).json?.entries ?? []).length
    // the desk saves through a gesture; this one is based on the charter as it was before Dana's save
    const stale = await asSam('POST', `/api/orgs/${org}/gesture`, { label: 'Settings: scout', steps: [{ op: 'scope', node: 'scout', charter: 'The charter as Sam would have it.', expect: { charter: opened } }] })
    const field = stale.json?.conflict?.fields?.[0]
    proof.check('a save based on an older charter is refused and says who changed it and when', stale.status === 409 && stale.json?.code === 'save_conflict'
      && stale.json?.conflict?.target === 'agent:scout' && field?.field === 'charter' && field?.stored === 'The charter as Dana left it.' && field?.actor === '@user'
      && field?.changed_by?.id === dana.id && field?.changed_by?.name === 'PC-DANA' && Math.abs(Date.now() - Date.parse(field?.changed_at ?? '')) < 120000
      && stale.json?.detail === 'PC-DANA changed charter since you opened it. Nothing was saved.', { status: stale.status, body: stale.json })
    const entriesAfter = ((await asSam('GET', `/api/orgs/${org}/undo-history`)).json?.entries ?? []).length
    proof.check('a refused save leaves no entry in the undo history', entriesAfter === entriesBefore, { entriesBefore, entriesAfter })
    // "Save mine anyway" is a new save, based on what is stored now (named by its revision). It goes through only
    // while the stored charter is still Dana's, so it also shows that the refused save wrote nothing.
    const anyway = await asSam('POST', `/api/orgs/${org}/gesture`, { label: 'Settings: scout', steps: [{ op: 'scope', node: 'scout', charter: 'The charter as Sam would have it.', expect: { charter: { rev: rev('The charter as Dana left it.') } } }] })
    proof.check('saving it anyway is a new save based on what is stored now', anyway.status === 200 && await shows(asDana, charterOf, 'The charter as Sam would have it.'),
      { status: anyway.status, detail: anyway.json?.detail })
    // there is no force flag: Dana's "anyway", still based on her own text, meets Sam's newer save
    const third = await asDana('POST', `/api/orgs/${org}/nodes/scout/scope`, { charter: 'A third text.', expect: { charter: { rev: rev('The charter as Dana left it.') } } })
    const thirdField = third.json?.conflict?.fields?.[0]
    proof.check('a save anyway whose base changed in between is refused again', third.status === 409 && third.json?.code === 'save_conflict'
      && thirdField?.stored === 'The charter as Sam would have it.' && thirdField?.changed_by?.id === mine && thirdField?.changed_by?.name === 'Samantha', { status: third.status, body: third.json })
    const unchecked = await asDana('POST', `/api/orgs/${org}/nodes/scout/scope`, { charter: 'A save that says nothing about its base.' })
    proof.check('a save that names no base is not checked (an older window)', unchecked.status === 200, { status: unchecked.status })
    const unknown = await asDana('POST', `/api/orgs/${org}/nodes/scout/scope`, { effort: 'high', expect: { colour: 'blue' } })
    proof.check('a base for a field the save does not have is refused as a mistake', unknown.status === 400 && String(unknown.json?.detail).includes('colour'), { status: unknown.status, detail: unknown.json?.detail })

    // the same for an organization setting, the app-wide defaults, org.md and the instructions for all organizations
    const effortShown = await shows(asSam, tree => tree?.default_effort, 'medium') && await shows(asDana, tree => tree?.default_effort, 'medium')
    const mineFirst = await asSam('POST', `/api/orgs/${org}/settings`, { default_effort: 'max', expect: { default_effort: 'medium' } })
    const herLate = await asDana('POST', `/api/orgs/${org}/settings`, { default_effort: 'low', expect: { default_effort: 'medium' } })
    const setting = herLate.json?.conflict?.fields?.[0]
    proof.check('an organization setting someone else changed is not replaced', effortShown && mineFirst.status === 200 && herLate.status === 409 && herLate.json?.code === 'save_conflict'
      && herLate.json?.conflict?.target === 'org' && setting?.field === 'default_effort' && setting?.stored === 'max' && setting?.changed_by?.name === 'Samantha'
      && herLate.json?.detail === 'Samantha changed default_effort since you opened it. Nothing was saved.',
      { effortShown, first: mineFirst.status, late: herLate.status, body: herLate.json })
    const defaults = (await asDana('GET', '/api/defaults')).json
    const herDefault = await asDana('POST', '/api/defaults', { default_effort: 'high', expect: { default_effort: defaults?.default_effort ?? null } })
    const myDefault = await asSam('POST', '/api/defaults', { default_effort: 'low', expect: { default_effort: defaults?.default_effort ?? null } })
    const appField = myDefault.json?.conflict?.fields?.[0]
    proof.check('an app-wide default someone else changed is not replaced', herDefault.status === 200 && myDefault.status === 409 && myDefault.json?.conflict?.target === 'defaults'
      && appField?.field === 'default_effort' && appField?.stored === 'high' && appField?.changed_by?.id === dana.id, { hers: herDefault.status, mine: myDefault.status, body: myDefault.json })
    const md = (await asSam('GET', `/api/orgs/${org}/orgmd`)).json
    const herMd = await asDana('PUT', `/api/orgs/${org}/orgmd`, { content: '# The far lab, as Dana wrote it\n', base_rev: md?.rev })
    const myMd = await asSam('PUT', `/api/orgs/${org}/orgmd`, { content: '# The far lab, as Sam wrote it\n', base_rev: md?.rev })
    const mdField = myMd.json?.conflict?.fields?.[0]
    proof.check('org.md someone else saved is not replaced, and the answer carries their text and their name', herMd.status === 200 && myMd.status === 409
      && myMd.json?.detail === 'PC-DANA changed org.md since you opened it. Reload it and make your edit again.' && myMd.json?.code === 'save_conflict' && myMd.json?.conflict?.target === 'orgmd'
      && mdField?.stored === '# The far lab, as Dana wrote it\n' && mdField?.changed_by?.name === 'PC-DANA', { hers: herMd.status, mine: myMd.status, body: myMd.json })
    const all = (await asSam('GET', '/api/app-settings/instructions')).json
    const herAll = await asDana('PUT', '/api/app-settings/instructions', { content: 'For every organization, as Dana wrote it.\n', base_rev: all?.rev })
    const myAll = await asSam('PUT', '/api/app-settings/instructions', { content: 'For every organization, as Sam wrote it.\n', base_rev: all?.rev })
    const allField = myAll.json?.conflict?.fields?.[0]
    proof.check('the instructions for all organizations are kept the same way', herAll.status === 200 && myAll.status === 409 && myAll.json?.conflict?.target === 'instructions'
      && myAll.json?.detail === 'PC-DANA changed the instructions for all orgs since you opened them. Reload them and make your edit again.'
      && allField?.stored === 'For every organization, as Dana wrote it.\n' && allField?.changed_by?.id === dana.id, { hers: herAll.status, mine: myAll.status, body: myAll.json })

    // ------------------------------------------------------------ a question two people answer
    const againAt = farTurns()
    await asSam('POST', `/api/orgs/${org}/nodes/lead/message`, { text: 'ask me a question' })
    await rig.waitFor(() => farTurns() > againAt, { timeout: 150000, what: 'the far agent to ask again' })
    const second = await rig.waitFor(async () => ((await asDana('GET', `/api/orgs/${org}`)).json?.asks ?? []).find(a => a.status === 'open' && a.node === 'lead') ?? null,
      { timeout: 30000, every: 250, what: 'the second question' }).catch(() => null)
    const herAnswer = second ? await asDana('POST', `/api/orgs/${org}/asks/${second.id}/answer`, { selected: ['Green'], rev: second.rev }) : { status: 0 }
    const myAnswer = second ? await asSam('POST', `/api/orgs/${org}/asks/${second.id}/answer`, { selected: ['Blue'], rev: second.rev }) : { status: 0 }
    const settledBy = myAnswer.json?.settled
    proof.check('a question someone else answered first says who answered it, and what', herAnswer.status === 200 && myAnswer.status === 409 && myAnswer.json?.code === 'request_settled'
      && myAnswer.json?.detail === 'that request was already answered' && settledBy?.status === 'answered' && settledBy?.answered_via?.id === dana.id
      && settledBy?.answered_via?.name === 'PC-DANA' && JSON.stringify(settledBy?.answer ?? null).includes('Green') && !!settledBy?.resolved_at,
      { hers: herAnswer.status, mine: myAnswer.status, body: myAnswer.json })
  } catch (e) {
    proof.check(`the proof ran to its end (${String(e?.message ?? e).slice(0, 300)})`, false)
  } finally {
    try { if (id) await near('DELETE', `/api/remotes/${id}`) } catch { /* closing */ }
    try { await far.stop() } catch { /* the run's reap takes what is left */ }
    proof.file('far-fakecli-lead.jsonl', far.fakeLog('lead').map(l => JSON.stringify(l)).join('\n'))
    try { proof.file('remote-engines.json', fs.readFileSync(`${rig.data}/remote-engines.json`, 'utf8').replace(/"sealed_token":\s*"[^"]*"/g, '"sealed_token": "(sealed)"')) } catch { /* no file */ }
  }
  return proof.summary()
}
