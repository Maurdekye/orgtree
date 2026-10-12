// User 2026-08-08 / P56: only user-authorized folder additions/upgrades
// enter the org ceiling. Real HTTP/agent-tool paths, synthetic rig state only.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Proof } from '../proof.mjs'

export async function setup() { return { fixture: 'none' } }

export default async function (rig) {
  const p = new Proof('approved-folder-grants')
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  p.note('binary provenance', { engine: rig.run.engine, copiedEngineSha256: sha(path.join(rig.dir, 'bin', 'orgtree-engine.exe')),
    label: process.env.FOLDER_GRANT_PROOF_LABEL ?? 'unspecified' })
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const created = await rig.api('POST', '/api/orgs', { name: 'Folder grants', dirs: [], net_autoconnect: false })
  rig.run.org = created.slug
  const { writeRun } = await import('../lib.mjs')
  rig.run = writeRun(rig.dir, { org: created.slug })
  for (const a of [{ name: 'boss', grant: 48 }, { name: 'alice', parent: 'boss', grant: 16 },
    { name: 'bob', parent: 'alice' }, { name: 'carol', parent: 'boss', index: 1 }]) {
    await rig.op({ op: 'hire', tier: 'haiku', index: 0, ...a })
  }
  for (const node of ['bob', 'carol']) await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node, reason: 'synthetic proof' })
  const q = s => `'${String(s).replaceAll("'", "''")}'`
  const oid = () => rig.one(`SELECT id FROM ot.orgs WHERE slug=${q(rig.org)}`).id
  const settings = () => rig.one(`SELECT settings FROM ot.orgs WHERE id=${oid()}`).settings
  const raw = name => rig.one(`SELECT scope FROM ot.agents WHERE org_id=${oid()} AND name=${q(name)}`).scope
  const folder = name => path.join(rig.data, 'grant-proof', name)
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  const has = (dirs, dir, mode) => (dirs ?? []).some(d => same(d.path, dir) && (!mode || d.mode === mode))
  const ask = async (name, items) => {
    const out = await rig.tool(name, 'orgtree_request_scope', { items: items.map(d => ({ kind: 'dir', ...d })), reason: 'synthetic folder proof' })
    const row = rig.one(`SELECT uid, rev, body, status FROM ot.asks WHERE agent_id=${rig.agentRow(name).id} AND status='open' ORDER BY id DESC LIMIT 1`)
    if (!out.ok || !row) throw new Error(`request setup failed for ${name}: ${out.text}`)
    return row
  }
  const decide = (name, row, decisions) => rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/batch`, { revs: { scope: row.rev }, scope: decisions })
  const save = (name, dirs, extra = {}) => rig.api('POST', `/api/orgs/${rig.org}/nodes/${name}/scope`, { add_dirs: dirs, ...extra })
  const answer = name => rig.one(`SELECT body, ev FROM ot.mail WHERE recipient_agent_id=${rig.agentRow(name).id} AND sender='@user' AND kind='decision' ORDER BY id DESC LIMIT 1`)
  const tryCall = fn => fn().then(json => ({ ok: true, json }), e => ({ ok: false, status: e.status, text: String(e.message) }))
  const snapshot = () => ({ settings: settings(), agents: rig.sql(`SELECT name,scope,row_version FROM ot.agents WHERE org_id=${oid()} ORDER BY name`) })
  const other = await rig.api('POST', '/api/orgs', { name: 'Separate folder org', dirs: [], net_autoconnect: false })
  const otherBefore = rig.one(`SELECT settings FROM ot.orgs WHERE slug=${q(other.slug)}`).settings
  const shared = folder('shared'), inner = path.join(shared, 'inner'), missing = folder('missing')
  fs.mkdirSync(inner, { recursive: true })
  await rig.api('POST', `/api/orgs/${rig.org}/settings`, { org_dirs: [{ path: shared, mode: 'ro' }], auto_resume: false })
  let row = await ask('boss', [{ path: missing, mode: 'rw' }])
  await decide('boss', row, ['approve'])
  p.check('top-level approval enters organization RW folders even when directory is absent', has(settings().dirs, missing, 'rw'), settings().dirs)
  p.check('top-level approval is retained in raw scope and does not create a directory', has(raw('boss').add_dirs, missing, 'rw') && !fs.existsSync(missing))
  p.check('top-level approval decision describes granted effective scope', /granted/i.test(answer('boss').body) && !/clamped/i.test(answer('boss').body), answer('boss'))

  row = await ask('bob', [{ path: inner, mode: 'rw' }])
  await decide('bob', row, ['approve'])
  p.check('deep approval adds narrow RW org coverage and preserves broader RO folder', has(settings().dirs, inner, 'rw') && has(settings().dirs, shared, 'ro'), settings().dirs)
  p.check('deep approval raises child and every ancestor RW', ['boss', 'alice', 'bob'].every(n => has(raw(n).add_dirs, inner, 'rw')))
  p.check('deep approval is reported GRANTED rather than partial', /granted/i.test(answer('bob').body) && !/partial|clamped/i.test(answer('bob').body), answer('bob'))
  await rig.waitTurns('bob', 1)
  const starts = rig.fakeLog('bob').filter(l => l.kind === 'start')
  p.check('next fake CLI launch receives approved existing directory', starts.some(l => (l.add_dirs ?? []).some(d => same(d, inner))), starts.map(l => l.add_dirs))

  // Seed pre-existing clamped intent directly, solely in the disposable rig.
  // An unrelated save must never turn it into a fresh user authorization.
  const latent = folder('latent'), retry = folder('retry-latent')
  for (const n of ['boss', 'alice', 'bob']) {
    rig.exec(`UPDATE ot.agents SET scope=jsonb_set(scope,'{add_dirs}',coalesce(scope->'add_dirs','[]') || ${q(JSON.stringify([{ path: latent, mode: 'rw' }, { path: retry, mode: 'rw' }]))}::jsonb) WHERE org_id=${oid()} AND name=${q(n)}`)
  }
  const direct = folder('direct-ro')
  await save('bob', [...raw('bob').add_dirs, { path: direct, mode: 'ro' }])
  p.check('direct user addition enters organization RO folders', has(settings().dirs, direct, 'ro'), settings().dirs)
  p.check('whole-list direct save excludes unrelated unchanged latent folders', !has(settings().dirs, latent) && !has(settings().dirs, retry))
  await save('bob', raw('bob').add_dirs.map(d => same(d.path, direct) ? { ...d, mode: 'rw' } : d))
  p.check('direct user RO-to-RW upgrade raises org mode', has(settings().dirs, direct, 'rw'), settings().dirs)
  row = await ask('bob', [{ path: retry, mode: 'rw' }])
  await decide('bob', row, ['approve'])
  p.check('explicit reapproval of stored clamped intent enters org despite no raw delta', has(settings().dirs, retry, 'rw') && !has(settings().dirs, latent), settings().dirs)

  const denied = folder('denied'), skipped = folder('skipped'), approved = folder('approved-mixed')
  row = await ask('bob', [{ path: denied, mode: 'rw' }, { path: skipped, mode: 'rw' }, { path: approved, mode: 'ro' }])
  await decide('bob', row, ['deny', 'skip', 'approve'])
  p.check('mixed decision absorbs approved RO folder only', has(settings().dirs, approved, 'ro') && !has(settings().dirs, denied) && !has(settings().dirs, skipped))
  const dirsBeforeSkip = settings().dirs
  row = await ask('bob', [{ path: skipped, mode: 'rw' }])
  await decide('bob', row, ['skip'])
  p.check('all-skip dismissal changes no org folders', JSON.stringify(settings().dirs) === JSON.stringify(dirsBeforeSkip))
  row = await ask('bob', [{ path: denied, mode: 'rw' }])
  await decide('bob', row, ['deny'])
  p.check('all-deny decision changes no org folders', JSON.stringify(settings().dirs) === JSON.stringify(dirsBeforeSkip))

  const unauthorized = folder('agent-forbidden'), beforeAgent = snapshot()
  const agentGrant = await rig.tool('alice', 'orgtree_retool', { node: 'bob', add_dirs: [{ path: unauthorized, mode: 'rw' }] })
  p.check('ordinary agent cannot elevate outside its own effective folder scope', !agentGrant.ok && JSON.stringify(snapshot()) === JSON.stringify(beforeAgent), agentGrant.text)
  await save('bob', raw('bob').add_dirs.filter(d => !same(d.path, direct)))
  p.check('direct user revocation removes child grant while preserving org coverage', !has(raw('bob').add_dirs, direct) && has(settings().dirs, direct, 'rw'))
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/bob/scope`, { effort: 'high' })
  p.check('non-folder scope save revives neither removed nor unrelated latent grant', !has(raw('bob').add_dirs, direct) && !has(settings().dirs, latent))
  const userRetool = folder('user-retool')
  await rig.op({ op: 'retool', node: 'bob', add_dirs: [{ path: userRetool, mode: 'rw' }] })
  p.check('existing user retool org absorption remains compatible', has(settings().dirs, userRetool, 'rw'))

  const x = folder('concurrent-x'), y = folder('concurrent-y')
  const rx = await ask('bob', [{ path: x, mode: 'rw' }]), ry = await ask('carol', [{ path: y, mode: 'ro' }])
  const concurrent = await Promise.all([decide('bob', rx, ['approve']), decide('carol', ry, ['approve']),
    rig.api('POST', `/api/orgs/${rig.org}/settings`, { auto_resume: true }),
    rig.op({ op: 'retool', node: 'alice', tools: { web: true } })].map(fn => Promise.resolve(fn).then(() => ({ ok: true }), e => ({ ok: false, text: e.message }))))
  p.check('concurrent approvals/settings/user retool all commit without lock-order failure', concurrent.every(r => r.ok), concurrent)
  p.check('concurrent folder grants merge without losing either or unrelated settings', has(settings().dirs, x, 'rw') && has(settings().dirs, y, 'ro') && settings().auto_resume === true, settings())
  p.check('separate organization settings remain unchanged', JSON.stringify(rig.one(`SELECT settings FROM ot.orgs WHERE slug=${q(other.slug)}`).settings) === JSON.stringify(otherBefore))

  // Fail answer-mail insertion after scope writes. All state must roll back.
  await rig.waitFor(() => rig.sql('SELECT id FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'turns settled before failure proof' })
  const failure = folder('rollback'), failedAsk = await ask('bob', [{ path: failure, mode: 'rw' }]), beforeFailure = snapshot()
  rig.exec(`CREATE FUNCTION ot.folder_grant_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.recipient_agent_id=${rig.agentRow('bob').id} AND NEW.sender='@user' AND NEW.kind='decision' THEN RAISE EXCEPTION 'synthetic folder grant rollback'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER folder_grant_fail BEFORE INSERT ON ot.mail FOR EACH ROW EXECUTE FUNCTION ot.folder_grant_fail()`)
  let failed
  try { failed = await tryCall(() => decide('bob', failedAsk, ['approve'])) }
  finally { rig.exec('DROP TRIGGER folder_grant_fail ON ot.mail; DROP FUNCTION ot.folder_grant_fail()') }
  p.check('injected answer-mail failure refuses the route', !failed.ok && failed.status >= 500, failed)
  p.check('failed transaction rolls back org/ancestors/child including row versions', JSON.stringify(snapshot()) === JSON.stringify(beforeFailure))
  p.check('failed transaction leaves request open with no granted answer', rig.one(`SELECT status FROM ot.asks WHERE uid=${q(failedAsk.uid)}`).status === 'open' && !has(settings().dirs, failure))
  p.keep(rig, { agents: ['boss', 'alice', 'bob', 'carol'], grep: /scope|Reconfigured|folder_grant_fail|batch/i })
  return p.summary()
}
