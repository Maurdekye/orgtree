// Actual guarded AGY subprocesses, fake CLI and disposable vault metadata only.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('agy-auth')
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
  fixture({ check: 'ok' }); metadata({ stamp: 10 })
  let v = await usage()
  p.check('checked fake usage is available with actual 25% result', v.available && v.limits?.[0]?.percent === 25, v)
  p.check('silent checks precede version and usage launches', count('check') >= 2 && count('usage') >= 1, calls())
  await rig.op({ op: 'hire', name: 'auth-held', parent: 'boss', tier: 'flash', title: 'AGY auth gate fixture' })
  metadata({ present: false })
  const beforeAbsent = calls().length
  v = await usage(); await usage()
  p.check('absent credential marks signed out', v.reauth_required === true && !v.available, v)
  p.check('absent credential launches no CLI at all', calls().length === beforeAbsent, calls().slice(beforeAbsent))
  p.check('provider card clears connected state', !(await provider()).status.connected)
  const heldCount = rig.turns('auth-held').length
  await rig.userMail('auth-held', 'WAIT-FOR-EXTERNAL-SIGNIN')
  await new Promise(r => setTimeout(r, 500))
  p.check('signed-out agent mail waits without a turn', rig.turns('auth-held').length === heldCount)
  fixture({ check: 'reject' }); metadata({ stamp: 11 })
  const beforeReject = count('usage')
  v = await usage()
  const checked = count('check')
  await usage(); await usage()
  p.check('invalid present token latches without usage launch', v.reauth_required === true && count('usage') === beforeReject, v)
  p.check('repeated requests do not repeat even the auth check', count('check') === checked)
  p.check('persistent latch contains timestamp only', fs.readFileSync(latch, 'utf8') === '11')
  fixture({ check: 'ok' })
  await usage()
  p.check('validity change alone cannot release unchanged metadata', count('check') === checked)
  await rig.restart()
  await usage()
  p.check('engine restart retains same-credential refusal', count('check') === checked)
  metadata({ stamp: 12 })
  // Do NOT force a refresh: the metadata polling loop must recover on its own.
  await rig.waitFor(async () => (await provider()).status.connected,
    { what: 'external sign-in detected without restart', timeout: 25000 })
  await rig.waitTurns('auth-held', heldCount + 1)
  p.check('external sign-in releases queued agent mail', !rig.turns('auth-held').at(-1)?.error)
  p.check('successful recovery removes stale latch', !fs.existsSync(latch))
  await rig.op({ op: 'halt', nodes: ['auth-held'] })
  metadata({ bad: true })
  const beforeUnknown = calls().length
  v = await usage()
  p.check('unreadable metadata refuses launch without asserting signed out', !v.available
    && v.reauth_required !== true && calls().length === beforeUnknown, v)
  fixture({ check: 'hang' }); metadata({ stamp: 120 })
  const hungAt = Date.now()
  v = await usage()
  p.check('hung silent check is bounded and is not a successful authentication', !v.available
    && v.reauth_required !== true && Date.now() - hungAt < 12000, v)
  for (const [stamp, check, behavior] of [[13, 'unsupported', {}], [14, 'prompt', {}], [15, 'ok', { usage: 'prompt' }]]) {
    fixture({ check, ...behavior }); metadata({ stamp })
    const begin = Date.now(); v = await usage()
    const after = calls().length
    await usage()
    p.check(`${check}/${stamp}: refusal is signed out and latched`, v.reauth_required === true && calls().length === after, v)
    p.check(`${check}/${stamp}: prompt guard settles under three seconds`, Date.now() - begin < 3000)
  }
  fixture({ check: 'ok', runtime: 'prompt' }); metadata({ stamp: 16 })
  await usage()
  await rig.op({ op: 'unhalt', nodes: ['auth-held'] })
  const beforeRuntime = rig.turns('auth-held').filter(t => t.ended_at).length
  await rig.userMail('auth-held', 'AUTH-PROMPT-MUST-STOP')
  await rig.waitTurns('auth-held', beforeRuntime + 1)
  p.check('agent runtime auth prompt stops and latches', fs.existsSync(latch)
    && /sign-in required/.test(rig.turns('auth-held').at(-1)?.error ?? ''), rig.turns('auth-held').at(-1))
  const runtimeCalls = count('runtime')
  await usage()
  p.check('runtime refusal prevents subsequent background probes', count('runtime') === runtimeCalls && (await usage()).reauth_required === true)
  p.file('guard-calls.json', calls())
  p.keep(rig, { agents: ['auth-held'], grep: /agy|Agy|Antigravity/ })
  return p.summary()
}
