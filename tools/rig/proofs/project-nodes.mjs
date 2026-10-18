// Proof: project nodes and the fair project mail queue (docs/rust-engine/
// PROJECT-NODES.md; user 2026-10-16), through the real engine.
//   the user creates a project; it is a tree node with kind=project, no seat,
//   a transparent scope and its folder at _teams/<id>; mail to it starts no
//   turn and waits in its mailbox while nobody watches
//   an agent creates a project under itself with orgtree_project
//   agents hired under a project are paid by the agent above it (credits
//   transparent, user 20:40Z); an agent below the project cannot hire there
//   fair_queue watchdogs: the backlog goes to the first watcher that arms;
//   later mail goes round-robin, least recently woken first; a halted
//   watcher stays in turn; the watcher's copy is ordinary mail from the
//   sender, the project's copy is read and records who claimed it
//   reach: an agent beside the project cannot write to it or inspect it;
//   inspection (orgtree_inbox project=) shows waiting mail without claiming it
//   presenting under a project stores the document on the project node
//   the superior of an agent under a project is the agent above it: its
//   status notice goes there, its prompt names it, its peers are reachable;
//   the project's AGENTS.md and folder reach the agents under it, and the
//   agent above it is told of the projects below it
//   an agent cannot retire a project it is inside; renaming keeps its dogs
//   a project placed above an agent holds it; the agent above pays the same
// Run: node tools/rig/rig.mjs run tools/rig/proofs/project-nodes.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('project-nodes')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what: 'seed turns to settle', timeout: 60000 })
  const said = r => (r?.ok ? JSON.stringify(r.json ?? r.text) : String(r?.text)).slice(0, 300)
  const opTry = body => rig.op(body).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const row = name => rig.agentRow(name)
  const node = name => rig.one(`SELECT id, name, kind, tier, seat::float8 AS seat, grant_credits::float8 AS grant, scope, scratch_dir, parent_id, state
                                  FROM ot.agents WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active') AND name = '${name}'`)
  const free = name => rig.one(`SELECT (a.grant_credits - coalesce((SELECT sum(c.seat + c.grant_credits) FROM ot.agents c
                                   WHERE c.parent_id = a.id AND c.state = 'live'), 0))::float8 AS free
                                  FROM ot.agents a WHERE a.id = ${node(name).id}`).free
  const mailTo = id => rig.sql(`SELECT id, uid, sender, state, notice, body, extra FROM ot.mail WHERE recipient_agent_id = ${id} ORDER BY id`)

  // ------------------------------------------------------------ the user creates a project
  const made = await opTry({ op: 'create_project', name: 'website', parent: 'boss', description: 'The company website.\nShip it.' })
  const web = node('website')
  p.check('the user creates project website under boss', made.ok && web?.kind === 'project', made.ok ? made.v : made.error)
  p.check('a project has no seat, no grant of its own, the sentinel tier and a transparent scope',
    web && web.seat === 0 && web.grant === 0 && web.tier === 'project' && web.scope?.transparent === true, web)
  const webFolder = path.join(rig.data, 'scratch', rig.org, '_teams', String(web?.id))
  p.check('its folder is its team workspace and exists', web && path.resolve(web.scratch_dir ?? '') === path.resolve(webFolder) && fs.existsSync(webFolder),
    { scratch_dir: web?.scratch_dir, expected: webFolder })
  const tree = await rig.api('GET', `/api/orgs/${rig.org}/records`)
  const webRec = (tree.records ?? []).find(r => r.entity === 'agent' && r.body?.id === 'website')?.body
  p.check('the tree record says kind project, with no model and no free credits', webRec?.kind === 'project' && webRec?.model_id === '' && webRec?.free === 0,
    webRec && { kind: webRec.kind, model_id: webRec.model_id, free: webRec.free, parent: webRec.parent_id })

  // the project's notes, written before any agent under it starts its CLI
  // (a running CLI keeps the copy it started with, by design)
  fs.writeFileSync(path.join(webFolder, 'AGENTS.md'), 'WEBSITE-NOTES-SENTINEL: deploy from main only.\n')

  // ------------------------------------------------------------ mail with nobody watching
  await rig.userMail('website', 'First request for the website (from the user).')
  await new Promise(r => setTimeout(r, 1500))
  const firstMail = mailTo(web.id)
  p.check('user mail to the project waits in its mailbox, unclaimed', firstMail.length === 1 && firstMail[0].state === 'pending', firstMail)
  p.check('a project never runs a turn', rig.turns('website').length === 0, rig.turns('website'))

  // ------------------------------------------------------------ an agent creates a project
  const docs = await rig.tool('alice', 'orgtree_project', { action: 'create', name: 'docs', index: 0, description: 'Docs' })
  p.check('alice creates project docs under herself with orgtree_project', docs.ok && node('docs')?.parent_id === row('alice').id, said(docs))
  const noIndex = await rig.tool('alice', 'orgtree_project', { action: 'create', name: 'docs2' })
  p.check('an agent must give the index, as for hires', !noIndex.ok && /index/.test(noIndex.text), said(noIndex))
  const topByAgent = await rig.tool('alice', 'orgtree_project', { action: 'create', name: 'toplevel', parent: 'user', index: 0 })
  p.check('only the user creates a top-level project', !topByAgent.ok, said(topByAgent))

  // ------------------------------------------------------------ hires under the project; credits transparent
  const bossFree0 = free('boss')
  const h1 = await opTry({ op: 'hire', name: 'dev1', parent: 'website', tier: 'haiku', grant: 0, title: 'Web dev 1' })
  const h2 = await opTry({ op: 'hire', name: 'dev2', parent: 'website', tier: 'haiku', grant: 0, title: 'Web dev 2' })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'hire turns to settle', timeout: 60000 }).catch(() => {})
  const d1 = node('dev1'), d2 = node('dev2'), web2 = node('website')
  p.check('the user hires dev1 and dev2 under the project', h1.ok && h2.ok && d1?.parent_id === web.id && d2?.parent_id === web.id,
    { h1: h1.ok || h1.error, h2: h2.ok || h2.error })
  const seats = (d1?.seat ?? 0) + (d2?.seat ?? 0) + (d1?.grant ?? 0) + (d2?.grant ?? 0)
  p.check('the project holds exactly its agents\' stakes and no free credits (a mirror)', web2.grant === seats && free('website') === 0, { grant: web2.grant, seats })
  p.check('boss, the agent above the project, paid for them', Math.abs((bossFree0 - free('boss')) - seats) < 1e-6, { before: bossFree0, after: free('boss'), seats })
  const hireBelow = await rig.tool('dev1', 'orgtree_hire', { name: 'dev3', parent: 'website', tier: 'haiku', grant: 0, charter: 'x', index: 0,
    add_dirs: [], tools: { bash: false, web: false, edit: false, subagents: false, mcp: [] }, org_visibility: 'team' })
  p.check('an agent below the project cannot hire under it: the agent above pays', !hireBelow.ok && /paid by the agent above/.test(hireBelow.text), said(hireBelow))

  // ------------------------------------------------------------ the fair queue
  const q1 = await rig.tool('dev1', 'orgtree_watchdog', { action: 'create', name: 'web-queue', kind: 'fair_queue', target: 'website' })
  p.check('dev1 (below the project) watches it with a fair_queue dog', q1.ok && q1.json?.id === 'web-queue', said(q1))
  const handedBacklog = await rig.waitFor(() => mailTo(d1.id).filter(m => m.extra?.via_project?.name === 'website'),
    { what: 'the backlog mail to reach dev1', timeout: 20000 }).catch(() => [])
  const orig = mailTo(web.id)[0]
  p.check('the backlog goes to the first watcher that arms, as ordinary mail from its sender', handedBacklog.length === 1 && handedBacklog[0].sender === '@user'
    && /First request/.test(handedBacklog[0].body), handedBacklog.map(m => ({ sender: m.sender, via: m.extra?.via_project, body: m.body.slice(0, 60) })))
  p.check('the project\'s copy is read and records who claimed it', orig?.state === 'read' && orig?.extra?.claimed?.by === 'dev1', orig && { state: orig.state, claimed: orig.extra?.claimed })
  const q2 = await rig.tool('dev2', 'orgtree_watchdog', { action: 'create', name: 'web-queue', kind: 'fair_queue', target: 'website' })
  p.check('dev2 watches it too (two owners may each keep a web-queue)', q2.ok, said(q2))
  const send = (from, text) => rig.tool(from, 'orgtree_message', { metadata: { to: 'website' }, body: text })
  const outsider = await send('carol', 'Carol is beside the project, not above or below it.')
  p.check('carol, beside the project, cannot write to it', !outsider.ok && /above or below project website/.test(outsider.text), said(outsider))
  const m2 = await send('boss', 'Second request (from boss).')
  p.check('boss writes to the project and is told who got it', m2.ok && /handed it to dev2/.test(m2.text), said(m2))
  const m3 = await send('boss', 'Third request (from boss).')
  p.check('round robin: the next mail goes to the least recently woken watcher, dev1', m3.ok && /handed it to dev1/.test(m3.text), said(m3))
  const dogs = rig.sql(`SELECT a.name, w.fired FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id WHERE w.kind = 'fair_queue' ORDER BY a.name`)
  p.check('each dog counts its handed mail', JSON.stringify(dogs) === JSON.stringify([{ name: 'dev1', fired: 2 }, { name: 'dev2', fired: 1 }]), dogs)
  // a halted watcher stays in turn
  const halted = await opTry({ op: 'halt', nodes: ['dev2'] })
  await rig.waitFor(() => row('dev2')?.halt?.phase === 'halted', { what: 'dev2 to be halted', timeout: 20000 }).catch(() => {})
  const m4 = await send('boss', 'Fourth request (to a halted watcher).')
  const d2mail = mailTo(d2.id).filter(m => /Fourth request/.test(m.body))
  p.check('a halted watcher keeps its turn: the mail waits in its mailbox', halted.ok && m4.ok && /handed it to dev2/.test(m4.text) && d2mail[0]?.state === 'pending',
    { halt: halted.ok || halted.error, said: said(m4), state: d2mail[0]?.state })
  await opTry({ op: 'unhalt', nodes: ['dev2'] })

  // ------------------------------------------------------------ inspection without claiming
  for (const who of ['dev1', 'dev2']) await rig.tool(who, 'orgtree_watchdog', { action: 'pause', id: 'web-queue' })
  const m5 = await send('boss', 'Fifth request (nobody watching).')
  p.check('with every watcher paused the mail waits in the project mailbox', m5.ok && /Queued in project website/.test(m5.text), said(m5))
  const list = await rig.tool('alice', 'orgtree_inbox', { action: 'list', project: 'website' })
  p.check('alice, beside the project, cannot inspect its mailbox', !list.ok, said(list))
  const look = await rig.tool('boss', 'orgtree_inbox', { action: 'list', project: 'website' })
  const waiting = look.json?.messages ?? []
  p.check('boss (above) lists the project\'s waiting mail', look.ok && look.json?.waiting === 1 && /Fifth request/.test(waiting[0]?.preview ?? ''), said(look))
  const fetched = await rig.tool('dev1', 'orgtree_inbox', { action: 'fetch', project: 'website', message_ids: [waiting[0]?.id] })
  p.check('dev1 (below) fetches it whole', fetched.ok && /Fifth request/.test(fetched.json?.messages?.[0]?.content ?? ''), said(fetched))
  const still = rig.one(`SELECT state FROM ot.mail WHERE uid = '${waiting[0]?.id}'`)
  p.check('inspection claims nothing: the mail is still waiting', still?.state === 'pending', still)
  await rig.tool('dev2', 'orgtree_watchdog', { action: 'resume', id: 'web-queue' })
  const resumed = await rig.waitFor(() => mailTo(d2.id).filter(m => /Fifth request/.test(m.body)), { what: 'the waiting mail to reach dev2', timeout: 20000 }).catch(() => [])
  p.check('resuming a watcher hands it the waiting mail', resumed.length === 1, resumed.length)

  // ------------------------------------------------------------ presentations
  const pres = await rig.tool('boss', 'orgtree_present', { title: 'Website plan', body: '# Plan\n\nShip it.', project: 'website' })
  const doc = rig.one(`SELECT agent_id, node_name, presented_by FROM ot.documents WHERE title = 'Website plan'`)
  p.check('boss presents a document under the project', pres.ok && doc?.agent_id === web.id && doc?.node_name === 'website' && doc?.presented_by === 'boss',
    { said: said(pres), doc })
  const presOut = await rig.tool('carol', 'orgtree_present', { title: 'Nope', body: 'x', project: 'website' })
  p.check('carol cannot present under it', !presOut.ok, said(presOut))

  // ------------------------------------------------------------ superior, notes and folders
  const turnsBefore = rig.turns('dev1').filter(t => t.ended_at).length
  await rig.userMail('dev1', 'Please report your status.')
  await rig.waitTurns('dev1', turnsBefore + 1).catch(() => {})
  const identity = name => {
    const args = rig.fakeLog(name).filter(l => l.kind === 'start').at(-1)?.args ?? []
    const at = args.indexOf('--append-system-prompt-file')
    const file = at >= 0 ? args[at + 1] : null
    return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  }
  const dev1Prompt = identity('dev1')
  p.check('dev1\'s superior is boss, the agent above the project', /Your superior: boss\./.test(dev1Prompt), (dev1Prompt.match(/Your superior: [^.]*\./) ?? [])[0])
  p.check('dev1 holds the project folder, labelled as the project it works on', dev1Prompt.includes('the folder of project website'), dev1Prompt.length)
  p.check('dev1 gets the project\'s AGENTS.md at session start', dev1Prompt.includes('WEBSITE-NOTES-SENTINEL'), dev1Prompt.length)
  // USER 2026-10-17 19:14Z: a project's description reaches every agent under it, like a team charter
  p.check('dev1 gets the project\'s description as a standing charter', dev1Prompt.includes('Standing charter from project website: The company website.\nShip it.'),
    (dev1Prompt.match(/Standing charter from [^\n]*/g) ?? []))
  const st = await rig.tool('dev1', 'orgtree_status', { status: 'done', summary: 'website status for boss' })
  const notice = rig.one(`SELECT recipient_name FROM ot.mail WHERE sender = 'dev1' AND body LIKE 'Status: done%' ORDER BY id DESC LIMIT 1`)
  p.check('dev1\'s status notice goes to boss, not to the project', st.ok && notice?.recipient_name === 'boss', { said: said(st), notice })
  const toBoss = await rig.tool('dev1', 'orgtree_message', { metadata: { to: 'boss' }, body: 'Hello boss.' })
  const toPeer = await rig.tool('dev1', 'orgtree_message', { metadata: { to: 'carol' }, body: 'Hello carol, peer under boss.' })
  p.check('dev1 may write to boss and to boss\'s other reports', toBoss.ok && toPeer.ok, { boss: said(toBoss), carol: said(toPeer) })
  const bossTurns = rig.turns('boss').filter(t => t.ended_at).length
  await rig.waitTurns('boss', bossTurns + 1).catch(() => {})
  const bossPrompt = identity('boss')
  p.check('boss, above the project, does not get its description', !bossPrompt.includes('Standing charter from project website'), bossPrompt.length)
  p.check('boss is told of the projects below it, with their folders', bossPrompt.includes('PROJECTS BELOW YOU') && bossPrompt.includes(`${web.id} (project website)`),
    bossPrompt.length)

  // ------------------------------------------------------------ control
  const retireInside = await rig.tool('dev1', 'orgtree_retire', { node: 'website' })
  p.check('dev1 cannot retire the project it is inside', !retireInside.ok && /inside project website/.test(retireInside.text), said(retireInside))
  const rename = await rig.tool('dev1', 'orgtree_rename', { node: 'website', name: 'site' })
  const dogTargets = rig.sql(`SELECT DISTINCT target FROM ot.watchdogs WHERE kind = 'fair_queue'`)
  p.check('dev1 renames the project from below; the fair_queue dogs follow', rename.ok && node('site')?.id === web.id
    && dogTargets.length === 1 && dogTargets[0].target === 'site', { said: said(rename), dogTargets })
  const switchProject = await rig.tool('boss', 'orgtree_switch_model', { node: 'site', tier: 'sonnet' })
  p.check('agent-only operations refuse a project', !switchProject.ok && /is a project, not an agent/.test(switchProject.text), said(switchProject))

  // ------------------------------------------------------------ a project placed above an agent
  const bossFree1 = free('boss')
  const wrap = await opTry({ op: 'create_project', name: 'review', above: 'carol' })
  const rev = node('review')
  p.check('a project placed above carol holds her where she was', wrap.ok && rev?.parent_id === row('boss').id && node('carol')?.parent_id === rev?.id,
    wrap.ok ? wrap.v : wrap.error)
  p.check('boss pays exactly as before the wrap', Math.abs(free('boss') - bossFree1) < 1e-6, { before: bossFree1, after: free('boss') })

  // ------------------------------------------------------------ docket items and projects (point 23)
  // USER 2026-10-17 22:21Z, superseding 2026-10-16 20:23Z: items no longer attach to projects;
  // a project's docket lists the items owned by the agents under it
  const attach = await rig.tool('dev1', 'orgtree_work', { action: 'create', title: 'Attached', kind: 'non-code',
    objective: 'Try to attach.', project: 'site' })
  p.check('orgtree_work refuses `project`: items no longer attach to projects', !attach.ok && /no longer attach to projects/.test(attach.text), said(attach))
  const made2 = await rig.tool('dev1', 'orgtree_work', { action: 'create', title: 'Site launch checklist', kind: 'non-code',
    objective: 'The site has no launch checklist. Write one.' })
  const slug = made2.json?.slug
  p.check('dev1 creates its own item', made2.ok && !!slug, said(made2))
  const coUpdate = await rig.tool('dev2', 'orgtree_work', { action: 'update', slug, owner: 'dev1',
    done_so_far: ['outline drafted'], working_on_next: ['fill it in'] })
  p.check('dev2, beside dev1 under the same project, holds no owner rights on it (no co-ownership)', !coUpdate.ok, said(coUpdate))

  // ------------------------------------------------------------ nested project descriptions
  const ui = await opTry({ op: 'create_project', name: 'ui', parent: 'site', description: 'The UI part of the site.' })
  const h5 = await opTry({ op: 'hire', name: 'dev5', parent: 'ui', tier: 'haiku', grant: 0, title: 'UI dev' })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'dev5 hire turn', timeout: 60000 }).catch(() => {})
  const dev5Turns = rig.turns('dev5').filter(t => t.ended_at).length
  await rig.userMail('dev5', 'Hello dev5.')
  await rig.waitTurns('dev5', dev5Turns + 1).catch(() => {})
  const dev5Prompt = identity('dev5')
  const outer = dev5Prompt.indexOf('Standing charter from project site: The company website.')
  const inner = dev5Prompt.indexOf('Standing charter from project ui: The UI part of the site.')
  p.check('an agent in a nested project gets both descriptions, outer first', ui.ok && h5.ok && outer >= 0 && inner > outer,
    { ui: ui.ok || ui.error, dev5: h5.ok || h5.error, charters: dev5Prompt.match(/Standing charter from [^\n]*/g) ?? [] })

  // ------------------------------------------------------------ editing a description (point 7, user 2026-10-17 20:06Z)
  const edit = await opTry({ op: 'set_description', node: 'ui', description: 'The UI, rewritten.' })
  p.check('the user edits a project description with set_description', edit.ok && rig.one(`SELECT charter FROM ot.agents WHERE id = ${node('ui').id}`).charter === 'The UI, rewritten.',
    edit.ok ? edit.v : edit.error)
  const dev5After = rig.turns('dev5').filter(t => t.ended_at).length
  await rig.userMail('dev5', 'Hello again dev5.')
  await rig.waitTurns('dev5', dev5After + 1).catch(() => {})
  const dev5Again = identity('dev5')
  p.check('the agents under it get the new description', dev5Again.includes('Standing charter from project ui: The UI, rewritten.'),
    dev5Again.match(/Standing charter from [^\n]*/g) ?? [])
  const fromBelow = await rig.tool('dev5', 'orgtree_project', { action: 'describe', name: 'ui', description: 'From below.' })
  p.check('an agent under it edits it with orgtree_project describe', fromBelow.ok && rig.one(`SELECT charter FROM ot.agents WHERE id = ${node('ui').id}`).charter === 'From below.', said(fromBelow))
  const beside = await rig.tool('alice', 'orgtree_project', { action: 'describe', name: 'ui', description: 'Nope.' })
  p.check('an agent beside it cannot', !beside.ok, said(beside))
  const onAgent = await opTry({ op: 'set_description', node: 'dev5', description: 'x' })
  p.check('set_description refuses an agent', !onAgent.ok, onAgent.ok ? onAgent.v : onAgent.error)

  // ------------------------------------------------------------ hires around a project (point 19, user 2026-10-17 21:24:34Z)
  const scope0 = { add_dirs: [], tools: { bash: false, web: false, edit: false, subagents: false, mcp: [] }, org_visibility: 'team' }
  const bossFree2 = free('boss')
  const besideHire = await opTry({ op: 'hire', name: 'peer1', parent: 'boss', tier: 'haiku', grant: 0, after: 'review', ...scope0 })
  const sibs = rig.sql(`SELECT name FROM ot.agents WHERE parent_id = ${row('boss').id} AND state = 'live' ORDER BY sibling_order`).map(r => r.name)
  p.check('a coworker hired beside a project lands next to it', besideHire.ok && sibs.indexOf('peer1') === sibs.indexOf('review') + 1,
    besideHire.ok ? sibs : besideHire.error)
  const over = await opTry({ op: 'hire', name: 'lead1', tier: 'haiku', grant: 0, above: 'review', hire_type: 'superior' })
  const rev2 = node('review'), lead = node('lead1')
  p.check('a superior hired above a project holds it where it was', over.ok && lead?.parent_id === row('boss').id && rev2?.parent_id === lead?.id
    && node('carol')?.parent_id === rev2?.id, over.ok ? { lead, review: rev2 } : over.error)
  p.check('the project above carol stays free and transparent under its new superior', rev2?.seat === 0 && free('review') === 0,
    { seat: rev2?.seat, free: free('review') })
  p.check('boss pays the new agents\' seats and nothing for the project', Math.abs((bossFree2 - free('boss')) - (node('peer1').seat + node('lead1').seat)) < 1e-6,
    { before: bossFree2, after: free('boss'), seats: node('peer1').seat + node('lead1').seat })

  // ------------------------------------------------------------ a project's presentations and team presentations (point 27)
  // USER 2026-10-17 23:28Z: a project's PRESENTATIONS are the documents attributed
  // to the project itself; its TEAM presentations add every one by the agents in
  // its subtree (this replaces point 8's subtree-wide Presented gallery)
  const nested = await rig.tool('dev5', 'orgtree_present', { title: 'UI sketch', body: '# UI\n\nnested', })
  // boss sits ABOVE the project, not in its subtree: its own presentation stays out
  const unrelated = await rig.tool('boss', 'orgtree_present', { title: 'Boss notes', body: '# Boss' })
  const own = await rig.api('GET', `/api/orgs/${rig.org}/documents?node=site&limit=50`)
  const ownTitles = (own.documents ?? []).map(d => d.title)
  p.check('the project\'s presentations are only those attributed to the project',
    nested.ok && unrelated.ok && ownTitles.includes('Website plan') && !ownTitles.includes('UI sketch') && !ownTitles.includes('Boss notes')
    && own.total === ownTitles.length, { titles: ownTitles, total: own.total })
  const gallery = await rig.api('GET', `/api/orgs/${rig.org}/documents?node=site&team=1&limit=50`)
  const titles = (gallery.documents ?? []).map(d => d.title)
  p.check('the project\'s team presentations add a nested descendant\'s, not an unrelated agent\'s',
    titles.includes('Website plan') && titles.includes('UI sketch') && !titles.includes('Boss notes')
    && gallery.total === titles.length, { titles, total: gallery.total, nested: said(nested), unrelated: said(unrelated) })
  const paged = await rig.api('GET', `/api/orgs/${rig.org}/documents?node=site&team=1&limit=1`)
  p.check('it pages: one card, the full total, a next offset', (paged.documents ?? []).length === 1 && paged.total === gallery.total
    && paged.next_offset === 1, { n: (paged.documents ?? []).length, total: paged.total, next: paged.next_offset })
  // locate within the project's own list: the window grows to hold the card,
  // and its index counts the project's subtree, not the org
  const uiSketch = rig.sql(`SELECT uid FROM ot.documents WHERE title = 'UI sketch'`)[0]?.uid
  const oldest = (gallery.documents ?? []).at(-1)
  const located = await rig.api('GET', `/api/orgs/${rig.org}/documents?node=site&team=1&limit=1&locate=${oldest?.id}`)
  p.check('locate finds a card down the project\'s list and widens the window to it', !!oldest && gallery.total > 1 && located.located === oldest.id
    && (located.documents ?? []).length === gallery.total && (located.documents ?? []).at(-1)?.id === oldest?.id,
    { located: located.located, n: (located.documents ?? []).length, total: gallery.total })
  const newest = await rig.api('GET', `/api/orgs/${rig.org}/documents?node=site&team=1&limit=1&locate=${uiSketch}`)
  p.check('locate of the newest subtree card needs no wider window', newest.located === uiSketch
    && (newest.documents ?? []).length === 1 && newest.documents[0].id === uiSketch, { n: (newest.documents ?? []).length })
  const agentGallery = await rig.api('GET', `/api/orgs/${rig.org}/documents?node=dev5&limit=50`)
  p.check('an agent\'s gallery is still its own documents only', (agentGallery.documents ?? []).every(d => d.node === 'dev5')
    && (agentGallery.documents ?? []).some(d => d.title === 'UI sketch'), (agentGallery.documents ?? []).map(d => [d.node, d.title]))

  // ------------------------------------------------------------ team presentations (point 25, user 2026-10-17 22:47Z)
  // like the team docket: the agent's own presentations and everyone's under it, passing through projects
  const teamBoss = await rig.api('GET', `/api/orgs/${rig.org}/documents?node=boss&team=1&limit=50`)
  const teamTitles = (teamBoss.documents ?? []).map(d => d.title)
  const ownBoss = await rig.api('GET', `/api/orgs/${rig.org}/documents?node=boss&limit=50`)
  p.check('team=1 on an agent lists its own and its subtree\'s presentations, through projects',
    ['Boss notes', 'Website plan', 'UI sketch'].every(x => teamTitles.includes(x)) && teamBoss.total === teamTitles.length
    && !(ownBoss.documents ?? []).some(d => d.title === 'UI sketch'), { team: teamTitles, own: (ownBoss.documents ?? []).map(d => d.title) })
  const teamDev5 = await rig.api('GET', `/api/orgs/${rig.org}/documents?node=dev5&team=1&limit=50`)
  p.check('a leaf agent\'s team gallery is its own', (teamDev5.documents ?? []).length > 0
    && (teamDev5.documents ?? []).every(d => d.node === 'dev5'), (teamDev5.documents ?? []).map(d => [d.node, d.title]))
  // USER 22:47:51Z: every card links back to the agent that presented it
  const plan = (teamBoss.documents ?? []).find(d => d.title === 'Website plan')
  const sketch = (teamBoss.documents ?? []).find(d => d.title === 'UI sketch')
  p.check('each card names its presenting agent, even one presented under a project', plan?.presented_by === 'boss'
    && sketch?.presented_by === 'dev5' && plan?.presenter_tier && sketch?.presenter_tier, { plan, sketch })

  // ------------------------------------------------------------ the project docket (point 23)
  const nestedItem = await rig.tool('dev5', 'orgtree_work', { action: 'create', title: 'UI review', kind: 'non-code',
    objective: 'The UI needs a review. Do one.' })
  const outsideItem = await rig.tool('alice', 'orgtree_work', { action: 'create', title: 'Alice chores', kind: 'non-code',
    objective: 'Alice has chores. Do them.' })
  const page = await rig.api('GET', `/api/orgs/${rig.org}/work-items-page?agent=site`)
  // the page's items come as `rows` (orgtree.work-page/v1)
  const pageTitles = (page.rows ?? []).map(i => i.title)
  p.check('the project docket lists items owned under it, nested included, and nothing from outside',
    nestedItem.ok && outsideItem.ok && pageTitles.includes('Site launch checklist') && pageTitles.includes('UI review')
    && !pageTitles.includes('Alice chores'), { titles: pageTitles, nested: said(nestedItem), outside: said(outsideItem) })
  const agentPage = await rig.api('GET', `/api/orgs/${rig.org}/work-items-page?agent=dev1`)
  p.check('an agent\'s docket is unchanged: its own items only', (agentPage.rows ?? []).length > 0
    && (agentPage.rows ?? []).every(i => i.owner?.node === 'dev1')
    && (agentPage.rows ?? []).some(i => i.title === 'Site launch checklist'), (agentPage.rows ?? []).map(i => [i.owner?.node, i.title]))
  // migration 0029 on a row that still carries the old attachment: nothing is lost
  rig.exec(`UPDATE ot.work_items SET extra = extra || jsonb_build_object('project_id', ${web.id}) WHERE slug = '${slug}'`)
  const before0029 = rig.one(`SELECT title, owner, objective, done_so_far FROM ot.work_items WHERE slug = '${slug}'`)
  rig.exec(fs.readFileSync(path.resolve('engine/rs/orgtree-engine/migrations/0029_project_items_detach.sql'), 'utf8'))
  const after0029 = rig.one(`SELECT title, owner, objective, done_so_far, extra FROM ot.work_items WHERE slug = '${slug}'`)
  p.check('migration 0029 keeps the item whole and records the old project as former_project_id',
    after0029.extra.project_id === undefined && Number(after0029.extra.former_project_id) === web.id
    && JSON.stringify([after0029.title, after0029.owner, after0029.objective, after0029.done_so_far])
       === JSON.stringify([before0029.title, before0029.owner, before0029.objective, before0029.done_so_far]),
    { before: before0029, after: after0029 })

  // ------------------------------------------------------------ the project desk's message box
  // docket project-desk-message-box-broadcast-to-all-projec (user 2026-10-18
  // 07:33Z): one send from the project desk reaches every live agent under the
  // project, nested projects included, with its attachments and notice flag
  const attachFile = path.join(rig.dir, 'broadcast-note.txt')
  fs.writeFileSync(attachFile, 'broadcast attachment\n')
  const siteId = node('site').id
  const siteMail0 = mailTo(siteId).length
  const cast = await rig.api('POST', `/api/orgs/${rig.org}/nodes/site/broadcast`,
    { text: 'Broadcast to the site team.', attachments: [attachFile], notice: true }).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const castTo = (cast.v?.sent ?? []).map(s => s.to).sort()
  p.check('a broadcast from the project desk reaches every live agent under it, nested projects included', cast.ok
    && JSON.stringify(castTo) === JSON.stringify(['dev1', 'dev2', 'dev5']), cast.ok ? cast.v : cast.error)
  const castRows = rig.sql(`SELECT recipient_name, sender, notice, body, attachments FROM ot.mail WHERE body = 'Broadcast to the site team.' ORDER BY recipient_name`)
  p.check('each gets one mail from the user, as a notice, with the attachment', castRows.length === 3
    && castRows.every(m => m.sender === '@user' && m.notice === true && (m.attachments ?? []).length === 1
      && path.resolve(m.attachments[0].path) === path.resolve(attachFile)), castRows)
  p.check('the project itself gets no copy', mailTo(siteId).length === siteMail0, mailTo(siteId).length - siteMail0)
  const castAgent = await rig.api('POST', `/api/orgs/${rig.org}/nodes/dev1/broadcast`, { text: 'not a project' })
    .then(v => ({ ok: true, v }), e => ({ ok: false, status: e.status, error: e.message }))
  p.check('only a project broadcasts', !castAgent.ok && castAgent.status === 400, castAgent)

  // the message box's default send (user 2026-10-18 07:43Z-07:46Z): one mail to
  // the project's own mailbox; when nobody watches the project with a
  // fair_queue dog, its first live, unhalted direct member is woken and asked
  // to arm one, and with no live agent under it the send says nobody can
  // pick it up
  const dev5Before = mailTo(node('dev5').id).length
  const toUi = await rig.userMail('ui', 'Who takes the UI work?').then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const nudge = mailTo(node('dev5').id).slice(dev5Before)
  p.check('a user send to an unwatched project asks its first direct member to arm a fair_queue dog', toUi.ok
    && nudge.length === 1 && nudge[0].sender !== '@user' && nudge[0].notice === false
    && /fair_queue/.test(nudge[0].body) && /\bui\b/.test(nudge[0].body), { said: toUi.ok ? toUi.v : toUi.error, nudge })
  p.check('the send says so, and the mail itself waits in the project', toUi.ok && /dev5/.test(toUi.v.delivery ?? '')
    && rig.one(`SELECT state FROM ot.mail WHERE uid = '${toUi.v?.id}'`)?.state === 'pending', toUi.ok ? toUi.v : toUi.error)
  const empty = await opTry({ op: 'create_project', name: 'empty', parent: 'boss', description: 'Nobody here yet.' })
  const toEmpty = await rig.userMail('empty', 'Anyone?').then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  p.check('with no live agent under the project, the send says nobody can pick it up', empty.ok && toEmpty.ok
    && /nobody can pick it up/.test(toEmpty.v.delivery ?? ''), { empty: empty.ok || empty.error, said: toEmpty.ok ? toEmpty.v : toEmpty.error })
  // dev5 was woken: let its turn end before the rename below
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'dev5 nudge turn', timeout: 60000 }).catch(() => {})

  // ------------------------------------------------------------ a renamed agent keeps its presentations
  // docket docket-a-selected-archive-item-and-its-draft-sur: a document keeps
  // the node_name it was presented under, so an agent's own gallery reads by id
  const before = await rig.api('GET', `/api/orgs/${rig.org}/documents?node=dev5&limit=50`)
  const renamedAgent = await opTry({ op: 'rename', node: 'dev5', name: 'dev5-renamed' })
  const after = await rig.api('GET', `/api/orgs/${rig.org}/documents?node=dev5-renamed&limit=50`)
  const keptTitles = (after.documents ?? []).map(d => d.title)
  p.check('a renamed agent keeps its earlier presentations in its own gallery', renamedAgent.ok
    && (before.documents ?? []).length > 0 && keptTitles.includes('UI sketch') && after.total === (before.documents ?? []).length,
    { before: (before.documents ?? []).map(d => d.title), after: keptTitles, total: after.total, rename: renamedAgent.ok || renamedAgent.error })
  // the rows name the agent as it is called NOW: the gallery's own filter, its
  // focus link and its labels all read `node`
  p.check('a renamed agent\'s rows carry its current name', (after.documents ?? []).length > 0
    && (after.documents ?? []).every(d => d.node === 'dev5-renamed'), (after.documents ?? []).map(d => d.node))
  const sketchId = (after.documents ?? []).find(d => d.title === 'UI sketch')?.id
  const locatedRenamed = await rig.api('GET', `/api/orgs/${rig.org}/documents?node=dev5-renamed&limit=1&locate=${sketchId}`)
  p.check('locate finds it in the renamed agent\'s gallery', !!sketchId && locatedRenamed.located === sketchId
    && (locatedRenamed.documents ?? []).some(d => d.id === sketchId), { located: locatedRenamed.located })

  p.file('mail.json', rig.sql(`SELECT uid, sender, recipient_name, state, notice, extra FROM ot.mail ORDER BY id`))
  p.file('tree.json', rig.sql(`SELECT id, name, kind, parent_id, state, seat, grant_credits FROM ot.agents ORDER BY id`))
  p.keep(rig, { agents: ['dev1', 'dev2', 'boss'], grep: /project|fair_queue|dispatch/i })
  return p.summary()
}
