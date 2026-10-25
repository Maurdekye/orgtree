// A transient silent check must not strand the wake which caused it.
// Existing fake CLI only: the first check hangs; the next reads a good fixture.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

// The auth-call stream is global. Ignore a late runtime only when its PID is
// positively and unambiguously owned by another agent in this same run/org.
export function attributeAuthRuntimes(calls, starts, { data, org, rejected }) {
  const canonical = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return null
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const runtimes = calls.filter(c => c.kind === 'runtime').map(call => {
    const matches = Number.isSafeInteger(call.pid) && call.pid > 0
      ? starts.filter(s => s.entry?.kind === 'start' && s.entry.pid === call.pid) : []
    const valid = matches.filter(({ agent, entry }) =>
      typeof agent === 'string' && /^[\w.-]+$/.test(agent) && agent !== '.' && agent !== '..' &&
      entry.mode === 'agy' && entry.org === org &&
      (entry.agent === undefined || entry.agent === agent) &&
      canonical(entry.cwd) === canonical(path.join(data, 'scratch', org, agent)))
    const owners = [...new Set(valid.map(s => s.agent))]
    const owner = matches.length > 0 && valid.length === matches.length && owners.length === 1 ? owners[0] : null
    return { call, owner, blocking: owner === null || owner === rejected,
      reason: owner === null ? 'unknown or conflicting PID/cwd/agent' : owner === rejected ? 'rejected agent runtime' : 'positively owned by another agent' }
  })
  return { runtimes, blocking: runtimes.filter(r => r.blocking) }
}

export default async function (rig) {
  const p = new Proof('agy-auth-wake')
  await rig.waitFor(async () => !(await rig.api('GET', '/api/providers')).checking,
    { what: 'initial discovery', timeout: 30000 })
  const fixture = v => fs.writeFileSync(path.join(rig.fakeDir, 'agy-auth.json'), JSON.stringify(v))
  const calls = () => {
    try { return fs.readFileSync(path.join(rig.fakeDir, 'agy-auth-calls.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) }
    catch (e) { if (e.code === 'ENOENT') return []; throw e }
  }
  const chat = name => rig.api('GET', `/api/orgs/${rig.org}/nodes/${name}/chat?last=1`)
  for (const name of ['auth-retry', 'auth-metadata', 'auth-reject']) {
    await rig.op({ op: 'hire', name, parent: 'boss', tier: 'flash', title: 'Synthetic auth wake' })
  }
  const before = rig.turns('auth-retry').length
  const mark = calls().length
  fixture({ check: 'hang' })
  const started = Date.now()
  await rig.userMail('auth-retry', 'ONE-WAKE-AFTER-TRANSIENT-CHECK')
  await rig.waitFor(() => calls().slice(mark).some(c => c.kind === 'check'),
    { what: 'first silent check started', timeout: 3000 })
  // auth_log precedes loading the fixture: let that fake process enter its
  // configured hang before changing what a later process will read.
  await new Promise(resolve => setTimeout(resolve, 200))
  fixture({ check: 'ok' })
  const settled = await rig.waitFor(() => {
    const turns = rig.turns('auth-retry').filter(t => t.ended_at)
    return turns.length > before && turns.at(-1)
  }, { what: 'same wake retried after transient check', timeout: 14000 }).catch(e => ({ wait_error: e.message }))
  p.check('first check actually timed out before recovery', Date.now() - started >= 7500)
  p.check('one wake completes after a transient silent check, without another message',
    !!settled.ended_at && !settled.error, settled)
  const seen = calls().slice(mark)
  p.check('recovery rechecks before launching exactly one runtime',
    seen.filter(c => c.kind === 'check').length >= 2 && seen.filter(c => c.kind === 'runtime').length === 1, seen)
  p.check('only one inference turn was created', rig.turns('auth-retry').length === before + 1)
  p.check('transient timeout never creates a sign-out latch',
    !fs.existsSync(path.join(rig.data, 'diagnostics', 'agy-auth-latch.json')))
  const diagnostics = rig.engineLog().split(/\r?\n/).filter(line =>
    /Antigravity guarded check failed|Antigravity launch check inconclusive/.test(line))
  p.check('safe diagnostics identify timeout and bounded retry without account text',
    diagnostics.some(line => /capture_timeout/.test(line) && /Timeout/.test(line)) &&
    diagnostics.some(line => /retry_ms=500/.test(line)) && diagnostics.every(line => !line.includes('@')), diagnostics)
  await rig.op({ op: 'halt', nodes: ['auth-retry'] })

  // An unreadable metadata fixture exercises Unavailable, including the
  // metadata-only gate before preflight. Restore the original synthetic stamp
  // so the ordinary metadata polling loop cannot be the recovery mechanism.
  const metadataPath = path.join(rig.data, 'agy-auth-metadata.json')
  fs.writeFileSync(metadataPath, JSON.stringify({ bad: true }))
  await rig.userMail('auth-metadata', 'ONE-WAKE-AFTER-METADATA-ERROR')
  const observed = await rig.waitFor(() => rig.engineLog().split(/\r?\n/).some(line =>
    /metadata_before_check/.test(line) && /Unavailable/.test(line)),
    { what: 'inconclusive metadata check', timeout: 2000 }).catch(() => false)
  fs.writeFileSync(metadataPath, JSON.stringify({ stamp: 1 }))
  const recovered = await rig.waitFor(() => rig.turns('auth-metadata').find(t => t.ended_at),
    { what: 'same wake retried after metadata became readable', timeout: 5000 }).catch(e => ({ wait_error: e.message }))
  p.check('metadata-only gate defers transient failure to bounded full check', observed === true)
  p.check('unavailable metadata recovers the original wake without asserting sign-out',
    !!recovered.ended_at && !recovered.error && !fs.existsSync(path.join(rig.data, 'diagnostics', 'agy-auth-latch.json')), recovered)
  await rig.op({ op: 'halt', nodes: ['auth-metadata'] })

  // A clean signed-out reply stays a hard refusal, with no automatic retry.
  fixture({ check: 'reject' })
  const rejectedMark = calls().length
  await rig.userMail('auth-reject', 'SIGNED-OUT-STAYS-HELD')
  await rig.waitFor(async () => /Antigravity is signed out/.test((await chat('auth-reject'))?.last_error ?? ''),
    { what: 'signed-out admission hold', timeout: 5000 })
  await new Promise(resolve => setTimeout(resolve, 1200))
  const rejected = calls().slice(rejectedMark)
  const logDir = path.join(rig.fakeDir, 'log')
  const starts = (fs.existsSync(logDir) ? fs.readdirSync(logDir, { withFileTypes: true }) : [])
    .filter(file => file.isFile() && file.name.endsWith('.jsonl'))
    .flatMap(file => {
      const agent = file.name.slice(0, -6)
      return rig.fakeLog(agent).map(entry => ({ agent, entry }))
    })
  const attribution = attributeAuthRuntimes(rejected, starts, { data: rig.data, org: rig.org, rejected: 'auth-reject' })
  p.file('signed-out-runtime-attribution.json', attribution)
  p.check('signed-out wake runs one check and no runtime',
    rejected.filter(c => c.kind === 'check').length === 1 && attribution.blocking.length === 0, { calls: rejected, ...attribution })
  p.check('signed-out wake creates no inference turn', rig.turns('auth-reject').length === 0)
  p.file('guard-calls.json', calls())
  p.keep(rig, { agents: ['auth-retry', 'auth-metadata', 'auth-reject'], grep: /agy|Agy|Antigravity/ })
  return p.summary()
}
