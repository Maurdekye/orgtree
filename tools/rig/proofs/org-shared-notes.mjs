// Proof: the org's shared folder and its AGENTS.md (docket
// shared-org-wide-agents-md-every-agent-in-the-org; user 2026-10-13 18:10Z,
// "Build it now" 18:12Z; coordinator rulings 18:19Z: session-start copy,
// <data>\scratch\<org>\_shared\AGENTS.md, read-write when the seat may write;
// docket org-wide-shared-scratch-folder-any-agent-reads-w, user 2026-10-14
// 13:25Z: the folder is the org's shared scratch space for any file).
//   a new org has its _shared folder as soon as it exists, before any launch.
//   nia (Claude): the folder holds no file until an agent writes one; her CLI
//     holds it read-write (--add-dir, no deny rule) and her prompt names it as
//     the org's shared scratch folder with its AGENTS.md, apart from her
//     granted folders. An edit of the
//     file (written here as an agent's write lands) never respawns her warm
//     CLI: same process, same prompt, and her forecast does not list it.
//     Once her CLI is stopped the forecast lists org_notes, and her next CLI
//     resumes the same session with the file's text in its prompt.
//   ned: hired after the edit, his first prompt carries the text.
//   rod: a read-only seat (edit off) holds the folder read-only (Edit and
//     Write denied) and still gets the text.
//   cody (Codex), musa (Muse), gus (Antigravity): the rule and the text reach
//     each lane's prompt; Muse gets the folder as a workspace root;
//     Antigravity gets no folder beyond its own, as for every granted folder.
//   zed (another org): holds his own org's _shared only and never sees this
//     org's text or path; a file watchdog on this org's notes is refused for
//     him and accepted for nia, who may also attach the file to mail.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/org-shared-notes.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

