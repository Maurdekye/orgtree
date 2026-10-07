// tools/rig/fixture.mjs: seed a rig run from a declarative fixture file,
// through the engine's real routes (org create, tree ops, desk mail) and the
// rig's tool route, never through raw SQL. Format: docs/rust-engine/test-rig.md.

import fs from 'node:fs'
import path from 'node:path'

import { RIG_DIR } from './lib.mjs'

export function loadFixture(spec) {
  if (!spec) spec = path.join(RIG_DIR, 'fixtures', 'basic.json')
  if (typeof spec === 'object') return spec
  const file = fs.existsSync(spec) ? spec : path.join(RIG_DIR, 'fixtures', spec.endsWith('.json') ? spec : `${spec}.json`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** Seed `fixture` into the running engine; returns what was made. */
export async function seed(rig, fixture) {
  const made = { org: null, agents: [], docket: [], mail: [] }
  if (fixture.scenario) rig.scenario(fixture.scenario)
  if (fixture.org) {
    const org = await rig.api('POST', '/api/orgs', { name: fixture.org.name ?? 'Rig Org', dirs: fixture.org.dirs ?? [], net_autoconnect: false })
    made.org = org.slug
    const { writeRun } = await import('./lib.mjs')
    rig.run = writeRun(rig.dir, { org: org.slug })
    if (fixture.org.settings) await rig.api('POST', `/api/orgs/${org.slug}/settings`, fixture.org.settings)
  }
  for (const a of fixture.agents ?? []) {
    const body = { op: 'hire', tier: 'haiku', ...a }
    if (a.parent) body.parent = a.parent
    await rig.op(body)
    made.agents.push(a.name)
  }
  for (const d of fixture.docket ?? []) {
    const r = await rig.tool(d.as, 'orgtree_work', { action: 'create', kind: 'code', ...d.args })
    if (!r.ok) throw new Error(`fixture docket item ${d.args?.title}: ${r.text}`)
    made.docket.push(r.json?.slug ?? r.text)
  }
  for (const m of fixture.mail ?? []) {
    if (m.from === 'user') {
      await rig.userMail(m.to, m.body, { notice: !!m.notice })
    } else {
      const r = await rig.tool(m.from, 'orgtree_message', { to: m.to, body: m.body, notice: !!m.notice, kind: m.kind })
      if (!r.ok) throw new Error(`fixture mail ${m.from} → ${m.to}: ${r.text}`)
    }
    made.mail.push(`${m.from}→${m.to}`)
  }
  return made
}
