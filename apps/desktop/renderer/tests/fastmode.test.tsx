import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { NodeConfig } from '../src/canvas/modals'
import { agentTooltipInfo } from '../src/canvas/OrgCanvas'
import { syncProviderRegistries } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import { resetConvos } from '../src/convo'

const providers = [{ id: 'openai', tiers: [{ tier: 'sol', model: 'gpt-6.1-sol',
  fast_mode: true, fast_mode_versions: { '6.1': true, '6': false } }] },
{ id: 'claude', tiers: [{ tier: 'opus', model: 'claude-opus-5-5', fast_mode: true }] }]
const node = (tier = 'sol', on = false): CanvasNode => ({
  id: 'worker', state: 'live', tier, generation: 1, children: [], seat: 2, grant: 0, free: 0,
  model_id: tier === 'sol' ? 'gpt-6.1-sol' : tier,
  scope: { tools: {}, add_dirs: [], fast_mode: on },
} as CanvasNode)
function setup() {
  localStorage.clear(); resetConvos(); syncProviderRegistries({ providers })
  installFetch(new FakeServer())
  const original = globalThis.fetch, posted: Record<string, unknown>[] = []
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/scope') && init?.body) {
      posted.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ ok: true, cascaded: [] }), { status: 200 })
    }
    return original(url, init)
  }) as typeof fetch
  return posted
}
async function desk(n: CanvasNode) {
  return mountView(<DeskChat node={n} map={new Map([[n.id, n]])} slug="org"
    op={async () => ({})} toast={() => {}} bare />, el => el)
}

test('fast mode bolt beside Send persists only the per-agent boolean', async () => {
  const posted = setup(), n = node(), v = await desk(n)
  try {
    const toggle = v.el.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]')
    assert.equal(!!toggle, true, 'supported models offer a lightning toggle')
    assert.equal(toggle!.getAttribute('aria-pressed'), 'false')
    assert.match(toggle!.title, /higher usage/i)
    assert.match(toggle!.title, /next turn/i)
    const controls = toggle!.closest('.cc-controls')
    assert.equal(!!controls, true, 'the toggle belongs to the shared wrapping controls row')
    assert.equal(controls!.querySelector('.cc-send') !== null, true,
      'the same row owns Send beside the speed and effort controls')
    await inAct(async () => { toggle!.click(); await flush(4) })
    assert.deepEqual(posted, [{ fast_mode: true }])
    await v.render(<DeskChat node={node('sol', true)} map={new Map([[n.id, n]])}
      slug="org" op={async () => ({})} toast={() => {}} bare />)
    assert.equal(v.el.querySelector('[aria-label="Fast mode"]')?.getAttribute('aria-pressed'), 'true')
    await inAct(async () => { v.el.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]')!.click(); await flush(4) })
    assert.deepEqual(posted.at(-1), { fast_mode: false }, 'off persists an explicit boolean')
  } finally { await v.unmount(); resetConvos() }
})

test('unsupported harnesses and unsupported pinned models hide the bolt even with a stored true', async () => {
  setup()
  for (const tier of ['sonnet', 'haiku', 'argon', 'agy-opus', 'wonder', 'or-test', 'ls-test']) {
    const v = await desk(node(tier, true))
    try { assert.equal(v.el.querySelector('[aria-label="Fast mode"]') === null, true, tier) }
    finally { await v.unmount(); resetConvos() }
  }
  const n = node('sol', true); n.scope!.model_version = '6'
  const v = await desk(n)
  try { assert.equal(v.el.querySelector('[aria-label="Fast mode"]') === null, true) }
  finally { await v.unmount(); resetConvos() }
})

test('agent settings expose and save Fast mode only for a supported model', async () => {
  const posted = setup()
  const tree = { slug: 'org', dirs: [], tiers: { sol: 2, opus: 4, haiku: .5 }, max_top_grant: 100,
    default_effort: 'high', cascade_hire: true } as unknown as TreePayload
  for (const supported of [true, false]) {
    const n = node(supported ? 'sol' : 'haiku')
    const v = await mountView(<NodeConfig node={n} map={new Map([[n.id,n]])} tree={tree}
      slug="org" op={async () => ({})} toast={() => {}} close={() => {}} />, el => el)
    try {
      await inAct(async () => { await flush(3) })
      const checkbox = v.el.querySelector<HTMLInputElement>('input[aria-label="Fast mode"]')
      assert.equal(!!checkbox, supported)
      if (supported) {
        await inAct(async () => { checkbox!.click(); await flush(2) })
        const save = [...v.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'save')!
        assert.equal(!!save, true)
        await inAct(async () => { save.click(); await flush(4) })
        assert.deepEqual(posted.at(-1), { fast_mode: true }, 'a speed-only save does not resend structural settings')
      }
    } finally { await v.unmount() }
  }
})

test('agent identity tooltip shows fast mode only while enabled and supported', () => {
  setup()
  assert.match(agentTooltipInfo(node('sol', true))?.title ?? '', /(?:^| \u00b7 )fast$/)
  assert.doesNotMatch(agentTooltipInfo(node('sol', false))?.title ?? '', /(?:^| \u00b7 )fast$/)
  assert.doesNotMatch(agentTooltipInfo(node('haiku', true))?.title ?? '', /(?:^| \u00b7 )fast$/)
  syncProviderRegistries({ providers: [] })
  assert.doesNotMatch(agentTooltipInfo(node('sol', true))?.title ?? '', /(?:^| \u00b7 )fast$/,
    'loss of advertised support removes a stale fast-mode claim')
})
