// Proof: the engine's first-start import of a 2.x data folder, on a
// synthetic store (tools/rig/legacy2x.mjs), checked row by row; the store
// itself must be left untouched. Then the same store without its log_l table:
// the import must fail loudly and leave nothing half-imported, so the next
// start retries it.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/import-2x.mjs

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { runDesktop } from '../desktop.mjs'
import { LEGACY_SLUG, writeLegacy2x } from '../legacy2x.mjs'
import { RIG_DIR, rigHome, startRun } from '../lib.mjs'
import { Proof } from '../proof.mjs'

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
let source = null, sourceSha = null

export async function setup() {
  const dir = path.join(rigHome(), 'legacy', `2x-full-${stamp()}`)
  source = await writeLegacy2x(dir)
  sourceSha = sha(source)
  return { legacy: dir, fixture: 'none', name: 'import2x' }
}

export default async function (rig) {
  const p = new Proof('import-2x')
  const q = sql => rig.sql(sql)
  const org = q(`SELECT id, slug, name, created_at FROM ot.orgs WHERE slug = '${LEGACY_SLUG}'`)[0]
  p.check('the 2.x org was imported (slug, name, creation time)', org && org.name === 'Legacy Org' && /^2026-09-01/.test(org.created_at), org)
  const agents = Object.fromEntries(q(`SELECT a.name, a.state, a.tier, a.title, a.charter, p.name AS parent, a.grant_credits, a.session_id, a.last_status
                                         FROM ot.agents a LEFT JOIN ot.agents p ON p.id = a.parent_id WHERE a.org_id = ${org.id}`).map(a => [a.name, a]))
  p.check('agents: lead and dev live, retired archived', agents.lead?.state === 'live' && agents.dev?.state === 'live' && agents.retired?.state === 'archived', Object.values(agents).map(a => `${a.name}:${a.state}`))
  p.check('the manager chain survives (dev and retired under lead)', agents.dev?.parent === 'lead' && agents.retired?.parent === 'lead' && !agents.lead?.parent)
  p.check('tier, title, charter, grant, session and last status survive',
    agents.lead?.tier === 'opus' && agents.lead?.title === 'Legacy lead' && agents.lead?.charter === 'You lead the legacy org.' && Number(agents.lead?.grant_credits) === 12
    && agents.lead?.session_id === 'sess-legacy-lead' && agents.lead?.last_status?.summary === 'Leading the 2.x org', agents.lead)
  const turns = q(`SELECT count(*)::int AS n FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id WHERE a.org_id = ${org.id} AND a.name = 'dev'`)[0].n
  p.check('dev\'s recent turns were copied', turns === 2, { turns })
  const mail = q(`SELECT m.uid, m.state, m.recipient_kind, m.recipient_name, m.body FROM ot.mail m WHERE m.org_id = ${org.id} ORDER BY m.id`)
  const byUid = Object.fromEntries(mail.map(m => [m.uid, m]))
  p.check('pending agent mail stays pending', byUid['m-legacy-pending']?.state === 'pending' && byUid['m-legacy-pending']?.recipient_name === 'dev', byUid['m-legacy-pending'])
  p.check('delivered mail log copied (3 rows)', [1, 2, 3].every(n => byUid[`m-legacy-done-${n}`]?.state === 'delivered'), mail.map(m => `${m.uid}:${m.state}`))
  p.check('the user\'s inbox copied', byUid['m-legacy-user']?.recipient_kind === 'user' && byUid['m-legacy-user']?.state === 'pending', byUid['m-legacy-user'])
  const asks = q(`SELECT k.status, k.body::text AS body FROM ot.asks k JOIN ot.agents a ON a.id = k.agent_id WHERE a.org_id = ${org.id}`)
  p.check('the open question copied', asks.length === 1 && asks[0].status === 'open' && asks[0].body.includes('LEGACY question: ship it?'), asks)
  const items = q(`SELECT slug, title, status, rev, owner->>'node' AS owner, done_so_far, working_on_next FROM ot.work_items WHERE org_id = ${org.id}`)
  p.check('the docket item copied (owner, status, rev, lists)', items.length === 1 && items[0].slug === 'legacy-item' && items[0].owner === 'dev'
    && items[0].status === 'in_progress' && Number(items[0].rev) === 3 && items[0].done_so_far?.[0] === 'scoped', items)
  const docs = q(`SELECT title, format FROM ot.documents WHERE org_id = ${org.id}`)
  p.check('the document copied', docs.length === 1 && docs[0].title === 'LEGACY plan', docs)
  const dogs = q(`SELECT w.name, w.kind, w.state, a.name AS owner FROM ot.watchdogs w JOIN ot.agents a ON a.id = w.owner_agent_id WHERE w.org_id = ${org.id}`)
  p.check('the watchdog copied with its owner', dogs.length === 1 && dogs[0].name === 'legacy-log-watch' && dogs[0].owner === 'dev', dogs)
  const events = q(`SELECT op FROM ot.events WHERE org_id = ${org.id} AND op IN ('hire', 'retire') ORDER BY id`)
  p.check('events copied', events.map(e => e.op).join(',') === 'hire,retire', events)
  const marker = q(`SELECT key FROM ot.meta WHERE key = 'import_v1'`)
  p.check('the import marker import_v1 is set (no re-import next start)', marker.length === 1, marker)
  // the engine read the copy in its data root: it must still match the source byte for byte
  const copy = path.join(rig.data, 'orgs', `${LEGACY_SLUG}.db`)
  p.check('the 2.x store the engine read was not modified', fs.existsSync(copy) && sha(copy) === sourceSha, { copy, sha: sourceSha })

  const shot = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'explore.cjs'), { preset: 'tall', org: LEGACY_SLUG, out: path.join(p.dir, 'canvas') })
  p.check('the imported org renders on the canvas', shot.ok && shot.value?.cards?.some(c => /lead/.test(c.text)) && shot.value?.cards?.some(c => /dev/.test(c.text)),
    shot.ok ? shot.value.cards.map(c => c.text) : shot.error)

  // ---------------------------------------------------------------- the damaged store
  const broken = path.join(rigHome(), 'legacy', `2x-no-log_l-${stamp()}`)
  await writeLegacy2x(broken, { variant: 'no-log_l' })
  const r2 = await startRun({ legacy: broken, name: 'import2x-broken' })
  try {
    const orgs2 = r2.sql(`SELECT slug FROM ot.orgs`)
    p.check('damaged store: the engine still starts', !!r2.url, { url: r2.url })
    p.check('damaged store: nothing half-imported (no org row)', orgs2.length === 0, orgs2)
    const marker2 = r2.sql(`SELECT key FROM ot.meta WHERE key = 'import_v1'`)
    p.check('damaged store: no import_v1 marker, so the next start retries', marker2.length === 0, marker2)
    const failed = r2.engineLog().split(/\r?\n/).filter(l => /2\.x organization import failed/.test(l))
    p.check('damaged store: the failure is logged with its table', failed.length >= 1 && /table=log_l\b/.test(failed[0]), failed.map(l => l.slice(0, 300)))
    // every importer tells the user the same way: a line in the org list
    const rec = r2.one(`SELECT value FROM ot.kv WHERE key = 'import_failures'`)?.value?.[`2.x:${LEGACY_SLUG}`]
    p.check('damaged store: the failure is recorded for the org list (source 2.x, org name, table log_l)', rec?.source === '2.x' && rec?.name === 'Legacy Org'
      && rec?.table === 'log_l' && rec?.tries === 1, rec)
    const seen = await runDesktop(r2, path.join(RIG_DIR, 'desktop', 'org-list.cjs'), { preset: 'short', org: '', args: { shot: 'damaged-org-list' }, out: path.join(p.dir, 'damaged-org-list') })
    const line = seen.ok ? seen.value.failures.map(f => f.text).join(' | ') : ''
    p.check('damaged store: the org list shows "Import from 2.x failed (log_l)"',
      seen.ok && /Import from 2\.x failed \(log_l\)\. Your 2\.x data is untouched; Orgtree retries at every start\./.test(line), seen.ok ? seen.value : seen.error)
  } finally { await r2.down() }
  return p.summary()
}
