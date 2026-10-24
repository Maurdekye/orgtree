import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import { hireAutoFocusOn, setHireAutoFocusOn } from '../src/hirefocus'
import { HireAutoFocusSetting } from '../src/canvas/hirepositionsetting'
import type { OpRequest, OpResult, TreePayload } from '../src/types'

const KEY = 'orgtree-hire-auto-focus'
const agent = (id: string, children: unknown[] = []) => ({ id, title: id, tier: 'sol', state: 'live',
  children, seat: 2, grant: 30, free: 30, generation: 0, turns: [], lineage: [], audiences_held: [],
  scope: { tools: {}, add_dirs: [], org_visibility: 'team' } })
const initial = { slug: 'focus-hire', name: 'Synthetic', roots: [agent('boss')], dirs: [], tiers: { sol: 2 },
  default_top_grant: 12, max_top_grant: 1000, cascade_hire: true,
  audiences: [], audience_requests: [], credit_requests: [], user_inbox_count: 0 } as unknown as TreePayload
const camera = (el: HTMLElement) => el.querySelector<HTMLElement>('.space')!.style.transform
const click = async (el: Element | null) => { assert.ok(el); await inAct(() => (el as HTMLElement).click()) }

for (const { relation, queued } of [{ relation: 'below', queued: false }, { relation: 'left', queued: false },
  { relation: 'above', queued: false }, { relation: 'below', queued: true }])
for (const history of [false, true]) for (const feedFirst of [false, true]) {
  test(`Off keeps the completion camera and closes the draft, undo=${history}, feedFirst=${feedFirst}, ${relation}, queued=${queued}`, async t => {
    useFakeClock(); localStorage.clear(); localStorage.setItem(KEY, queued ? '1' : '0'); installFetch(new FakeServer())
    let resolve!: (r: OpResult) => void
    const pending = new Promise<OpResult>(yes => { resolve = yes })
    const requests: OpRequest[] = [], before = globalThis.fetch
    globalThis.fetch = (async (url, init) => {
      if (String(url).endsWith('/gesture')) {
        const body = JSON.parse(String(init?.body)); requests.push(...body.steps)
        const result = await pending
        return new Response(JSON.stringify({ results: [result], history_entry: { id: 'synthetic-undo' } }),
          { headers: { 'Content-Type': 'application/json' } })
      }
      return before(url, init)
    }) as typeof fetch
    const render = (roots = initial.roots) => <OrgCanvas tree={{ ...initial, roots, undo_history: history }}
      slug={initial.slug} mailEvt={null} toast={() => {}}
      op={body => { requests.push(body); return pending }} />
    const v = await mountView(render(), el => el)
    t.after(async () => { await v.unmount(); globalThis.fetch = before; localStorage.clear(); resetConvos(); realClock() })
    await advance(1800)
    const boss = v.el.querySelector('[data-first-use-agent="boss"]')!
    const strip = relation === 'above' ? '.hsof.side-t' : relation === 'left' ? '.hsof.side-l' : '.hsof:not(.side)'
    const expand = boss.querySelector(strip + ' .hire-expand')
    if (expand?.getAttribute('aria-expanded') === 'false') await click(expand)
    await click(boss.querySelector(strip + ' button.t-sol')); await advance(1200)
    const input = v.el.querySelector<HTMLInputElement>('.df-name')!
    await inAct(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'newcomer')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await click(v.el.querySelector('.sq.draft button.primary'))
    const beforeCamera = camera(v.el)
    assert.equal(requests[0]!.op, 'hire'); assert.equal(requests[0]!.parent, relation === 'below' ? 'boss' : null)
    assert.equal(requests[0]!.above, relation === 'above' ? 'boss' : undefined)
    const roots = (relation === 'below' ? [agent('boss', [agent('newcomer')])]
      : relation === 'above' ? [agent('newcomer', [agent('boss')])] : [agent('newcomer'), agent('boss')]) as unknown as TreePayload['roots']
    if (feedFirst) { await v.render(render(roots)); await advance(200) }
    await inAct(async () => { resolve({ node: 'newcomer' }); await flush() })
    // A queued reveal must also honor a setting changed before the card arrives.
    if (queued) await inAct(() => setHireAutoFocusOn(false))
    if (!feedFirst) await v.render(render(roots))
    await advance(3000)
    assert.equal(v.el.querySelector('.sq.draft'), null, 'success removes the draft')
    assert.ok(v.el.querySelector('[data-first-use-agent="newcomer"]'), 'the real node arrived')
    assert.equal(camera(v.el), beforeCamera, 'Off must not move the completion camera')
    assert.equal(v.el.querySelector('.sq.desk:not(.user)'), null, 'Off must not open the new desk')
    await inAct(() => setHireAutoFocusOn(true)); await advance(800)
    assert.equal(camera(v.el), beforeCamera, 'turning On does not revive an old completed hire')
  })
}

test('the default-on setting saves immediately and shares same-window and storage updates', async t => {
  localStorage.clear(); assert.equal(hireAutoFocusOn(), true)
  localStorage.setItem(KEY, 'invalid'); assert.equal(hireAutoFocusOn(), true)
  const v = await mountView(<><HireAutoFocusSetting /><HireAutoFocusSetting /></>, el => el)
  t.after(async () => { await v.unmount(); localStorage.clear() })
  const controls = [...v.el.querySelectorAll<HTMLInputElement>('input[role="switch"]')]
  assert.equal(controls.length, 2); assert.ok(controls.every(el => el.checked))
  await click(controls[0]!); assert.equal(localStorage.getItem(KEY), '0')
  assert.ok(controls.every(el => !el.checked))
  await inAct(() => {
    localStorage.setItem(KEY, '1')
    window.dispatchEvent(new window.StorageEvent('storage', { key: KEY, newValue: '1' }))
  })
  assert.ok(controls.every(el => el.checked))
})
