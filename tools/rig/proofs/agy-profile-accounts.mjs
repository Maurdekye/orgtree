// A registered Antigravity account (docket antigravity-multi-account-support-
// via-isolated-p): its AGY processes run on its own folder, and it is refused,
// never silently run on the default sign-in, while its check names the same
// account as the default (real AGY 1.3.5 does exactly that, measured
// 2026-10-16). Fake CLI, scratch rig data and folders only.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('agy-profile-accounts')
  await rig.waitFor(async () => !(await rig.api('GET', '/api/providers')).checking,
    { what: 'initial discovery', timeout: 30000 })
  fs.writeFileSync(path.join(rig.fakeDir, 'agy-auth.json'), JSON.stringify({ check: 'ok' }))
  fs.writeFileSync(path.join(rig.data, 'agy-auth-metadata.json'), JSON.stringify({ stamp: 10 }))
  const calls = () => {
    try { return fs.readFileSync(path.join(rig.fakeDir, 'agy-auth-calls.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) }
    catch (e) { if (e.code === 'ENOENT') return []; throw e }
  }
  const lower = s => String(s || '').replace(/\//g, '\\').toLowerCase()
  const attempt = (method, route, body) => rig.api(method, route, body).then(r => ({ ok: true, r }), e => ({ ok: false, status: e.status, body: e.body, e: e.message }))

  // the default lane works as before
  const before = await rig.api('GET', '/api/antigravity/usage?force=true')
  p.check('default Antigravity lane reads usage as before', before.available === true, before)

  const added = await rig.api('POST', '/api/accounts', { provider: 'google', kind: 'managed' })
  const id = added.id
  const home = added.account?.credential?.path
  p.check('a managed Antigravity row gets its own folder', !!id && !!home && fs.existsSync(home), added)
  const ownCalls = () => calls().filter(c => lower(c.home) === lower(home))

  // no token file in its folder: signed out, and no CLI runs for it
  let mark = calls().length
  let id1 = await attempt('GET', `/api/accounts/${id}/identity`)
  p.check('a profile without its own token file is signed out', id1.ok && id1.r.auth === 'unauthenticated', id1)
  p.check('a signed-out profile launches no CLI at all', calls().length === mark, calls().slice(mark))

  // a token file appears, but AGY (like 1.3.5) still names the default account
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true })
  fs.writeFileSync(path.join(home, '.gemini', 'jetski-standalone-oauth-token'), 'rig-not-a-token')
  mark = calls().length
  id1 = await attempt('GET', `/api/accounts/${id}/identity`)
  p.check('a profile naming the default account is refused as not isolated (409)',
    !id1.ok && id1.status === 409 && /same Google account/.test(id1.e), id1)
  const seen = calls().slice(mark)
  p.check('its silent check ran on its own folder, then the default was asked',
    seen[0]?.kind === 'check' && lower(seen[0]?.home) === lower(home) && seen[1]?.kind === 'check' && lower(seen[1]?.home) !== lower(home), seen)
  const latch = path.join(rig.data, 'diagnostics', `agy-auth-latch-${id}.json`)
  p.check('the refusal is latched for that account only', fs.existsSync(latch)
    && JSON.parse(fs.readFileSync(latch, 'utf8')).kind === 'not_isolated'
    && !fs.existsSync(path.join(rig.data, 'diagnostics', 'agy-auth-latch.json')), fs.existsSync(latch) && fs.readFileSync(latch, 'utf8'))

  // an agent bound to it holds its mail instead of running on the default sign-in
  await rig.op({ op: 'hire', name: 'agy-second', parent: 'boss', tier: 'flash', title: 'Second Antigravity account', account: id })
  const turns0 = rig.turns('agy-second').length
  mark = calls().length
  await rig.userMail('agy-second', 'PROFILE-NOT-ISOLATED')
  // the hold's reason is the agent's live last error (the desk's chat read)
  const chat = () => rig.api('GET', `/api/orgs/${rig.org}/nodes/agy-second/chat?last=1`)
  const held = await rig.waitFor(async () => { const c = await chat(); return /same Google account/.test(c?.last_error ?? '') && c },
    { what: 'the not-isolated hold', timeout: 20000 }).catch(async e => ({ error: e.message, last_error: (await chat())?.last_error }))
  p.check('a not-isolated account holds its agent with the plain reason', /same Google account/.test(held?.last_error ?? ''), { last_error: held?.last_error, error: held?.error })
  p.check('no turn ran and no runtime CLI started on any home', rig.turns('agy-second').length === turns0
    && !calls().slice(mark).some(c => c.kind === 'runtime'), calls().slice(mark))

  // an AGY that keeps the folder's own sign-in: a new credential, a different account
  fs.writeFileSync(path.join(home, '.gemini', 'rig-agy-identity'), 'second@example.invalid')
  fs.writeFileSync(path.join(home, '.gemini', 'jetski-standalone-oauth-token'), 'rig-not-a-token-2')
  id1 = await attempt('GET', `/api/accounts/${id}/identity`)
  p.check('an isolated profile signs in as its own account', id1.ok && id1.r.auth === 'authenticated' && id1.r.email === 'second@example.invalid', id1)
  p.check('a passing check releases its latch', !fs.existsSync(latch))
  mark = calls().length
  const u = await attempt('GET', `/api/accounts/${id}/usage?force=true`)
  p.check('its usage is read on its own folder, as itself', u.ok && u.r.available === true && u.r.account === id
    && calls().slice(mark).some(c => c.kind === 'usage' && lower(c.home) === lower(home)), { u, calls: calls().slice(mark) })
  mark = calls().length
  await rig.userMail('agy-second', 'PROFILE-ISOLATED')
  await rig.waitTurns('agy-second', turns0 + 1)
  const last = rig.turns('agy-second').at(-1)
  p.check('its agent runs a turn', !last?.error, last)
  p.check('its runtime CLI ran on its own folder', calls().slice(mark).some(c => c.kind === 'runtime' && lower(c.home) === lower(home)), calls().slice(mark))

  mark = calls().length
  const after = await rig.api('GET', '/api/antigravity/usage?force=true')
  p.check('the default Antigravity lane is unaffected', after.available === true && after.account === 'google/primary', after)
  p.check('the default lane never runs on the profile folder', calls().slice(mark).length > 0
    && calls().slice(mark).every(c => lower(c.home) !== lower(home)), calls().slice(mark))
  p.note('profile-folder calls in this proof', ownCalls().map(c => c.kind))
  p.file('guard-calls.json', calls())
  p.keep(rig, { agents: ['agy-second'], grep: /agy|Agy|Antigravity/ })
  return p.summary()
}
