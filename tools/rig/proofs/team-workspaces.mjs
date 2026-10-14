// Proof: team workspaces (docket team-workspaces-a-shared-folder-per-subtree-visi;
// user 2026-10-14 13:28Z: "full upward workspace access, not just your own
// teams"). Each subtree's workspace is <data>\scratch\<org>\_teams\<root id>.
//   boss (seed, top level) > lead > ivy, oak; boss > kim.
//   lead: holds his own team's (he has reports) and boss's, nearest first,
//     read-write, apart from his granted folders; the launch made them.
//   ivy: holds her own (no reports: every agent has one, user 13:55Z),
//     lead's and boss's; her prompt carries lead's and boss's AGENTS.md,
//     nearest first, labelled, after the rules (user 13:55Z); kim gets
//     boss's notes, never lead's.
//   kim: holds boss's, never lead's.
//   rod (edit off, under lead): holds lead's and boss's read-only.
//   move: ivy moved under kim holds kim's and boss's from her next CLI,
//     never lead's again.
//   zed (another org): holds none of this org's.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/team-workspaces.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const norm = p => String(p ?? '').replace(/\//g, '\\').replace(/^\\\\\?\\/, '').replace(/\\+$/, '').toLowerCase()
const read = f => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }

export default async function (rig) {
  const p = new Proof('team-workspaces')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const ORG = rig.org
  const other = (await rig.api('POST', '/api/orgs', { name: 'Other Org', dirs: [], net_autoconnect: false })).slug
  const team = name => path.join(rig.data, 'scratch', ORG, '_teams', String(rig.agentRow(name)?.id))
  const starts = name => rig.fakeLog(name).filter(l => l.kind === 'start')
  const dirsOf = name => (starts(name).at(-1)?.add_dirs ?? []).map(norm)
  const holds = (name, owner) => dirsOf(name).includes(norm(team(owner)))
  const prompt = name => read(path.join(rig.data, 'scratch', ORG, name, '.orgtree-identity.md')) ?? ''
  const deny = name => { try { return JSON.parse(read(path.join(rig.data, 'scratch', ORG, name, '.orgtree-settings.json'))).permissions?.deny ?? [] } catch { return [] } }
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
  const hire = (name, parent, extra = {}, org = ORG) => rig.op({ op: 'hire', name, tier: 'haiku', title: 'team proof', ...(parent ? { parent } : {}), ...extra }, { org })

  await hire('lead', 'boss')
  await hire('ivy', 'lead')
  await hire('oak', 'lead')
  await hire('kim', 'boss')
  await hire('rod', 'lead', { tools: { edit: false } })
  for (const n of ['lead', 'boss']) fs.mkdirSync(team(n), { recursive: true })
  fs.writeFileSync(path.join(team('lead'), 'AGENTS.md'), '- TEAM-LEAD-NOTES-V1\n')
  fs.writeFileSync(path.join(team('boss'), 'AGENTS.md'), '- TEAM-BOSS-NOTES-V1\n')
  for (const n of ['lead', 'ivy', 'kim', 'rod']) await turn(n, `PROOF-TEAM: hello ${n}.`)

  const leadPrompt = prompt('lead')
  const listed = /TEAM WORKSPACES: shared folders of the subtrees you are in, nearest first: (.*?)\. Every agent/.exec(leadPrompt)?.[1] ?? ''
  p.check('lead: holds his own team\'s and boss\'s workspace, listed nearest first apart from his granted folders',
    holds('lead', 'lead') && holds('lead', 'boss') && norm(listed).indexOf(norm(team('lead'))) === 0
      && norm(listed).indexOf(norm(team('boss'))) > 0 && !norm(/Folders you may work in: (.*?)\. /.exec(leadPrompt)?.[1]).includes('_teams'),
    { add_dirs: dirsOf('lead'), listed })
  p.check('lead: the launch created both folders', fs.existsSync(team('lead')) && fs.existsSync(team('boss')))
  p.check('ivy (no reports): holds her own, lead\'s and boss\'s (every ancestor subtree), read-write',
    holds('ivy', 'ivy') && holds('ivy', 'lead') && holds('ivy', 'boss') && !deny('ivy').some(d => norm(d).includes('_teams')),
    { add_dirs: dirsOf('ivy') })
  const ivy = prompt('ivy')
  const at = tag => ivy.indexOf(tag)
  p.check('ivy: her prompt carries lead\'s then boss\'s team notes, labelled, after the rules',
    at(`[TEAM NOTES - ${path.join(team('lead'), 'AGENTS.md')}, the shared AGENTS.md of lead's team`) > 0 && at('TEAM-LEAD-NOTES-V1') > 0
      && at('TEAM-BOSS-NOTES-V1') > at('TEAM-LEAD-NOTES-V1') && at('[END TEAM NOTES]') > at('TEAM-LEAD-NOTES-V1')
      && at('TEAM-LEAD-NOTES-V1') > at('TEAM WORKSPACES:'),
    { lead: at('TEAM-LEAD-NOTES-V1'), boss: at('TEAM-BOSS-NOTES-V1') })
  p.check('kim: gets boss\'s team notes, never lead\'s', prompt('kim').includes('TEAM-BOSS-NOTES-V1') && !prompt('kim').includes('TEAM-LEAD-NOTES-V1'))
  p.check('kim: holds boss\'s, never lead\'s', holds('kim', 'boss') && !holds('kim', 'lead'), { add_dirs: dirsOf('kim') })
  const fwd = team('lead').replace(/\\/g, '/').replace(/^\/+/, '')
  p.check('rod (edit off): holds lead\'s and boss\'s read-only (Edit and Write denied there)',
    holds('rod', 'lead') && holds('rod', 'boss') && deny('rod').some(d => norm(d) === norm(`Edit(//${fwd}/**)`))
      && prompt('rod').includes('Your scope lets you read them, not write there.'), { deny: deny('rod') })

  await rig.op({ op: 'move', node: 'ivy', new_parent: 'kim' })
  await rig.api('POST', `/api/orgs/${ORG}/nodes/ivy/process`, { action: 'stop' })
  await turn('ivy', 'PROOF-TEAM: after the move.')
  p.check('move: ivy under kim holds kim\'s and boss\'s from her next CLI, never lead\'s',
    holds('ivy', 'kim') && holds('ivy', 'boss') && !holds('ivy', 'lead'), { add_dirs: dirsOf('ivy') })

  await hire('zed', null, {}, other)
  await turn('zed', 'PROOF-TEAM: hello zed.', other)
  const zedDirs = (starts('zed').at(-1)?.add_dirs ?? []).map(norm)
  p.check('zed (another org): holds none of this org\'s workspaces',
    !zedDirs.some(d => d.includes(norm(path.join(rig.data, 'scratch', ORG, '_teams')))), { add_dirs: zedDirs })
  return p.summary()
}
