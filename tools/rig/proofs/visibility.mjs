// Proof: how much of the org an agent sees is its EFFECTIVE visibility
// (D-021: visibility is a capability, child <= parent, as 3.x's
// capability_scope). kid was hired with full visibility under lead; when
// the user narrows lead to self, kid sees only itself (and its reports):
// in orgtree_chart, in orgtree_state_inspect, and in the org state block of
// its turns. Moved under a superior with team visibility, it sees that
// team and no further. Reads reach downward only: no transcript or folder
// outside its subtree, and no path out of a report's folder.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/visibility.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('visibility')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const V = (await rig.api('POST', '/api/orgs', { name: 'Rig Visibility Org', dirs: [], net_autoconnect: false })).slug
  const op = body => rig.op(body, { org: V })
  await op({ op: 'hire', name: 'lead', tier: 'haiku', title: 'lead', grant: 8, org_visibility: 'full' })
  await op({ op: 'hire', name: 'kid', parent: 'lead', tier: 'haiku', title: 'kid', grant: 2, org_visibility: 'full' })
  await op({ op: 'hire', name: 'kidkid', parent: 'kid', tier: 'haiku', title: 'kid of kid', grant: 0, org_visibility: 'full' })
  await op({ op: 'hire', name: 'zed', tier: 'haiku', title: 'other lead', grant: 4, org_visibility: 'full' })
  await op({ op: 'hire', name: 'zoe', parent: 'zed', tier: 'haiku', title: 'other team', grant: 1, org_visibility: 'full' })
  await op({ op: 'hire', name: 'sam', tier: 'haiku', title: 'team-only lead', grant: 4, org_visibility: 'team' })
  const chart = async name => (await rig.tool(name, 'orgtree_chart', {}, { org: V })).text ?? ''
  const inspect = async name => ((await rig.tool(name, 'orgtree_state_inspect', {}, { org: V })).json?.nodes ?? []).map(n => n.name).sort()
  const sees = (text, name) => new RegExp(`\\b${name}\\b`).test(text)
  const c0 = await chart('kid')
  p.check('kid starts with full visibility: its chart shows zoe in the other team', sees(c0, 'zoe'), { chart: c0.slice(0, 300) })

  // ---------------------------------------------------------------- the user narrows lead to self
  const r = await rig.api('POST', `/api/orgs/${V}/nodes/lead/scope`, { org_visibility: 'self' }).then(j => ({ ok: true, j }), e => ({ ok: false, e: e.message }))
  const c1 = await chart('kid')
  p.check('lead narrowed to self: kid\'s chart shows kid and its report, no one else (3.x capability_scope)', r.ok
    && sees(c1, 'kid') && sees(c1, 'kidkid') && !sees(c1, 'zoe') && !sees(c1, 'zed') && !sees(c1, 'sam'), { chart: c1.slice(0, 400) })
  const i1 = await inspect('kid')
  p.check('... and state_inspect lists only kid and its report', JSON.stringify(i1) === JSON.stringify(['kid', 'kidkid']), { nodes: i1 })
  await rig.userMail('kid', 'What do you see?', { org: V })
  await rig.waitFor(() => rig.fakeLog('kid').some(l => l.kind === 'turn'), { what: 'kid\'s turn', timeout: 60000 })
  const prompt = rig.fakeLog('kid').filter(l => l.kind === 'turn').at(-1)?.prompt ?? ''
  const block = prompt.slice(prompt.indexOf('[ORG STATE'), prompt.indexOf('[END ORG STATE]'))
  p.check('... and the org state block of its turn names no one outside', block.length > 0 && !sees(block, 'zoe') && !sees(block, 'zed'),
    { block: block.slice(0, 600) })

  // ---------------------------------------------------------------- moved under a team-only superior
  await rig.api('POST', `/api/orgs/${V}/nodes/lead/scope`, { org_visibility: 'full' })
  await op({ op: 'move', node: 'kid', new_parent: 'sam' })
  const c2 = await chart('kid')
  p.check('moved under sam (team): kid sees its superior, peers and reports, not the other team', sees(c2, 'sam') && sees(c2, 'kidkid')
    && !sees(c2, 'zoe'), { chart: c2.slice(0, 400) })

  // ---------------------------------------------------------------- reach: transcripts and folders are read downward only
  const scratch = (...parts) => path.join(rig.data, 'scratch', V, ...parts)
  fs.mkdirSync(scratch('kidkid'), { recursive: true })
  fs.writeFileSync(scratch('kidkid', 'notes.txt'), 'kidkid notes\n')
  fs.mkdirSync(scratch('zed'), { recursive: true })
  fs.writeFileSync(scratch('zed', 'secret.txt'), 'zed secret\n')
  const tool = (name, args) => rig.tool('kid', name, args, { org: V })
  const reach = {
    transcriptOfOtherTeam: await tool('orgtree_read_transcript', { node: 'zoe' }),
    transcriptOfSuperior: await tool('orgtree_read_transcript', { node: 'sam' }),
    folderOfOtherTeam: await tool('orgtree_read_scratch', { node: 'zed' }),
    climbOutOfReport: await tool('orgtree_read_scratch', { node: 'kidkid', path: '../zed/secret.txt' }),
    absoluteFromReport: await tool('orgtree_read_scratch', { node: 'kidkid', path: scratch('zed', 'secret.txt') }),
  }
  const own = await tool('orgtree_read_scratch', { node: 'kidkid', path: 'notes.txt' })
  const leaked = Object.entries(reach).filter(([, r]) => r.ok || /zed secret/.test(r.text ?? '')).map(([k]) => k)
  p.check('reads reach only downward: no transcript or folder outside, no climbing out of a report\'s folder; a report\'s own file reads',
    leaked.length === 0 && own.ok && /kidkid notes/.test(own.text ?? ''),
  { leaked, answers: Object.fromEntries(Object.entries(reach).map(([k, r]) => [k, (r.text ?? '').slice(0, 120)])), own: (own.text ?? '').slice(0, 80) })

  p.keep(rig, { agents: ['kid'], grep: /visibility|scope/i })
  return p.summary()
}
