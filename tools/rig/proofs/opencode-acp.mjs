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
  await rig.userMail('acp', 'ACP initial bridge control')
  await rig.waitTurns('acp', 1)
  const agent = rig.agentRow('acp')
  const scratch = rig.one(`SELECT scratch_dir FROM ot.agents WHERE id=${agent.id}`)?.scratch_dir
  if (!scratch || !fs.existsSync(scratch)) throw new Error('fixture agent has no scratch directory')
  const file = path.join(scratch, 'acp-fixture.json')
  const set = doc => fs.writeFileSync(file, JSON.stringify(doc))
  const observed = () => {
    try { return fs.readFileSync(path.join(scratch, 'acp-observed.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) }
    catch (e) { if (e.code === 'ENOENT') return []; throw e }
  }
  const settle = async text => {
    const n = rig.turns('acp').filter(t => t.ended_at).length
    await rig.userMail('acp', text)
    await rig.waitTurns('acp', n + 1)
    return rig.turns('acp').at(-1)
  }
  const chat = () => rig.api('GET', `/api/orgs/${rig.org}/nodes/${agent.id}/chat`)
  const rows = async () => JSON.stringify(await chat())
  const permissions = [
    { name: 'execute', rawInput: { code: 'nested shell/fetch' } },
    { name: 'shell', rawInput: { command: 'anything' } },
    { name: 'write', locations: [{ path: path.join(scratch, 'allowed.txt') }], rawInput: { path: path.join(scratch, 'allowed.txt') } },
    { name: 'write', locations: [{ path: path.join(rig.dir, 'outside.txt') }], rawInput: { path: path.join(rig.dir, 'outside.txt') } },
  ]
  set({ text: 'SCOPED', permissions })
  const turn = await settle('ACP scoped control')
  p.check('configured OpenRouter lane completes on ACP', !turn.error && rig.agentRow('acp').extra?.harness === 'opencode', turn)
  const text = await rows()
  p.check('text, reasoning and actual bridge tool appear in transcript', text.includes('ACP_FIXTURE SCOPED')
    && text.includes('ACP fixture reasoning') && text.includes('orgtree_status'), text.slice(-2500))
  const strings = value => typeof value === 'string' ? [value]
    : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
  const answer = strings(await chat()).find(s => s.startsWith('ACP_FIXTURE SCOPED decisions='))
  const selected = answer ? JSON.parse(answer.split(' decisions=')[1]).map(d => d.result?.outcome?.optionId) : []
  p.check('default denies execute, shell and outside write; allows scoped write once', selected.join() === 'reject,reject,once,reject', selected)
  const usage = rig.one(`SELECT a.cost_unknown, t.cost_source, t.cache_ttl_s, t.input_tokens, t.cache_read, t.toks
    FROM ot.agents a JOIN ot.turns t ON t.agent_id=a.id WHERE a.id=${agent.id} ORDER BY t.id DESC LIMIT 1`)
  p.check('unpriced custom ACP cost and cache TTL stay unknown despite fake zero', usage?.cost_unknown === true
    && usage.cost_source === 'unknown' && usage.cache_ttl_s == null, usage)
  p.check('per-prompt tokens are recorded once', usage?.input_tokens === 12 && usage.cache_read === 3 && usage.toks === 7, usage)
  const sid = rig.agentRow('acp').session_id
  await settle('ACP warm follow-up')
  p.check('warm follow-up retains session identity', rig.agentRow('acp').session_id === sid, { sid, now: rig.agentRow('acp').session_id })
  const beforeStop = observed().at(-1)
  await rig.op({ op: 'halt', nodes: ['acp'] })
  p.check('halt removes the isolated launch directory', !fs.existsSync(beforeStop.home), beforeStop)
  await rig.op({ op: 'unhalt', nodes: ['acp'] })
  await settle('ACP new process resume')
  const resumed = observed().at(-1)
  p.check('fresh process loads the persisted session', resumed.pid !== beforeStop.pid && resumed.session === sid, { beforeStop, resumed })
  p.check('no replay text was ingested', !(await rows()).includes('REPLAY_MUST_NOT_APPEAR'))
  for (const [mode, expected] of [['acceptEdits', 'reject,reject,once,reject'], ['bypassPermissions', 'once,once,once,once']]) {
    await rig.op({ op: 'retool', node: 'acp', permission_mode: mode })
    set({ text: mode, permissions })
    await settle(`ACP ${mode} control`)
    const answer = strings(await chat()).find(s => s.startsWith(`ACP_FIXTURE ${mode} decisions=`))
    const decisions = answer ? JSON.parse(answer.split(' decisions=')[1]).map(d => d.result?.outcome?.optionId) : []
    p.check(`${mode} composes through the actor without persistent approvals`, decisions.join() === expected, decisions)
  }
  await rig.op({ op: 'retool', node: 'acp', permission_mode: 'default', tools: { bash: true, edit: true } })
  set({ text: 'SHELL', permissions: [permissions[1]] })
  await settle('ACP enabled shell control')
  const shell = strings(await chat()).find(s => s.startsWith('ACP_FIXTURE SHELL decisions='))
  p.check('native shell follows the bash switch', shell && JSON.parse(shell.split(' decisions=')[1])[0]?.result?.outcome?.optionId === 'once')

  let starts = observed().length
  let turns = rig.turns('acp').filter(t => t.ended_at).length
  set({ text: 'FIRST', delayMs: 2000 })
  await rig.userMail('acp', 'ACP first delayed turn')
  await rig.waitFor(() => observed().length > starts, { what: 'delayed ACP request begins', timeout: 30000 })
  set({ text: 'NEXT' })
  await rig.userMail('acp', 'ACP_QUEUED_MARKER')
  await rig.waitTurns('acp', turns + 2)
  const queued = observed().slice(starts)
  p.check('mid-turn mail appears only in a later prompt', queued.length === 2 && !queued[0].queuedMarker && queued[1].queuedMarker, queued)

  starts = observed().length
  turns = rig.turns('acp').filter(t => t.ended_at).length
  set({ text: 'CANCELLED_OUTPUT', delayMs: 30000 })
  await rig.userMail('acp', 'ACP cancellation control')
  await rig.waitFor(() => observed().length > starts, { what: 'cancellable ACP request begins', timeout: 30000 })
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/${agent.id}/interrupt`, {})
  await rig.waitTurns('acp', turns + 1)
  p.check('cancel settles the prompt without post-cancel output', !(await rows()).includes('ACP_FIXTURE CANCELLED_OUTPUT'))
  set({ text: 'AFTER_CANCEL' })
  const after = await settle('ACP after cancellation')
  p.check('the next turn succeeds after cancellation', !after.error && (await rows()).includes('ACP_FIXTURE AFTER_CANCEL'))
  p.keep(rig, { grep: /ACP|OpenCode|acp/ })
  return p.summary()
}
