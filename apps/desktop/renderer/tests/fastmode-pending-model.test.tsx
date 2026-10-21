import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import { syncProviderRegistries } from '../src/canvas/shared'
import type { CanvasNode, OpFn } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const providers = [{ id: 'claude', tiers: [
  { tier: 'sonnet', model: 'claude-sonnet-5-5', fast_mode: false },
  { tier: 'opus', model: 'claude-opus-5-5', fast_mode: true },
] }]

async function settings(t: TestContext, history: boolean, serving: string, queued?: string) {
  const oldFetch = globalThis.fetch
  localStorage.clear()
  syncProviderRegistries({ providers })
  installFetch(new FakeServer())
  const fallback = globalThis.fetch, writes: Record<string, unknown>[] = [], ops: Record<string, unknown>[] = []
  globalThis.fetch = (async (url, init) => {
    if ((String(url).endsWith('/scope') || String(url).endsWith('/gesture')) && init?.body) {
      writes.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ ok: true, cascaded: [], results: [{ ok: true, cascaded: [] }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return fallback(url, init)
  }) as typeof fetch
  const node = { id: 'worker', tier: serving, model_id: serving, generation: 1, state: 'live',
    busy: true, fast_mode_current: serving === 'opus', seat: 2, grant: 0, free: 0, children: [],
    scope: { tools: {}, add_dirs: [], fast_mode: false },
    ...(queued ? { pending_switch: { tier: queued } } : {}),
  } as CanvasNode
  const tree = { slug: 'pending-fast', dirs: [], tiers: { sonnet: 2, opus: 4 }, max_top_grant: 100,
    default_effort: 'high', cascade_hire: true, undo_history: history } as unknown as TreePayload
  const op: OpFn = async body => { ops.push(body); return { queued: true } }
  const v = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree}
    slug={tree.slug} op={op} toast={() => {}} close={() => {}} />, el => el)
  t.after(async () => { await v.unmount(); globalThis.fetch = oldFetch; localStorage.clear() })
  await inAct(async () => { await flush(4) })
  const click = (button: HTMLElement) => inAct(async () => { button.click(); await flush(4) })
  return { node, v, writes, ops, click,
    save: async () => {
      const save = [...v.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'save')!
      await click(save)
    } }
}

for (const history of [false, true]) {
  test(`queued supported target offers a speed-only save; history=${history}`, async t => {
    const h = await settings(t, history, 'sonnet', 'opus')
    const checkbox = h.v.el.querySelector<HTMLInputElement>('input[aria-label="Fast mode"]')
    assert.equal(!!checkbox, true)
    await h.click(checkbox!)
    await h.save()
    assert.deepEqual(h.ops, [], 'saving speed does not requeue or cancel the model switch')
    assert.equal(h.writes.length, 1)
    if (history) assert.deepEqual(h.writes[0]!.steps, [{ op: 'scope', node: 'worker', fast_mode: true }])
    else assert.deepEqual(h.writes[0], { fast_mode: true })
    assert.equal(h.node.tier, 'sonnet')
    assert.equal(h.node.fast_mode_current, false, 'the serving turn keeps its speed evidence')
  })

  test(`queued unsupported target hides speed even while serving a supported model; history=${history}`, async t => {
    const h = await settings(t, history, 'opus', 'sonnet')
    assert.equal(h.v.el.querySelector('input[aria-label="Fast mode"]') === null, true)
    await h.save()
    const scope = history ? (h.writes[0]!.steps as Record<string, unknown>[]).at(-1)! : h.writes[0]!
    assert.equal('fast_mode' in scope, false, 'an unsupported target cannot acquire fast mode from the old model')
    assert.equal(h.node.tier, 'opus')
    assert.equal(h.node.fast_mode_current, true)
  })

  test(`one settings save orders model switch before target speed; history=${history}`, async t => {
    const h = await settings(t, history, 'sonnet')
    const select = h.v.el.querySelector<HTMLSelectElement>('[aria-label="model tier"]')!
    await inAct(async () => { select.value = 'opus'; select.dispatchEvent(new Event('change', { bubbles: true })); await flush(3) })
    const checkbox = h.v.el.querySelector<HTMLInputElement>('input[aria-label="Fast mode"]')
    assert.equal(!!checkbox, true)
    await h.click(checkbox!)
    await h.save()
    // A busy model change uses its existing explicit queue confirmation.
    const confirm = document.querySelector<HTMLButtonElement>('.overlay .confirm .primary')
      ?? [...document.querySelectorAll<HTMLButtonElement>('.overlay button.primary')]
        .find(b => /queue|switch|confirm|move/i.test(b.textContent ?? ''))
    assert.equal(!!confirm, true, 'busy model changes still ask before queuing')
    await h.click(confirm!)
    if (history) {
      const steps = h.writes[0]!.steps as Record<string, unknown>[]
      assert.equal(steps[0]!.op, 'switch_model')
      assert.equal(steps[0]!.tier, 'opus')
      assert.equal(steps[1]!.op, 'scope')
      assert.equal(steps[1]!.fast_mode, true)
    } else {
      assert.equal(h.ops[0]!.op, 'switch_model')
      assert.equal(h.ops[0]!.tier, 'opus')
      assert.equal(h.writes[0]!.fast_mode, true)
    }
    assert.equal(h.node.tier, 'sonnet')
    assert.equal(h.node.fast_mode_current, false)
  })
}
