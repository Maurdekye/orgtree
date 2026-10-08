// tools/rig/importcheck.mjs: checks the importer proofs share.

import path from 'node:path'

import { runDesktop } from './desktop.mjs'
import { RIG_DIR } from './lib.mjs'

export const marker = rig => rig.sql(`SELECT key FROM ot.meta WHERE key = 'import_v1'`).length === 1
export const failures = rig => rig.one(`SELECT value FROM ot.kv WHERE key = 'import_failures'`)?.value ?? null
export const feedFailures = async rig => (await rig.api('GET', '/api/app/records'))?.runtime?.values?.import_failures?.value ?? null
export const orgList = (rig, p, shot) => runDesktop(rig, path.join(RIG_DIR, 'desktop', 'org-list.cjs'),
  { preset: 'short', org: '', args: { shot }, out: path.join(p.dir, shot) })
const esc = s => s.replace(/[.*+?^${}()|[\]\\/]/g, c => '\\' + c)

/** A store whose org registry cannot be read: the engine still starts,
 * imports nothing of that version, records it for the whole store and shows
 * it in the org list, retries at the next start, and imports once the
 * registry is repaired. `start` starts the run (a prepare hook that damages
 * the registry), `repair(rig)` undoes the damage, `imported(rig)` says
 * whether the store's org arrived. */
export async function unreadableRegistry(p, { label, source, name, table, start, repair, imported }) {
  let r
  try {
    r = await start()
  } catch (e) {
    p.check(`${label}: the engine still starts`, false, String(e?.message ?? e).slice(0, 500))
    return
  }
  try {
    p.check(`${label}: the engine still starts`, !!r.url, { url: r.url })
    p.check(`${label}: nothing imported, marker unset (the next start retries)`, !imported(r) && !marker(r), { imported: imported(r), marker: marker(r) })
    const lines = r.engineLog().split(/\r?\n/).filter(l => /organization registry unreadable/.test(l))
    p.file(`${label.replace(/\W+/g, '-')}-engine-log.txt`, lines.join('\n'))
    p.check(`${label}: the engine log says so, with the table`, lines.some(l => new RegExp(`table=${esc(table)}\\b`).test(l)), lines.map(l => l.slice(0, 400)))
    const rec = failures(r)?.[`${source}:*`]
    p.check(`${label}: recorded for the whole store (source ${source}, table ${table}, tries 1)`,
      rec?.source === source && rec?.name === name && rec?.table === table && rec?.tries === 1, rec)
    const seen = await orgList(r, p, `${label.replace(/\W+/g, '-')}-org-list`)
    const line = seen.ok ? seen.value.failures.map(f => f.text).join(' | ') : ''
    p.check(`${label}: the org list says "${name}: Import from ${source} failed (${table})"`, seen.ok && new RegExp(esc(name)).test(line)
      && new RegExp(`Import from ${esc(source)} failed \\(${esc(table)}\\)\\. Your ${esc(source)} data is untouched; Orgtree retries at every start\\.`).test(line),
      seen.ok ? seen.value : seen.error)
    await r.restart()
    const rec2 = failures(r)?.[`${source}:*`]
    p.check(`${label}, next start: retried (tries 2), still nothing imported`, rec2?.tries === 2 && !imported(r) && !marker(r), rec2)
    repair(r)
    await r.restart()
    p.check(`${label}, repaired: the store imports, the record and the line go`, imported(r) && marker(r) && failures(r) === null
      && JSON.stringify(await feedFailures(r)) === '[]', { imported: imported(r), marker: marker(r), kv: failures(r) })
  } finally { await r.down() }
}
