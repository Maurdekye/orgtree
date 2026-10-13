// Real engine + scripted ACP executable. No model/API calls. The fake starts
// the actual bridge, negotiates initialize/tools/list and invokes orgtree_status.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { setup as keysSetup } from './openrouter-keys.mjs'

export async function setup() { return { ...(await keysSetup()), name: 'opencode-acp' } }

export default async function (rig) {
  const p = new Proof('opencode-acp')
  await rig.waitFor(async () => (await rig.api('GET', '/api/harnesses')).harnesses?.find(h => h.id === 'opencode')?.installed,
    { what: 'ACP entrypoint discovery', timeout: 30000 })
  const registry = (await rig.api('GET', '/api/harnesses')).harnesses.find(h => h.id === 'opencode')
  p.check('installed ACP harness serves only the two configured provider lanes', registry.selectable
    && registry.providers.map(x => x.id).sort().join() === 'langserver,openrouter', registry)
  await rig.api('PUT', '/api/openrouter/keys/openrouter-key', { harness: 'opencode' })
  await rig.op({ op: 'hire', name: 'acp', parent: 'boss', tier: 'or-rig-fake-model', grant: 1,
    title: 'ACP fixture', permission_mode: 'default', tools: { bash: false, edit: true } })
  await rig.waitFor(() => rig.turns('acp').every(t => t.ended_at), { what: 'initial hire wake to settle' })
  const agent = rig.agentRow('acp')
  const scratch = rig.one(`SELECT scratch_dir FROM ot.agents WHERE id=${agent.id}`)?.scratch_dir
  if (!scratch || !fs.existsSync(scratch)) throw new Error('fixture agent has no scratch directory')
  const file = path.join(scratch, 'acp-fixture.json')
  const set = doc => fs.writeFileSync(file, JSON.stringify(doc))
  const settle = async text => {
    const n = rig.turns('acp').filter(t => t.ended_at).length
    await rig.userMail('acp', text)
    await rig.waitTurns('acp', n + 1)
    return rig.turns('acp').at(-1)
  }
  const rows = async () => JSON.stringify(await rig.api('GET', `/api/orgs/${rig.org}/nodes/${agent.id}/chat`))
  set({ text: 'SCOPED', permissions: [
    { name: 'execute', rawInput: { code: 'nested shell/fetch' } },
    { name: 'shell', rawInput: { command: 'anything' } },
    { name: 'write', locations: [{ path: path.join(scratch, 'allowed.txt') }], rawInput: { path: path.join(scratch, 'allowed.txt') } },
    { name: 'write', locations: [{ path: path.join(rig.dir, 'outside.txt') }], rawInput: { path: path.join(rig.dir, 'outside.txt') } },
  ] })
  const turn = await settle('ACP scoped control')
  p.check('configured OpenRouter lane completes on ACP', !turn.error && rig.agentRow('acp').extra?.harness === 'opencode', turn)
  const text = await rows()
  p.check('text, reasoning and actual bridge tool appear in transcript', text.includes('ACP_FIXTURE SCOPED')
    && text.includes('ACP fixture reasoning') && text.includes('orgtree_status'), text.slice(-2500))
  const selected = [...text.matchAll(/optionId[\\]*"[\\]*:[\\]*"(reject|once|always)/g)].map(m => m[1])
  p.check('default denies execute, shell and outside write; allows scoped write once', selected.join().includes('reject,reject,once,reject'), selected)
  const usage = rig.one(`SELECT a.cost_unknown, t.cost_source, t.cache_ttl_s, t.input_tokens, t.cache_read, t.toks
    FROM ot.agents a JOIN ot.turns t ON t.agent_id=a.id WHERE a.id=${agent.id} ORDER BY t.id DESC LIMIT 1`)
  p.check('unpriced custom ACP cost and cache TTL stay unknown despite fake zero', usage?.cost_unknown === true
    && usage.cost_source === 'unknown' && usage.cache_ttl_s == null, usage)
  p.check('per-prompt tokens are recorded once', usage?.input_tokens === 12 && usage.cache_read === 3 && usage.toks === 7, usage)
  const sid = rig.agentRow('acp').session_id
  await settle('ACP warm follow-up')
  p.check('warm follow-up retains session identity', rig.agentRow('acp').session_id === sid, { sid, now: rig.agentRow('acp').session_id })
  p.check('no replay text was ingested', !(await rows()).includes('REPLAY_MUST_NOT_APPEAR'))
  p.keep(rig, { grep: /ACP|OpenCode|acp/ })
  return p.summary()
}
