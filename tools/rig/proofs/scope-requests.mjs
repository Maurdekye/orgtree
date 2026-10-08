// Proof: an agent asks the user for more scope (orgtree_request_scope), and
// what it is told once the user approves. The organization's folders cap
// every grant, so an approval can land short of the request; 3.x measured
// the scope after the grant and said what really happened.
//   sky (holds a user audience, no web tool) asks for the web tool, a folder
//       inside the org's read-only folder with write access, and a folder
//       outside the org's folders. The user approves all three: the web tool
//       is granted; the inner folder lands read-only (partially clamped); the
//       outer folder is not in effect (clamped). Asking for what she already
//       holds is dropped.
//   ned (no audience): his scope request goes to his superior as mail.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/scope-requests.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('scope-requests')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const shared = path.join(rig.data, 'rig-shared')
  const inner = path.join(shared, 'sub')
  const outside = path.join(rig.data, 'rig-outside')
  for (const d of [inner, outside]) fs.mkdirSync(d, { recursive: true })
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { org_dirs: [{ path: shared, mode: 'ro' }] })
  await rig.op({ op: 'hire', name: 'sky', parent: 'boss', tier: 'haiku', title: 'Scope agent', tools: { web: false } })
  await rig.op({ op: 'hire', name: 'ned', parent: 'boss', tier: 'haiku', title: 'Scope agent without audience' })
  await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: 'sky', reason: 'proof: may ask the user' })
  const id = name => rig.agentRow(name).id
  const row = name => rig.one(`SELECT uid, status, rev, body FROM ot.asks WHERE agent_id = ${id(name)} ORDER BY id DESC LIMIT 1`)
  const decision = name => rig.sql(`SELECT body, ev FROM ot.mail WHERE recipient_agent_id = ${id(name)} AND sender = '@user'
    AND kind = 'decision' ORDER BY id`).at(-1)
  const tryApi = (method, route, body) => rig.api(method, route, body).then(json => ({ ok: true, json }),
    e => ({ ok: false, status: e.status, detail: String(e.body?.detail ?? e.message).slice(0, 200) }))

  // ---------------------------------------------------------------- sky asks
  const held = await rig.tool('sky', 'orgtree_request_scope', { items: [{ kind: 'tool', tool: 'bash' }], reason: 'proof: already held' })
  p.check('sky: asking only for what she already holds makes no request', held.ok && /already hold everything/.test(held.text ?? '')
    && !row('sky'), held.text)
  const asked = await rig.tool('sky', 'orgtree_request_scope', { reason: 'proof: research and a shared folder', items: [
    { kind: 'tool', tool: 'web' }, { kind: 'dir', path: inner, mode: 'rw' }, { kind: 'dir', path: outside, mode: 'rw' }] })
  const r = row('sky')
  p.check('sky: her request is one open card with three scope items', asked.ok && r?.status === 'open'
    && (r.body?.parts?.scope?.items ?? []).length === 3, { text: asked.text, items: r?.body?.parts?.scope?.items })

  // ---------------------------------------------------------------- the user approves everything
  const res = await tryApi('POST', `/api/orgs/${rig.org}/nodes/sky/batch`, { revs: { scope: r.rev }, scope: ['approve', 'approve', 'approve'] })
  const m = decision('sky')
  const lines = (m?.ev?.cards ?? m?.ev?.sections ?? []).flatMap(c => c.lines ?? []).join('\n') || (m?.body ?? '')
  p.note('the decision mail', { body: m?.body, lines })
  const line = what => lines.split('\n').find(l => l.includes(what)) ?? ''
  p.check('sky: the web tool is granted and live from her next turn', res.ok && /tool: web → GRANTED — live from your next turn/.test(line('tool: web')), line('tool: web'))
  p.check('sky: the folder inside the org\'s read-only folder is reported as partially clamped, held read-only',
    /PARTIALLY clamped/.test(line(inner)) && /\(ro\)/.test(line(inner).split('you now hold')[1] ?? ''), line(inner))
  p.check('sky: the folder outside the org\'s folders is reported as clamped, not in effect', /CLAMPED — NOT in effect/.test(line(outside)), line(outside))
  p.check('sky: the plain-text summary says the same', /granted/.test(m?.body ?? '') && /partially/i.test(m?.body ?? '')
    && /not in effect/i.test(m?.body ?? ''), m?.body)
  await rig.waitTurns('sky', 1)
  const same = (a, b) => path.resolve(a ?? '').toLowerCase() === path.resolve(b ?? '').toLowerCase()
  const dirs = rig.fakeLog('sky').filter(l => l.kind === 'start').at(-1)?.add_dirs ?? []
  p.check('sky: what her CLI actually gets matches: the inner folder, not the outer one', dirs.some(d => same(d, inner))
    && !dirs.some(d => same(d, outside)), dirs)

  // ---------------------------------------------------------------- ned: routed to his superior
  const boss = id('boss')
  const routed = await rig.tool('ned', 'orgtree_request_scope', { items: [{ kind: 'mcp', server: 'rig-mcp' }], reason: 'proof: routed' })
  const nm = rig.one(`SELECT kind, body, ev FROM ot.mail WHERE recipient_agent_id = ${boss} AND sender = 'ned' ORDER BY id DESC LIMIT 1`)
  p.check('ned: without a user audience his scope request goes to his superior as mail, and no card opens', routed.ok
    && /superior boss/.test(routed.text ?? '') && nm?.kind === 'request' && nm.ev?.variant === 'access.scope_requested'
    && /rig-mcp/.test(nm.body) && !row('ned'), { text: routed.text, mail: nm && { kind: nm.kind, variant: nm.ev?.variant } })

  p.keep(rig, { agents: ['sky', 'ned'], grep: /scope|request/i })
  return p.summary()
}
