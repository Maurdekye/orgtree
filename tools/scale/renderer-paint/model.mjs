// Pure validation/accounting. No Electron, environment mutations or engine imports.
import path from 'node:path'

export const SCHEMA = 'orgtree.renderer-paint/v1'
export function percentiles(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y)
  const at = p => a.length ? a[Math.ceil(a.length * p) - 1] : null
  return { n: a.length, p50: at(.5), p95: at(.95), p99: at(.99), max: a.at(-1) ?? null }
}
export function inside(candidate, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate))
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}
export function validateDescriptor(d, root, liveRoots) {
  if (d.schema !== 'orgtree-scale-v1' || !Number.isSafeInteger(d.agents) || d.agents < 2
      || !d.org || !d.token || !d.serve?.provenance || d.serve.state !== 'ready'
      || !Number.isSafeInteger(d.serve.pid) || !d.engine_commit) throw Error('Unproven scale engine')
  if (path.resolve(d.root) !== path.resolve(root) || path.resolve(d.data_root) !== path.join(path.resolve(root), 'data'))
    throw Error('Descriptor root mismatch')
  if (liveRoots.some(live => live && (inside(root, live) || inside(live, root)))) throw Error('Live-root overlap')
  const origin = new URL(d.origin), pg = new URL(d.pg_url)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port
      || origin.username || origin.password || origin.pathname !== '/') throw Error('Not a loopback engine')
  if (!['postgres:', 'postgresql:'].includes(pg.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(pg.hostname)
      || !/^orgtree_scale_[a-zA-Z0-9_]+$/.test(d.pg_database) || decodeURIComponent(pg.pathname.slice(1)) !== d.pg_database)
    throw Error('Not a disposable PostgreSQL database')
  return d
}
export function validateLoad(d, label, now = Date.now()) {
  const l = d.load
  if (!l?.running || l.label !== label || !(l.rate > 0) || !(l.stream_hz > 0)
      || !l.stream_nodes?.length || !(l.since * 1000 <= now)
      || !l.stream_nodes.every(n => d.live_agents.includes(n))) throw Error('Required live load/stream absent')
  if (!inside(l.markers, path.join(d.root, 'metrics', label))) throw Error('Marker path escaped load')
  return l
}
export function publicDescriptor(d) {
  // Never copy descriptor token, PG credentials, agent tokens, or env to artifacts.
  return { schema: d.schema, agents: d.agents, org: d.org, data_root: d.data_root,
    engine_commit: d.engine_commit, engine_pid: d.serve.pid, origin: d.origin,
    engine_provenance: { commit: d.serve.provenance.commit, dirty: d.serve.provenance.dirty },
    load: { label: d.load?.label, since: d.load?.since, rate: d.load?.rate,
      stream_nodes: d.load?.stream_nodes, stream_hz: d.load?.stream_hz } }
}
export function decodePixel(bitmap) {
  // Electron NativeImage.toBitmap is BGRA on this Windows-only harness.
  return bitmap.length >= 4 && bitmap[3] === 255 ? bitmap[2] + 256 * bitmap[1] + 65536 * bitmap[0] : -1
}
export function feedReport({ emitted, submits, receipts, paints, agent, from, until, clockErrorMs = 0 }) {
  const expected = emitted.filter(e => e.node === agent && e.emit * 1000 >= from && e.emit * 1000 < until)
  const seen = new Map(), drawn = new Map()
  for (const e of receipts) if (!seen.has(e.m)) seen.set(e.m, e.at)
  for (const e of paints) if (!drawn.has(e.m)) drawn.set(e.m, e.at)
  const rows = expected.map(e => {
    const submission = submits.find(s => e.m >= s.first_seq && e.m < s.first_seq + s.frames)
    const received = seen.get(e.m), painted = drawn.get(e.m), start = e.emit * 1000
    const status = !submission ? 'submission-unassessed' : submission.err ? 'submit-failed'
      : received == null ? 'not-received' : painted == null ? 'received-not-painted'
      : painted < received - clockErrorMs || received < start - clockErrorMs ? 'clock-invalid'
      : painted - start > 1000 ? 'late' : 'painted'
    return { m: e.m, status, emit: start, received, painted,
      arrivalToPaintMs: painted != null && received != null ? painted - received : null,
      emitToPaintMs: painted != null ? painted - start : null }
  })
  const counts = Object.fromEntries(['submission-unassessed', 'submit-failed', 'not-received', 'received-not-painted', 'clock-invalid', 'late', 'painted']
    .map(s => [s, rows.filter(r => r.status === s).length]))
  return { agent, from, until, clockErrorMs, expected: rows.length, counts, rows,
    arrivalToPaint: percentiles(rows.map(r => r.arrivalToPaintMs)),
    emitToPaint: percentiles(rows.map(r => r.emitToPaintMs)),
    // Conservative threshold: uncertainty must fit inside the deadline too.
    targetMet: rows.length > 0 && rows.every(r => r.status === 'painted' && r.emitToPaintMs + clockErrorMs <= 1000) }
}
