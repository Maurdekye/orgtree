import { Proof } from '../proof.mjs'

export function setup() {
  return { fixture: { org: { name: 'Context receipt observations' }, agents: [] } }
}

const cases = [
  { id: 'missing' },
  { id: 'invalid', input: 'not-a-token-count' },
  { id: 'zero', input: 0 },
  { id: 'positive', input: 37 },
]
const marker = (name, again = false) => `RECEIPT-${name}${again ? '-AGAIN' : ''}`

function steps(lane, c, text) {
  if (lane === 'muse') return [
    { msp_usage: { ...(Object.hasOwn(c, 'input') ? { promptTokens: c.input } : {}),
      usage: { outputTokens: 17, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } },
    { text }, { sleep_ms: 2500 },
  ]
  const usage = { ...(Object.hasOwn(c, 'input') ? { input_tokens: c.input } : {}),
    output_tokens: 17, cache_read_tokens: 0, thinking_tokens: 0 }
  const step = body => ({ raw: { event: 'step_update', step_update: {
    step_index: 1, step_type: 'agent_response', ...body,
  } } })
  return [step({ state: 'ACTIVE', text_delta: text }), step({ state: 'DONE', usage }), { sleep_ms: 2500 }]
}

export default async function (rig) {
  const p = new Proof('context-receipt-observations')
  await rig.waitFor(async () => {
    const providers = (await rig.api('GET', '/api/providers')).providers ?? []
    return providers.some(v => v.id === 'muse' && v.muse?.catalog && v.status?.connected) &&
      providers.some(v => v.id === 'google' && v.status?.connected)
  }, { what: 'synthetic Muse and AGY discovery', timeout: 60000 })
  p.check('synthetic providers discovered before admission', true)
  const agents = {}
  for (const lane of ['muse', 'agy']) for (const c of cases) {
    const name = lane + c.id
    agents[name] = { turns: [{ name: 'first', once: true, steps: steps(lane, c, marker(name)) },
      ...(c.id === 'positive' ? [{ match: 'MISSING-AFTER-KNOWN', steps: steps(lane, cases[0], marker(name, true)) }] : [])] }
  }
  rig.scenario({ agents, default: { turns: [{ steps: [{ text: 'Ready.' }] }] } })

  async function inspect(lane, c, name, expected, again = false) {
    const text = marker(name, again)
    const route = `/api/orgs/${rig.org}/nodes/${name}/chat?last=60`
    await rig.waitFor(async () => {
      const chat = await rig.api('GET', route)
      return chat.busy && chat.messages.some(row => row.role === 'assistant' && row.text === text)
    }, { what: `${name} receipt processed during turn`, timeout: 20000, every: 100 })
    // Let the actor's bounded one-second coalescer settle while the fake
    // protocol remains parked. This is not waiting for the expected value.
    await new Promise(resolve => setTimeout(resolve, 1100))
    const live = await rig.api('GET', route)
    const label = name + (again ? '/missing-after-known' : '')
    const sent = rig.fakeLog(name).filter(e => e.kind === 'send').map(e => e.line)
      .filter(v => lane === 'muse' ? v?.method === 'session/tokenUsage' && v.params?.usage?.outputTokens === 17
        : v?.event === 'step_update' && v.step_update?.state === 'DONE' && v.step_update?.usage?.output_tokens === 17).at(-1)
    const receipt = lane === 'muse' ? sent?.params : sent?.step_update?.usage
    const key = lane === 'muse' ? 'promptTokens' : 'input_tokens'
    p.check(`${label}: exact native receipt reached the adapter`, !!receipt &&
      (Object.hasOwn(c, 'input') ? receipt[key] === c.input : !Object.hasOwn(receipt, key)))
    p.check(`${label}: absent/invalid prompt preserves unknown or reported occupancy`, live.busy && live.occupancy === expected,
      { actual: live.occupancy, expected, estimated: live.occupancy_estimated })
    const turns = await rig.waitTurns(name, again ? 2 : 1, { timeout: 20000 })
    const last = rig.one(`SELECT toks,input_tokens,cache_read FROM ot.turns WHERE id=${turns.at(-1).id}`)
    p.check(`${label}: cumulative spend fields survive the receipt`, Number(last.toks) === 17 &&
      Number(last.input_tokens) === (typeof c.input === 'number' ? c.input : 0) && Number(last.cache_read) === 0,
      { output: last.toks, input: last.input_tokens, cached: last.cache_read })
  }

  for (const lane of ['muse', 'agy']) for (const c of cases) {
    const name = lane + c.id
    await rig.op({ op: 'hire', name, tier: lane === 'muse' ? 'wonder' : 'flash', title: 'Synthetic receipt control' })
    // A user-created hire waits for its first message before admission.
    await rig.userMail(name, 'FIRST-RECEIPT')
    await inspect(lane, c, name, typeof c.input === 'number' ? c.input : null)
  }
  for (const lane of ['muse', 'agy']) {
    const name = lane + 'positive'
    const id = rig.agentRow(name).id
    const previous = Number(rig.one(`SELECT occupancy FROM ot.agents WHERE id=${id}`).occupancy)
    await rig.userMail(name, 'MISSING-AFTER-KNOWN')
    await inspect(lane, cases[0], name, previous, true)
  }
  p.note('Actual Muse/AGY adapters driven by fake protocol receipts. No pure-helper substitution, real inference or live data.')
  return p.summary()
}
