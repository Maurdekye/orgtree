// A transient silent check must not strand the wake which caused it.
// Existing fake CLI only: the first check hangs; the next reads a good fixture.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

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
  for (const name of ['auth-retry', 'auth-reject']) {
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
  await rig.op({ op: 'halt', nodes: ['auth-retry'] })

  // A clean signed-out reply stays a hard refusal, with no automatic retry.
  fixture({ check: 'reject' })
  const rejectedMark = calls().length
  await rig.userMail('auth-reject', 'SIGNED-OUT-STAYS-HELD')
  await rig.waitFor(async () => /Antigravity is signed out/.test((await chat('auth-reject'))?.last_error ?? ''),
    { what: 'signed-out admission hold', timeout: 5000 })
  await new Promise(resolve => setTimeout(resolve, 1200))
  const rejected = calls().slice(rejectedMark)
  p.check('signed-out wake runs one check and no runtime',
    rejected.filter(c => c.kind === 'check').length === 1 && !rejected.some(c => c.kind === 'runtime'), rejected)
  p.check('signed-out wake creates no inference turn', rig.turns('auth-reject').length === 0)
  p.file('guard-calls.json', calls())
  p.keep(rig, { agents: ['auth-retry', 'auth-reject'], grep: /agy|Agy|Antigravity/ })
  return p.summary()
}
