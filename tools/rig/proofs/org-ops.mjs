// Proof: the user's organization-wide operations.
//   Stop All (killswitch): a running turn is interrupted, armed watchdogs are
//   paused with 3.x's reason, and nothing starts a turn while it is latched;
//   release lifts only the latch (dogs stay paused, nothing is woken by
//   it), and the next mail drives the agent again.
//   Delete: the org leaves the list and its routes answer 404; a running
//   turn stops; its folders go to the trash with it (3.x §2.13), so a new
//   org given the same name starts clean. A folder something else holds
//   open stays, reported, and a new org of the name is refused until it is
//   let go; then it is swept into the trash first. Folders an earlier
//   delete left behind (no org holds the name) are swept the same way.
//   Dissolve all: every agent is archived and the credits are freed.
//   Create keeps 3.x's name rules: a name an org holds is refused (no
//   silent -2), as is one with no letter or digit; the slug has no length
//   cap; a name the file system refuses is refused with nothing created.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/org-ops.mjs

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

// the engine's restart path runs at every start (for the restart after the delete)
export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('org-ops')
  rig.scenario({
    agents: { kit: { turns: [
      { name: 'long', match: 'PROOF-STOPALL', once: true, steps: [{ text: 'Working.' }, { sleep_ms: 120000 }] },
      { name: 'long2', match: 'PROOF-DELETE', once: true, steps: [{ text: 'Working again.' }, { sleep_ms: 120000 }] },
    ] } },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const NAME = 'Rig Ops Org'
  const make = name => rig.api('POST', '/api/orgs', { name, dirs: [], net_autoconnect: false })
  const X = (await make(NAME)).slug
  const orgId = slug => rig.one(`SELECT id FROM ot.orgs WHERE slug = '${slug}' AND state = 'active'`)?.id
  const xid = orgId(X)
  const turns = name => rig.sql(`SELECT t.id, t.ended_at, t.killed FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
    WHERE a.org_id = ${xid} AND a.name = '${name}' ORDER BY t.id`)
  const sleeps = () => rig.fakeLog('kit').filter(l => l.kind === 'step' && l.step?.sleep_ms).length
  const tryApi = (method, route, body) => rig.api(method, route, body).then(json => ({ ok: true, json }),
    e => ({ ok: false, status: e.status, detail: String(e.body?.detail ?? e.message).slice(0, 300) }))
  const listed = async slug => JSON.stringify(await rig.api('GET', '/api/orgs')).includes(`"${slug}"`)
  await rig.op({ op: 'hire', name: 'kit', tier: 'haiku', title: 'X lead', grant: 6 }, { org: X })
  await rig.op({ op: 'hire', name: 'ivy', parent: 'kit', tier: 'haiku', title: 'X member', grant: 1 }, { org: X })
  const scratchX = path.join(rig.data, 'scratch', X, 'kit')
  fs.mkdirSync(scratchX, { recursive: true })
  fs.writeFileSync(path.join(scratchX, 'notes.txt'), 'X kit private notes\n')
  await rig.api('PUT', `/api/orgs/${X}/orgmd`, { content: 'X org charter: private to X.' })
  const dog = await rig.tool('kit', 'orgtree_watchdog', { action: 'create', name: 'notes-dog', kind: 'file', target: 'notes.txt', pattern: 'ALERT', interval_s: 15 }, { org: X })

  // ---------------------------------------------------------------- Stop All
  await rig.userMail('kit', 'PROOF-STOPALL: work for a while.', { org: X })
  await rig.waitFor(() => sleeps() >= 1, { what: 'kit to be mid-turn', timeout: 30000 })
  const ks = await tryApi('POST', `/api/orgs/${X}/killswitch`)
  const dogRow = rig.one(`SELECT state, memo FROM ot.watchdogs WHERE org_id = ${xid} AND name = 'notes-dog'`)
  const kt = await rig.waitFor(() => { const t = turns('kit'); return t.length && t.every(x => x.ended_at) ? t : null }, { what: 'kit\'s turn to stop', timeout: 30000 }).catch(() => turns('kit'))
  p.check('Stop All interrupts the running turn and pauses the armed watchdog with 3.x\'s reason', dog.ok && ks.ok
    && (ks.json?.interrupted ?? []).includes('kit') && kt.every(x => x.ended_at) && dogRow?.state === 'paused' && /STOP ALL/.test(JSON.stringify(dogRow?.memo ?? {})),
  { ks: ks.json ?? ks.detail, dog: dogRow })
  const before = turns('kit').length
  await rig.userMail('kit', 'While stopped.', { org: X })
  await new Promise(r => setTimeout(r, 5000))
  p.check('while latched, mail starts no turn', turns('kit').length === before, { turns: turns('kit').length, before })
  const rel = await tryApi('POST', `/api/orgs/${X}/killswitch/release`)
  await new Promise(r => setTimeout(r, 4000))
  const dog2 = rig.one(`SELECT state FROM ot.watchdogs WHERE org_id = ${xid} AND name = 'notes-dog'`)
  p.check('release lifts only the latch: the dog stays paused and the release itself wakes no one', rel.ok && rel.json?.released === true
    && dog2?.state === 'paused' && turns('kit').length === before, { rel: rel.json, dog: dog2, turns: turns('kit').length })
  await rig.userMail('kit', 'Back to work.', { org: X })
  const after = await rig.waitFor(() => turns('kit').length > before && turns('kit').every(x => x.ended_at) ? turns('kit') : null, { what: 'kit to run again', timeout: 60000 }).catch(() => null)
  p.check('the next mail drives kit again', !!after, { turns: turns('kit').length })

  // ---------------------------------------------------------------- Delete mid-turn, with the workspace held open
  await rig.userMail('kit', 'PROOF-DELETE: one more long job.', { org: X })
  await rig.waitFor(() => sleeps() >= 2, { what: 'kit to be mid-turn again', timeout: 60000 })
  const wsX = path.join(rig.data, 'workspaces', X)
  // something outside Orgtree has the workspace open (a terminal, say): it holds the folder
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { cwd: wsX, stdio: 'ignore' })
  let del, trash = ''
  try {
    await new Promise(r => setTimeout(r, 1000))
    del = await tryApi('DELETE', `/api/orgs/${X}`)
    const gone = await tryApi('GET', `/api/orgs/${X}`)
    const inList = await listed(X)
    p.check('delete: the org leaves the list and its routes answer 404', del.ok && !inList && !gone.ok && gone.status === 404,
      { del: del.json ?? del.detail, listed: inList, gone: gone.status })
    trash = del.json?.trash ?? ''
    // the turn's CLI is gone (it ran in kit's folder, which cannot move while it does)
    const pid = rig.fakeLog('kit').filter(l => l.kind === 'step' && l.step?.sleep_ms).at(-1)?.pid
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    const cliGone = await rig.waitFor(() => !alive() || null, { what: 'kit\'s CLI to exit', timeout: 15000 }).catch(() => false)
    p.check('delete stops the running turn and takes the org\'s folders to the trash (3.x)', !!pid && !!cliGone && !!trash
      && !fs.existsSync(scratchX) && fs.existsSync(path.join(trash, 'scratch', 'kit', 'notes.txt')),
    { trash, scratchLeft: fs.existsSync(scratchX), pid, cliGone: !!cliGone })
    const kept = del.json?.folders_kept ?? []
    p.check('the folder held open stays where it is, and the delete says so', kept.length === 1 && kept[0].folder === wsX
      && fs.existsSync(path.join(wsX, 'org.md')), { kept })
    const early = await tryApi('POST', '/api/orgs', { name: NAME, dirs: [], net_autoconnect: false })
    const madeEarly = await listed(X)
    p.check('a new org of the same name is refused while the old folder is still held, and nothing is created', !early.ok
      && early.status === 409 && /still in use/.test(early.detail) && !madeEarly, { early: early.json ?? `${early.status} ${early.detail}`, listed: madeEarly })
  } finally {
    holder.kill()
    await new Promise(r => (holder.exitCode !== null || holder.signalCode !== null) ? r() : holder.once('exit', r))
  }
  await new Promise(r => setTimeout(r, 500))
  const Y = (await make(NAME)).slug
  await rig.op({ op: 'hire', name: 'kit', tier: 'haiku', title: 'Y lead', grant: 2 }, { org: Y })
  const orgmdY = JSON.stringify(await rig.api('GET', `/api/orgs/${Y}/orgmd`))
  const notesY = fs.existsSync(path.join(rig.data, 'scratch', Y, 'kit', 'notes.txt'))
  p.check('once let go, a new org of the name starts clean (its kit finds no old notes, no old org.md), the old workspace swept into the trash',
    Y === X && !notesY && !orgmdY.includes('private to X') && fs.existsSync(path.join(trash, 'workspace', 'org.md')),
  { X, Y, oldNotesThere: notesY, orgmd: orgmdY.slice(0, 120), sweptWorkspace: fs.existsSync(path.join(trash, 'workspace', 'org.md')) })

  // ---------------------------------------------------------------- Folders an earlier delete left behind
  const LEFT = 'Rig Left Org', leftSlug = 'rig-left-org'
  fs.mkdirSync(path.join(rig.data, 'scratch', leftSlug, 'kit'), { recursive: true })
  fs.writeFileSync(path.join(rig.data, 'scratch', leftSlug, 'kit', 'CLAUDE.md'), 'standing notes of a deleted org\'s kit\n')
  fs.mkdirSync(path.join(rig.data, 'workspaces', leftSlug), { recursive: true })
  fs.writeFileSync(path.join(rig.data, 'workspaces', leftSlug, 'org.md'), 'a deleted org\'s charter\n')
  const L = (await make(LEFT)).slug
  const orgmdL = JSON.stringify(await rig.api('GET', `/api/orgs/${L}/orgmd`))
  const trashed = fs.existsSync(path.join(rig.data, 'deleted')) ? fs.readdirSync(path.join(rig.data, 'deleted')).filter(d => d.startsWith(`${leftSlug}-`)) : []
  p.check('a new org whose name has an earlier delete\'s folders left behind starts clean; they go to the trash', L === leftSlug
    && !fs.existsSync(path.join(rig.data, 'scratch', L, 'kit', 'CLAUDE.md')) && !orgmdL.includes('deleted org')
    && trashed.some(d => fs.existsSync(path.join(rig.data, 'deleted', d, 'scratch', 'kit', 'CLAUDE.md'))), { L, trashed, orgmd: orgmdL.slice(0, 120) })

  // ---------------------------------------------------------------- Dissolve all
  await rig.op({ op: 'hire', name: 'amy', parent: 'kit', tier: 'haiku', title: 'Y member', grant: 1 }, { org: Y })
  const da = await tryApi('POST', `/api/orgs/${Y}/dissolve-all`)
  const live = rig.sql(`SELECT name FROM ot.agents WHERE org_id = ${orgId(Y)} AND state = 'live'`)
  p.check('dissolve all archives every agent and reports what it freed', da.ok && live.length === 0 && da.json?.nodes === 2 && da.json?.freed > 0,
    { da: da.json ?? da.detail, live })

  // ---------------------------------------------------------------- Create: 3.x's name rules
  const dup = await tryApi('POST', '/api/orgs', { name: NAME, dirs: [], net_autoconnect: false })
  p.check('a name an org already holds is refused, as in 3.x (no silent "-2")', !dup.ok && dup.status === 400
    && dup.detail === `org '${Y}' already exists`, { dup: dup.json ?? `${dup.status} ${dup.detail}` })
  const bare = await tryApi('POST', '/api/orgs', { name: '!!!', dirs: [], net_autoconnect: false })
  p.check('a name with no letter or digit is refused (3.x §4.7)', !bare.ok && bare.status === 400 && /letters or digits/.test(bare.detail),
    { bare: bare.json ?? `${bare.status} ${bare.detail}` })
  const long = await tryApi('POST', '/api/orgs', { name: 'Rig Organization With A Rather Long Name For The Slug Rule', dirs: [], net_autoconnect: false })
  p.check('the slug keeps the whole name (3.x has no 40-character cap)', long.ok && long.json?.slug === 'rig-organization-with-a-rather-long-name-for-the-slug-rule',
    { long: long.json ?? `${long.status} ${long.detail}` })
  // the file system refuses the new org's folder: the workspaces folder is a file for a moment
  const wsRoot = path.join(rig.data, 'workspaces')
  fs.renameSync(wsRoot, `${wsRoot}.off`)
  fs.writeFileSync(wsRoot, 'not a folder')
  let blocked
  try {
    blocked = await tryApi('POST', '/api/orgs', { name: 'Rig Blocked Org', dirs: [], net_autoconnect: false })
  } finally {
    fs.rmSync(wsRoot)
    fs.renameSync(`${wsRoot}.off`, wsRoot)
  }
  const blockedListed = await listed('rig-blocked-org')
  p.check('a name the file system refuses is refused (422) and nothing is created, as in 3.x', !blocked.ok && blocked.status === 422
    && /could not create the org's workspace/.test(blocked.detail) && !blockedListed, { blocked: blocked.json ?? `${blocked.status} ${blocked.detail}`, listed: blockedListed })

  // ---------------------------------------------------------------- A restart after the delete
  // (X was deleted while kit was mid-turn: an install or restart comes next)
  const xMail = () => rig.one(`SELECT count(*)::int AS n FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id WHERE a.org_id = ${xid}`).n
  const mail0 = xMail(), turns0 = turns('kit').length, open0 = turns('kit').filter(t => !t.ended_at).length
  await rig.restart()
  await new Promise(r => setTimeout(r, 8000))
  const xTurns = turns('kit'), open1 = xTurns.filter(t => !t.ended_at).length
  // the restart path ran (it closes the turn the delete stopped), and nothing else touched X
  p.check('a restart leaves the deleted org alone: no turn starts and no restart mail is written for its agents', open0 === 1 && open1 === 0
    && xTurns.length === turns0 && xMail() === mail0, { open: `${open0} -> ${open1}`, turns: `${turns0} -> ${xTurns.length}`, mail: `${mail0} -> ${xMail()}` })

  p.keep(rig, { agents: ['kit'], grep: /killswitch|trash|org_created|dissolve|could not be moved/i })
  return p.summary()
}
