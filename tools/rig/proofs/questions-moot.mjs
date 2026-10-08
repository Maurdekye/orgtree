// Proof: an open question when the session that posed it is replaced by a
// fresh one (3.x mooted it: "the successor starts fresh and never posed
// it"), and when it is not.
//   sam (Claude, haiku) moves to Codex (luna): a provider switch starts a
//       fresh session; his card closes as moot, and his first Codex turn is
//       told the question was closed and to pose it again if it matters.
//   zed (Codex on an added account B) loses B: the removal starts a fresh
//       thread on the primary; his card closes as moot and he is told.
//   ivy (Codex on B) is moved to the primary by the user: the thread goes
//       with her (decision 43), so the session that asked is still hers and
//       her card stays open.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/questions-moot.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url')
function codexHome(dir, email) {
  fs.mkdirSync(dir, { recursive: true })
  const idToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ email })}.rig`
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: idToken } }))
  return dir
}

export default async function (rig) {
  const p = new Proof('questions-moot')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const B = (await rig.api('POST', '/api/accounts', { provider: 'openai', kind: 'imported',
    path: codexHome(path.join(rig.data, 'rig-home', 'codex-b'), 'rig-b@example.invalid') })).id
  await rig.op({ op: 'hire', name: 'sam', parent: 'boss', tier: 'haiku', title: 'Switching agent' })
  await rig.op({ op: 'hire', name: 'zed', parent: 'boss', tier: 'luna', title: 'Codex agent on B', account: B })
  await rig.op({ op: 'hire', name: 'ivy', parent: 'boss', tier: 'luna', title: 'Codex agent on B', account: B })
  for (const name of ['sam', 'zed', 'ivy']) {
    await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: name, reason: 'proof: may ask the user' })
    await rig.userMail(name, `Hello ${name}.`)
    await rig.waitTurns(name, 1)
  }
  const id = name => rig.agentRow(name).id
  const ask = name => rig.one(`SELECT uid, status, reason FROM ot.asks WHERE agent_id = ${id(name)} ORDER BY id DESC LIMIT 1`)
  const log = (agent, kind) => rig.fakeLog(agent).filter(l => !kind || l.kind === kind)
  const prompt = name => log(name, 'turn').at(-1)?.prompt ?? ''
  const card = async name => ((await rig.api('GET', `/api/orgs/${rig.org}`)).asks ?? []).find(a => a.node === name && a.status === 'open')
  for (const [name, q] of [['sam', 'Rename the service?'], ['zed', 'Archive the old logs?'], ['ivy', 'Keep the cache warm?']]) {
    const r = await rig.tool(name, 'orgtree_ask', { question: q, options: ['Yes', 'No'] })
    if (!r.ok) p.note(`${name} could not ask`, r.text)
  }
  p.check('sam, zed and ivy each have an open card', ['sam', 'zed', 'ivy'].every(n => ask(n)?.status === 'open'), ['sam', 'zed', 'ivy'].map(n => ask(n)?.status))

  // ---------------------------------------------------------------- sam: Claude to Codex
  const sw = await rig.op({ op: 'switch_model', node: 'sam', tier: 'luna' })
  const sa = ask('sam')
  p.check('sam: a provider switch closes his card as moot (the fresh session never posed it)', sa?.status === 'moot'
    && /provider switch/.test(sa.reason ?? '') && !(await card('sam')), { switched: sw?.tier ?? sw, ask: sa })
  await rig.userMail('sam', 'Carry on, please.')
  await rig.waitTurns('sam', 2)
  const sp = prompt('sam')
  p.check('sam: his first Codex turn is told the question was closed and to pose it again if it matters', log('sam', 'thread').length > 0
    && /Rename the service\?/.test(sp) && /was closed when this fresh session replaced/.test(sp) && /Pose it again/.test(sp)
    && !/still have a request open/.test(sp), sp.slice(sp.indexOf('fresh session') - 200, sp.indexOf('fresh session') + 900))

  // ---------------------------------------------------------------- ivy: moved to the primary, thread kept
  const ivyThread = log('ivy', 'thread').at(-1)?.thread
  const moved = await rig.op({ op: 'account', node: 'ivy', account: 'primary' }).then(r => r, e => ({ error: e.message }))
  await rig.userMail('ivy', 'Carry on, please.')
  await rig.waitTurns('ivy', 2)
  const it = log('ivy', 'thread').at(-1)
  p.check('ivy: moved off B by the user, her thread goes with her and her card stays open', !moved?.error && it?.action === 'resume'
    && it.thread === ivyThread && ask('ivy')?.status === 'open' && !!(await card('ivy')), { moved, thread: it, ask: ask('ivy') })

  // ---------------------------------------------------------------- zed: B removed
  const removed = await rig.api('DELETE', `/api/accounts/${B}`).then(r => r, e => ({ error: e.message }))
  const za = ask('zed')
  p.check('zed: removing the account he ran on closes his card as moot', !removed?.error && za?.status === 'moot'
    && /account was removed/.test(za.reason ?? '') && !(await card('zed')), { removed: removed?.error ?? 'ok', ask: za })
  await rig.userMail('zed', 'Carry on, please.')
  await rig.waitTurns('zed', 2)
  const zp = prompt('zed')
  p.check('zed: his fresh thread is told the question was closed and to pose it again if it matters', log('zed', 'thread').at(-1)?.action === 'start'
    && /Archive the old logs\?/.test(zp) && /was closed when this fresh session replaced/.test(zp), zp.slice(0, 1500))
  p.check('ivy: her card is still open after B is gone (she had already moved)', ask('ivy')?.status === 'open', ask('ivy'))

  p.keep(rig, { agents: ['sam', 'zed', 'ivy'], grep: /ask|moot|switch|account|handoff/i })
  return p.summary()
}
