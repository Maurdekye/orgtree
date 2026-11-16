// Antigravity's FILE sign-in (no session keyring, e.g. the standalone engine
// in a Linux container): AGY 1.5.9 keeps it in
// <home>/.gemini/antigravity-cli/antigravity-oauth-token, and its silent check
// (AGY_CLI_CDE_AUTH_ACTION=check) never reads that file (measured 2026-11-16,
// docket antigravity-agents-on-a-headless-engine-subscrip). The engine then
// validates it with `agy models` instead. Fake CLI and disposable fixtures
// only: the token file is written in the run's fake home, never a real one.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('agy-file-token')
  await rig.waitFor(async () => !(await rig.api('GET', '/api/providers')).checking,
    { what: 'initial discovery', timeout: 30000 })
  const metadata = value => fs.writeFileSync(path.join(rig.data, 'agy-auth-metadata.json'), JSON.stringify(value))
  const fixture = value => fs.writeFileSync(path.join(rig.fakeDir, 'agy-auth.json'), JSON.stringify(value))
  const calls = () => {
    try { return fs.readFileSync(path.join(rig.fakeDir, 'agy-auth-calls.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) }
    catch (e) { if (e.code === 'ENOENT') return []; throw e }
  }
  const count = kind => calls().filter(x => x.kind === kind).length
  const usage = () => rig.api('GET', '/api/antigravity/usage?force=true')
  const provider = async () => (await rig.api('GET', '/api/providers')).providers.find(x => x.id === 'google')
  const latch = path.join(rig.data, 'diagnostics', 'agy-auth-latch.json')
  const latchJson = () => JSON.parse(fs.readFileSync(latch, 'utf8'))
  const age = seconds => { const t = new Date(Date.now() - seconds * 1000); fs.utimesSync(latch, t, t) }
  const token = path.join(rig.data, 'rig-home', '.gemini', 'antigravity-cli', 'antigravity-oauth-token')

  // Control: no token file, a silent check that refuses (as AGY 1.5.9 does
  // with a file sign-in): signed out, through the silent check.
  fixture({ check: 'reject' }); metadata({ stamp: 50 })
  let v = await usage()
  p.check('control: no token file keeps the silent check, which refuses', v.reauth_required === true && count('check') >= 1 && count('models') === 0, calls())

  // The file sign-in: the check still refuses, `agy models` lists rows.
  fs.mkdirSync(path.dirname(token), { recursive: true })
  fs.writeFileSync(token, '{"synthetic":"not a token"}')
  metadata({ stamp: 51 })
  let mark = calls().length
  v = await usage()
  p.check('a file sign-in is validated by agy models and authorizes usage', v.available === true && v.reauth_required !== true, v)
  p.check('the file sign-in never asks the silent check', calls().slice(mark).every(x => x.kind !== 'check') && count('models') >= 1, calls().slice(mark))
  p.check('the provider card is connected', (await provider()).status.connected === true, await provider())

  // A pass is reused for the same stamp: no second validation within 60 s.
  const validations = count('models')
  await usage(); await usage()
  p.check('repeated reads inside 60 s reuse the pass', count('models') === validations, calls().slice(mark))

  // An agent turn on the file sign-in.
  await rig.op({ op: 'hire', name: 'file-agy', parent: 'boss', tier: 'flash', title: 'AGY file sign-in fixture' })
  const before = rig.turns('file-agy').length
  await rig.userMail('file-agy', 'FILE-SIGN-IN-TURN')
  await rig.waitTurns('file-agy', before + 1)
  p.check('an agent runs on the file sign-in', !rig.turns('file-agy').at(-1)?.error && count('runtime') >= 1, rig.turns('file-agy').at(-1))

  // The measured signed-out reply: a clean refusal, revalidated later.
  fixture({ check: 'reject', models: 'signed_out' }); metadata({ stamp: 52 })
  v = await usage()
  p.check('the measured signed-out reply is signed out and latched refused', v.reauth_required === true && latchJson().kind === 'refused', latchJson())
  mark = calls().length
  await usage()
  p.check('a fresh refused latch runs no CLI', calls().length === mark, calls().slice(mark))
  fixture({ check: 'reject' })
  age(31)
  v = await usage()
  p.check('an aged refused latch revalidates with agy models on a forced read', v.available === true && calls()[mark]?.kind === 'models', calls().slice(mark))

  // An OAuth prompt and an unknown reply: untrusted until the file changes.
  for (const [stamp, models] of [[53, 'prompt'], [54, 'unknown']]) {
    fixture({ check: 'reject', models }); metadata({ stamp })
    const begin = Date.now(); v = await usage()
    p.check(`${models}: signed out and latched untrusted`, v.reauth_required === true && latchJson().kind === 'untrusted', latchJson())
    p.check(`${models}: settles under three seconds`, Date.now() - begin < 3000, Date.now() - begin)
    mark = calls().length
    age(400); await usage()
    p.check(`${models}: an untrusted latch never reruns the CLI, even aged and forced`, calls().length === mark, calls().slice(mark))
  }
  // A new sign-in (the token file rewritten) releases it.
  fixture({ check: 'reject' }); metadata({ stamp: 55 })
  v = await usage()
  p.check('a new token file stamp releases the untrusted latch', v.available === true && !fs.existsSync(latch), v)

  // Signing out removes the file: back to the silent check.
  fs.rmSync(token)
  metadata({ stamp: 56 })
  mark = calls().length
  v = await usage()
  p.check('no token file: the silent check again, which refuses', v.reauth_required === true && calls()[mark]?.kind === 'check', calls().slice(mark))

  p.file('guard-calls.json', calls())
  p.keep(rig, { agents: ['file-agy'], grep: /agy|Agy|Antigravity/ })
  return p.summary()
}
