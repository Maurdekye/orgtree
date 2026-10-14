// Proof: agents edit the org's shared AGENTS.md with the INSTALLED Claude Code
// (`--real-cli`, a language-server seat answered by tools/rig/fakellm.mjs: no
// model, no account), on the default acceptEdits seat, so its own permission
// check decides every write (docket shared-org-wide-agents-md-every-agent-in-the-org).
//   wren (org A): his CLI's Write creates A's _shared\AGENTS.md, and any
//     other file in a new subfolder there (docket
//     org-wide-shared-scratch-folder-any-agent-reads-w); a Write of org B's
//     (absent) _shared\AGENTS.md is refused, so only the grant decides.
//     Team workspaces (docket team-workspaces-a-shared-folder-per-subtree-visi):
//     his Write creates a file in lead's team workspace (_teams\<lead id>);
//     a Write into his sibling zoe's own workspace is refused.
//   yara (org A, hired after): her first request carries wren's text.
//   xan (org B): his first request carries B's notes, never A's.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/org-shared-notes-real.mjs

import fs from 'node:fs'
import path from 'node:path'

import { startFakeLlm } from '../fakellm.mjs'
import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'

export async function setup() { return { name: 'org-shared-notes-real', 'real-cli': true, fixture: 'none' } }

const read = f => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }

