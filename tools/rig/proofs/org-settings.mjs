// Proof: the user's org settings, as 3.x applied them (_org_settings_apply).
//   Folders (org_dirs): a folder taken off the org is revoked from every
//   top-level grant, with a warning per agent; adding it back reaches only
//   future hires. A folder turned read-only downgrades the top-level grants
//   (warned), and turning it back read/write does not upgrade them.
//   Descendants follow their chain. A malformed entry is refused (422),
//   never read as "no folders".
//   The cap: lowering max_top_grant below existing top-level grants keeps
//   them and says so.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/org-settings.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('org-settings')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const D1 = path.join(rig.dir, 'shared-a'), D2 = path.join(rig.dir, 'shared-b')
  fs.mkdirSync(D1, { recursive: true })
  fs.mkdirSync(D2, { recursive: true })
  const S = (await rig.api('POST', '/api/orgs', { name: 'Rig Settings Org', dirs: [D1, D2], net_autoconnect: false })).slug
  const oid = rig.one(`SELECT id FROM ot.orgs WHERE slug = '${S}' AND state = 'active'`).id
  const tryApi = (method, route, body) => rig.api(method, route, body).then(json => ({ ok: true, json }),
    e => ({ ok: false, status: e.status, detail: String(e.body?.detail ?? e.message).slice(0, 300) }))
  const save = body => tryApi('POST', `/api/orgs/${S}/settings`, body)
  const same = (a, b) => String(a).replace(/\//g, '\\').toLowerCase() === String(b).replace(/\//g, '\\').toLowerCase()
  const stored = name => rig.one(`SELECT scope->'add_dirs' AS d FROM ot.agents WHERE org_id = ${oid} AND name = '${name}'`)?.d ?? []
  const holds = (dirs, dir, mode) => dirs.some(d => same(d.path, dir) && (!mode || d.mode === mode))
  const warned = (r, re) => (r.json?.warnings ?? []).some(w => re.test(w.replace(/\\/g, '/')))
  const fwd = s => s.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]]/g, '\\$&')
  // what the agent's CLI is actually given at its next start
  const cliDirs = async name => {
    const starts = () => rig.fakeLog(name).filter(l => l.kind === 'start').length
    const n0 = starts()
    await rig.userMail(name, 'Next.', { org: S })
    await rig.waitFor(() => starts() > n0 && rig.sql(`SELECT 1 FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
      WHERE a.org_id = ${oid} AND a.name = '${name}' AND t.ended_at IS NULL`).length === 0, { what: `${name}'s next start`, timeout: 60000 })
    return rig.fakeLog(name).filter(l => l.kind === 'start').at(-1)?.add_dirs ?? []
  }
  await rig.op({ op: 'hire', name: 'kit', tier: 'haiku', title: 'lead', grant: 6 }, { org: S })
  await rig.op({ op: 'hire', name: 'ivy', parent: 'kit', tier: 'haiku', title: 'member', grant: 1 }, { org: S })
  p.check('kit, a user hire, holds both org folders read/write', holds(stored('kit'), D1, 'rw') && holds(stored('kit'), D2, 'rw'), { kit: stored('kit') })
  await cliDirs('kit')

  // ---------------------------------------------------------------- take D1 off the org
  const r1 = await save({ org_dirs: [{ path: D2, mode: 'rw' }] })
  p.check('a folder taken off the org is revoked from the top-level grant, and the save says so (3.x)', r1.ok
    && !holds(stored('kit'), D1) && warned(r1, new RegExp(`revoked ${fwd(D1)} from kit`, 'i')), { r1: r1.json ?? r1.detail, kit: stored('kit') })
  const k1 = await cliDirs('kit')
  p.check('kit\'s CLI no longer gets the folder', !k1.some(d => same(d, D1)), { add_dirs: k1 })

  // ---------------------------------------------------------------- add it back
  const r2 = await save({ org_dirs: [{ path: D1, mode: 'rw' }, { path: D2, mode: 'rw' }] })
  const k2 = await cliDirs('kit')
  await rig.op({ op: 'hire', name: 'amy', tier: 'haiku', title: 'second lead', grant: 2 }, { org: S })
  p.check('adding the folder back reaches future hires only: kit stays without it, a new hire gets it (3.x)', r2.ok
    && !k2.some(d => same(d, D1)) && !holds(stored('kit'), D1) && holds(stored('amy'), D1, 'rw'), { add_dirs: k2, kit: stored('kit'), amy: stored('amy') })

  // ---------------------------------------------------------------- read-only, then read/write again
  const r3 = await save({ org_dirs: [{ path: D1, mode: 'rw' }, { path: D2, mode: 'ro' }] })
  p.check('a folder turned read-only downgrades the top-level grants, and the save says so (3.x)', r3.ok
    && holds(stored('kit'), D2, 'ro') && holds(stored('amy'), D2, 'ro')
    && warned(r3, new RegExp(`downgraded ${fwd(D2)} to read-only on 2 top-level grants`, 'i')), { r3: r3.json ?? r3.detail, kit: stored('kit') })
  const r4 = await save({ org_dirs: [{ path: D1, mode: 'rw' }, { path: D2, mode: 'rw' }] })
  p.check('turning it back read/write does not upgrade the grants (3.x: upgrades are granted per agent)', r4.ok
    && holds(stored('kit'), D2, 'ro') && holds(stored('amy'), D2, 'ro'), { kit: stored('kit'), amy: stored('amy') })

  // ---------------------------------------------------------------- a malformed entry
  const before = rig.one(`SELECT settings->'dirs' AS d FROM ot.orgs WHERE id = ${oid}`).d
  const r5 = await save({ org_dirs: [null] })
  const after = rig.one(`SELECT settings->'dirs' AS d FROM ot.orgs WHERE id = ${oid}`).d
  p.check('a malformed folder entry is refused (422) and the org keeps its folders', !r5.ok && r5.status === 422
    && JSON.stringify(after) === JSON.stringify(before), { r5: r5.json ?? `${r5.status} ${r5.detail}`, before, after })

  // ---------------------------------------------------------------- the cap
  const r6 = await save({ max_top_grant: 3 })
  p.check('a cap below existing top-level grants keeps them and says so (3.x, D-014)', r6.ok
    && warned(r6, /already above the new cap.*kit \(grant 6\)/), { r6: r6.json ?? r6.detail })

  p.keep(rig, { agents: ['kit'], grep: /settings|revoked|downgraded/i })
  return p.summary()
}