// paths compared as Windows does: a verbatim \\?\ prefix (Muse's roots) dropped
const norm = p => String(p ?? '').replace(/\//g, '\\').replace(/^\\\\\?\\/, '').replace(/\\+$/, '').toLowerCase()
const has = (text, part) => String(text ?? '').toLowerCase().includes(String(part).toLowerCase())
const read = f => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

export default async function (rig) {
  const p = new Proof('org-shared-notes')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const ORG = rig.org
  const other = (await rig.api('POST', '/api/orgs', { name: 'Other Org', dirs: [], net_autoconnect: false })).slug
  const freshDir = path.join(rig.data, 'scratch', other, '_shared')
  p.check('0 a new org has its empty _shared folder as soon as it exists, before any agent launches',
    fs.existsSync(freshDir) && fs.statSync(freshDir).isDirectory() && fs.readdirSync(freshDir).length === 0,
    { dir: freshDir, exists: fs.existsSync(freshDir) })
  const scratch = (org, name) => path.join(rig.data, 'scratch', org, name)
  const notesDir = org => path.join(rig.data, 'scratch', org, '_shared')
  const notesFile = org => path.join(notesDir(org), 'AGENTS.md')
  const FILE = notesFile(ORG)
  const rule = (orgName, org) => `ORG SHARED FOLDER: ${notesDir(org)} is ${orgName}'s shared scratch folder. `
  const fileRule = org => `Its AGENTS.md, ${notesFile(org)} (it exists once an agent writes it), is the org's shared notes`
  const copy = org => `[ORG SHARED NOTES - ${notesFile(org)}, your organization's shared AGENTS.md as it was when your CLI started.`
  const starts = name => rig.fakeLog(name).filter(l => l.kind === 'start')
  const turnsOf = (name, org) => rig.sql(`SELECT t.id, t.ended_at FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
      JOIN ot.orgs o ON o.id = a.org_id WHERE o.slug = '${org}' AND a.name = '${name}' ORDER BY t.id`)
  const turn = async (name, text, org = ORG) => {
    const done = turnsOf(name, org).filter(t => t.ended_at).length
    await rig.userMail(name, text, { org })
    await rig.waitFor(() => {
      const t = turnsOf(name, org)
      return t.filter(x => x.ended_at).length >= done + 1 && !t.some(x => !x.ended_at)
    }, { what: `${name} to finish a turn`, timeout: 90000 })
  }
  const prompt = (name, org = ORG) => read(path.join(scratch(org, name), '.orgtree-identity.md')) ?? ''
  const deny = (name, org = ORG) => { try { return JSON.parse(read(path.join(scratch(org, name), '.orgtree-settings.json'))).permissions?.deny ?? [] } catch { return [] } }
  const holds = (start, org) => (start?.add_dirs ?? []).some(d => norm(d) === norm(notesDir(org)))
  const folders = text => /Folders you may work in: (.*?)\. /.exec(text ?? '')?.[1] ?? null
  const forecast = async name => {
    const snap = await rig.api('GET', `/api/orgs/${ORG}/records`)
    return snap?.runtime?.agents?.[String(rig.agentRow(name)?.id)]?.cache_forecast ?? null
  }
  const brief = f => f && { readiness: f.readiness, cause: f.readiness_cause, changed: f.changed_inputs }
  const hire = (name, extra = {}, org = ORG) => rig.op({ op: 'hire', name, tier: 'haiku', title: 'shared notes proof', ...(org === ORG ? { parent: 'boss' } : {}), ...extra }, { org })

  // ------------------------------------------------- A: before the file exists
  await hire('nia')
  await turn('nia', 'PROOF-A: hello nia.')
  const a = starts('nia').at(-1)
  const promptA = prompt('nia')
  p.check('A nia: the org\'s _shared folder exists and holds no file (the engine never writes into it)',
    fs.existsSync(notesDir(ORG)) && fs.statSync(notesDir(ORG)).isDirectory() && fs.readdirSync(notesDir(ORG)).length === 0,
    { dir: notesDir(ORG), exists: fs.existsSync(notesDir(ORG)), entries: fs.existsSync(notesDir(ORG)) ? fs.readdirSync(notesDir(ORG)) : null })
  p.check('A nia: her CLI holds the folder (--add-dir) with no Edit/Write deny rule, read-write',
    holds(a, ORG) && !deny('nia').some(d => has(d, '_shared')), { add_dirs: a?.add_dirs, deny: deny('nia') })
  p.check('A nia: her prompt names the shared folder, its AGENTS.md and her right to write any file there, apart from her granted folders, and carries no copy while there is no file',
    has(promptA, rule('Rig Org', ORG)) && has(promptA, fileRule(ORG)) && promptA.includes('You may create, change and delete files and subfolders there with no grant')
      && !promptA.includes('[ORG SHARED NOTES -')
      && folders(promptA) !== null && !has(folders(promptA), '_shared'),
    { folders: folders(promptA), rule: has(promptA, rule('Rig Org', ORG)) })

  // ------------------------------------------------- B: an agent's edit
  const V1 = '# Rig Org shared notes\n\n- PROOF-NOTES-V1: times are UTC.\n'
  fs.mkdirSync(notesDir(ORG), { recursive: true })   // already there, unless the engine predates the feature
  fs.writeFileSync(FILE, V1)
  const before = starts('nia').length
  const pid = a?.pid
  await turn('nia', 'PROOF-B: hello again, after the edit.')
  const warm = await forecast('nia')
  p.check('B nia: an edit of the shared file does not respawn her warm CLI: same process, same prompt, and her forecast does not list it',
    starts('nia').length === before && alive(pid) && prompt('nia') === promptA && !(warm?.changed_inputs ?? []).includes('org_notes'),
    { starts: [before, starts('nia').length], pid, alive: alive(pid), same_prompt: prompt('nia') === promptA, forecast: brief(warm) })
  const sid = rig.agentRow('nia')?.session_id
  await rig.api('POST', `/api/orgs/${ORG}/nodes/nia/process`, { action: 'stop' })
  await rig.waitFor(() => !alive(pid), { what: 'nia\'s CLI to stop', timeout: 30000 }).catch(() => null)
  const cold = await rig.waitFor(async () => {
    const f = await forecast('nia')
    return (f?.changed_inputs ?? []).includes('org_notes') ? f : null
  }, { what: 'nia\'s forecast to list org_notes', timeout: 30000 }).catch(() => null)
  p.check('B nia: with no warm CLI left, her forecast lists org_notes as the changed input (not ready)',
    !!cold && cold.readiness === 'not_ready' && cold.readiness_cause === 'prefix_changed', { forecast: brief(cold ?? await forecast('nia')) })
  await turn('nia', 'PROOF-B2: hello on a new CLI.')
  const b = starts('nia').at(-1)
  const resumed = (() => { const args = b?.args ?? []; const i = args.indexOf('--resume'); return i >= 0 ? args[i + 1] : null })()
  p.check('B nia: her next CLI resumes the same session and starts with the file\'s text',
    starts('nia').length === before + 1 && resumed === sid && prompt('nia').includes(copy(ORG)) && prompt('nia').includes('PROOF-NOTES-V1'),
    { starts: starts('nia').length, resumed, session: sid, copy: prompt('nia').includes(copy(ORG)) })

  // ------------------------------------------------- C: a new hire and a read-only seat
  await hire('ned')
  await turn('ned', 'PROOF-C: hello ned.')
  p.check('C ned: hired after the edit, his first CLI holds the folder and his prompt carries the text',
    holds(starts('ned').at(-1), ORG) && prompt('ned').includes(copy(ORG)) && prompt('ned').includes('PROOF-NOTES-V1') && has(prompt('ned'), rule('Rig Org', ORG)),
    { add_dirs: starts('ned').at(-1)?.add_dirs })
  await hire('rod', { tools: { edit: false } })
  await turn('rod', 'PROOF-C: hello rod.')
  const fwd = notesDir(ORG).replace(/\\/g, '/').replace(/^\/+/, '')
  const rodDeny = deny('rod')
  p.check('C rod: a read-only seat holds the folder read-only (Edit and Write denied there) and still gets the text',
    holds(starts('rod').at(-1), ORG) && rodDeny.some(d => norm(d) === norm(`Edit(//${fwd}/**)`)) && rodDeny.some(d => norm(d) === norm(`Write(//${fwd}/**)`))
      && prompt('rod').includes('Your scope lets you read it, not write there.') && prompt('rod').includes('PROOF-NOTES-V1'),
    { deny: rodDeny })

  // ------------------------------------------------- D: the other lanes
  await hire('cody', { tier: 'luna' })
  await turn('cody', 'PROOF-D: hello cody.')
  const dev = rig.fakeLog('cody').filter(l => l.kind === 'recv' && l.line?.method === 'thread/start').at(-1)?.line?.params?.developerInstructions ?? ''
  p.check('D cody (Codex): the rule and the text reach the app-server\'s developer instructions',
    has(dev, rule('Rig Org', ORG)) && dev.includes(copy(ORG)) && dev.includes('PROOF-NOTES-V1'), { length: dev.length })
  await hire('musa', { tier: 'wonder' })
  await turn('musa', 'PROOF-D: hello musa.')
  const museRoots = rig.fakeLog('musa').filter(l => l.kind === 'session' && l.action === 'start').at(-1)?.roots ?? []
  const musePrompt = read(path.join(scratch(ORG, 'musa'), '.orgtree-muse-identity.md')) ?? ''
  p.check('D musa (Muse): the folder is a workspace root of her session, and the rule and the text reach her developer prompt',
    museRoots.some(r => norm(r) === norm(notesDir(ORG))) && has(musePrompt, rule('Rig Org', ORG)) && musePrompt.includes('PROOF-NOTES-V1'),
    { roots: museRoots, prompt_file: musePrompt.length })
  await hire('gus', { tier: 'flash' })
  await turn('gus', 'PROOF-D: hello gus.')
  const agyPrompt = read(path.join(scratch(ORG, 'gus'), 'AGENTS.md')) ?? ''
  const agyDirs = (() => { const args = starts('gus').at(-1)?.args ?? []; return args.flatMap((x, i) => x === '--add-dir' ? [args[i + 1]] : []) })()
  p.check('D gus (Antigravity): the rule and the text reach his prompt (AGENTS.md); like every granted folder, the shared one is not added to his workspace',
    has(agyPrompt, rule('Rig Org', ORG)) && agyPrompt.includes('PROOF-NOTES-V1') && agyDirs.length === 1 && norm(agyDirs[0]) === norm(scratch(ORG, 'gus')),
    { add_dirs: agyDirs })

  // ------------------------------------------------- E: another org
  fs.mkdirSync(notesDir(other), { recursive: true })
  fs.writeFileSync(notesFile(other), '# Other Org notes\n\n- OTHER-NOTES-V1\n')
  await hire('zed', { grant: 1 }, other)
  await turn('zed', 'PROOF-E: hello zed.', other)
  const z = rig.fakeLog('zed').filter(l => l.kind === 'start').at(-1)
  const zp = prompt('zed', other)
  p.check('E zed (another org): he holds his own org\'s _shared only, gets its text, and never this org\'s text or path',
    holds(z, other) && !holds(z, ORG) && zp.includes('OTHER-NOTES-V1') && has(zp, rule('Other Org', other))
      && !zp.includes('PROOF-NOTES-V1') && !has(zp, notesDir(ORG)) && !has(JSON.stringify(z?.args ?? []), notesDir(ORG)),
    { add_dirs: z?.add_dirs })
  p.check('E: no agent of this org got the other org\'s text', ['nia', 'ned', 'rod'].every(n => !prompt(n).includes('OTHER-NOTES-V1')) && !dev.includes('OTHER-NOTES-V1'))

  // ------------------------------------------------- F: the folder for the agent's own tools
  const zedDog = await rig.tool('zed', 'orgtree_watchdog', { action: 'create', name: 'notes-watch', kind: 'file', target: FILE, interval_s: 15 }, { org: other })
  const niaDog = await rig.tool('nia', 'orgtree_watchdog', { action: 'create', name: 'notes-watch', kind: 'file', target: FILE, interval_s: 15 })
  p.check('F: a file watchdog on this org\'s shared notes is accepted for nia and refused for zed (another org)', niaDog.ok && !zedDog.ok,
    { nia: niaDog.text?.slice(0, 200), zed: zedDog.text?.slice(0, 200) })
  if (niaDog.ok) await rig.tool('nia', 'orgtree_watchdog', { action: 'remove', id: 'notes-watch' })
  // attachments ride mail to the user (a top-level agent writes to them)
  const att = await rig.tool('boss', 'orgtree_message', { to: 'user', body: 'The shared notes, attached.', attachments: [FILE] })
  p.check('F: boss may attach the shared notes file to his mail to the user', att.ok, { text: att.text?.slice(0, 200) })

  p.note('the file\'s final state', { file: FILE, text: read(FILE) })
  p.keep(rig, { agents: ['nia', 'ned', 'rod', 'cody', 'musa', 'gus', 'zed'] })
  for (const [org, name, file] of [[ORG, 'nia', '.orgtree-identity.md'], [ORG, 'rod', '.orgtree-identity.md'], [ORG, 'rod', '.orgtree-settings.json'],
    [ORG, 'musa', '.orgtree-muse-identity.md'], [ORG, 'gus', 'AGENTS.md'], [other, 'zed', '.orgtree-identity.md']]) {
    const text = read(path.join(scratch(org, name), file))
    if (text !== null) p.file(`${name}-${file.replace(/^\./, '')}`, text)
  }
  return p.summary()
}