export default async function (rig) {
  const p = new Proof('org-shared-notes-real')
  const other = { slug: null }
  const notes = slug => path.join(rig.data, 'scratch', slug, '_shared', 'AGENTS.md')
  // the paths are known once the orgs exist; the server reads these rules at each request
  const handoff = slug => path.join(rig.data, 'scratch', slug, '_shared', 'handoff', 'wren-report.txt')
  const rules = [{ match: ['PROOF-WRITE-OWN'], tool: 'Write', input: {} }, { match: ['PROOF-WRITE-OTHER'], tool: 'Write', input: {} },
    { match: ['PROOF-WRITE-FILE'], tool: 'Write', input: {} },
    { match: ['PROOF-WRITE-TEAM'], tool: 'Write', input: {} }, { match: ['PROOF-WRITE-SIBLING'], tool: 'Write', input: {} }]
  const teamFile = (slug, name, file) => path.join(rig.data, 'scratch', slug, '_teams', String(rig.agentRow(name)?.id), file)
  const llm = await startFakeLlm({ bodies: path.join(p.dir, 'bodies'), models: [{ name: 'fake-model:latest', context: 131072, running: 65536 }], rules })
  try {
    const server = await rig.api('POST', '/api/langservers', { preset: 'llamacpp', address: llm.url, harness: 'claude-code', label: 'Notes proof',
      models: [{ id: 'fake-model:latest', context: 65536 }] })
    const tier = Object.values(server.server.models)[0].tier
    await seed(rig, { org: { name: 'Notes Proof' }, agents: [{ name: 'lead', tier, grant: 20, charter: 'You lead a scratch proof.' }] })
    other.slug = (await rig.api('POST', '/api/orgs', { name: 'Other Proof', dirs: [], net_autoconnect: false })).slug
    rules[0].input = { file_path: notes(rig.org), content: '# Notes Proof shared notes\n\n- WREN-WROTE-THIS\n' }
    rules[1].input = { file_path: notes(other.slug), content: 'WREN-CROSS-ORG\n' }
    rules[2].input = { file_path: handoff(rig.org), content: 'WREN-HANDOFF\n' }
    const turnsDone = (name, org) => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id JOIN ot.orgs o ON o.id = a.org_id
        WHERE o.slug = '${org}' AND a.name = '${name}' AND t.ended_at IS NOT NULL`).length
    const settle = (name, org) => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id JOIN ot.orgs o ON o.id = a.org_id
        WHERE o.slug = '${org}' AND a.name = '${name}' AND t.ended_at IS NULL`).length === 0, { what: `${name} to settle`, timeout: 120000 })
    const turn = async (name, token, org = rig.org) => {
      const done = turnsDone(name, org)
      await rig.userMail(name, `${token}: please.`, { org })
      await rig.waitFor(() => turnsDone(name, org) > done, { what: `${name}'s ${token} turn`, timeout: 120000 })
      await settle(name, org)
    }
    const body = r => read(path.join(p.dir, 'bodies', r.body_file)) ?? ''
    // the request after a tool call carries its result
    const resultOf = () => {
      const after = llm.requests.filter(r => r.body_file).at(-1)
      const raw = body(after)
      try {
        const msgs = JSON.parse(raw).messages ?? []
        const parts = msgs.at(-1)?.content ?? []
        return (Array.isArray(parts) ? parts : []).filter(c => c.type === 'tool_result').map(c => typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).join('\n')
      } catch { return '' }
    }

    await rig.op({ op: 'hire', name: 'wren', parent: 'lead', tier, grant: 0, title: 'writer' })
    await turn('wren', 'PROOF-WRITE-OWN')
    const own = resultOf()
    p.check('wren: the installed Claude Code\'s Write created his org\'s shared AGENTS.md on an acceptEdits seat',
      (read(notes(rig.org)) ?? '').includes('WREN-WROTE-THIS'), { file: notes(rig.org), text: read(notes(rig.org)), tool_result: own.slice(0, 300) })
    const first = llm.requests.find(r => r.body_file && r.last_user?.includes('PROOF-WRITE-OWN'))
    p.check('wren: his request named the shared folder and its AGENTS.md as his to write', first
      && body(first).includes(`ORG SHARED FOLDER: ${path.dirname(notes(rig.org)).replace(/\\/g, '\\\\')} is `)
      && body(first).includes(`Its AGENTS.md, ${notes(rig.org).replace(/\\/g, '\\\\')} `)
      && body(first).includes('You may create, change and delete files and subfolders there with no grant'),
      { body: first?.body_file })

    await turn('wren', 'PROOF-WRITE-FILE')
    const file = resultOf()
    p.check('wren: the same Write created another file, in a new subfolder of the shared folder',
      (read(handoff(rig.org)) ?? '').includes('WREN-HANDOFF'), { file: handoff(rig.org), tool_result: file.slice(0, 300) })

    fs.mkdirSync(path.dirname(notes(other.slug)), { recursive: true })
    await turn('wren', 'PROOF-WRITE-OTHER')
    const cross = resultOf()
    p.check('wren: a Write of another org\'s (absent) shared AGENTS.md is refused by his CLI', read(notes(other.slug)) === null,
      { file: notes(other.slug), exists: fs.existsSync(notes(other.slug)), tool_result: cross.slice(0, 300) })

    await rig.op({ op: 'hire', name: 'zoe', parent: 'lead', tier, grant: 0, title: 'sibling' })
    fs.mkdirSync(path.dirname(teamFile(rig.org, 'zoe', 'x')), { recursive: true })
    rules[3].input = { file_path: teamFile(rig.org, 'lead', 'wren-team.txt'), content: 'WREN-TEAM\n' }
    rules[4].input = { file_path: teamFile(rig.org, 'zoe', 'wren-sibling.txt'), content: 'WREN-SIBLING\n' }
    await rig.api('POST', `/api/orgs/${rig.org}/nodes/wren/process`, { action: 'stop' })
    await turn('wren', 'PROOF-WRITE-TEAM')
    const team = resultOf()
    p.check('wren: his Write created a file in lead\'s team workspace', (read(teamFile(rig.org, 'lead', 'wren-team.txt')) ?? '').includes('WREN-TEAM'),
      { file: teamFile(rig.org, 'lead', 'wren-team.txt'), tool_result: team.slice(0, 300) })
    await turn('wren', 'PROOF-WRITE-SIBLING')
    const sib = resultOf()
    p.check('wren: a Write into his sibling zoe\'s own workspace is refused by his CLI', read(teamFile(rig.org, 'zoe', 'wren-sibling.txt')) === null,
      { file: teamFile(rig.org, 'zoe', 'wren-sibling.txt'), tool_result: sib.slice(0, 300) })

    await rig.op({ op: 'hire', name: 'yara', parent: 'lead', tier, grant: 0, title: 'reader' })
    await turn('yara', 'PROOF-READ-YARA')
    const y = llm.requests.find(r => r.body_file && r.last_user?.includes('PROOF-READ-YARA'))
    p.check('yara: hired after, her first request carries the text wren wrote', y && body(y).includes('WREN-WROTE-THIS'), { body: y?.body_file })

    fs.writeFileSync(notes(other.slug), '# Other Proof notes\n\n- OTHER-ORG-NOTES\n')
    await rig.op({ op: 'hire', name: 'xan', tier, grant: 1, title: 'other org' }, { org: other.slug })
    await turn('xan', 'PROOF-READ-XAN', other.slug)
    const x = llm.requests.find(r => r.body_file && r.last_user?.includes('PROOF-READ-XAN'))
    p.check('xan (org B): his first request carries his org\'s notes and never org A\'s text or path',
      x && body(x).includes('OTHER-ORG-NOTES') && !body(x).includes('WREN-WROTE-THIS') && !body(x).toLowerCase().includes(path.dirname(notes(rig.org)).replace(/\\/g, '\\\\').toLowerCase()),
      { body: x?.body_file })
    p.note('files', { a: read(notes(rig.org)), b: read(notes(other.slug)) })
  } finally {
    await llm.close()
  }
  return p.summary()
}
