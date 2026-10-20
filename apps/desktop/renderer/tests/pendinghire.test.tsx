import { advance, FakeServer, flush, installFetch, mountView, realClock, useFakeClock } from './harness'
import { act } from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import type { TreePayload, OpResult } from '../src/types'

const noop = () => {}
const tree = { slug: 'pending-hire', name: 'Pending hire', roots: [], dirs: [], tiers: { sol: 2 },
  default_top_grant: 12, max_top_grant: 100, cascade_hire: true,
  audiences: [], audience_requests: [], credit_requests: [], user_inbox_count: 0,
  default_visibility: 'team', default_tools: {},
} as unknown as TreePayload
const born = { id: 'new-agent', title: 'new-agent', tier: 'sol', state: 'live', children: [],
  seat: 2, grant: 12, free: 12, generation: 0, scope: { tools: {}, add_dirs: [] },
  turns: [], audiences_held: [], lineage: [], last_denials: [], frozen: null }
async function click(el: Element | null) {
  assert.ok(el)
  await act(async () => { (el as HTMLButtonElement).click(); await flush() })
}
async function setup(t: test.TestContext) {
  useFakeClock(); localStorage.clear(); installFetch(new FakeServer())
  let resolve!: (r: OpResult) => void, reject!: (e: Error) => void, calls = 0
  const request = new Promise<OpResult>((yes, no) => { resolve = yes; reject = no })
  const messages: string[] = []
  const render = (data = tree) => <OrgCanvas tree={data} slug={tree.slug} mailEvt={null}
    toast={s => messages.push(...s)} op={() => { calls++; return request }} />
  const v = await mountView(render(), el => el)
  t.after(async () => { await v.unmount(); resetConvos(); realClock() })
  await click(v.el.querySelector('.sq.user button.t-sol')); await advance(1200)
  const input = v.el.querySelector<HTMLInputElement>('.df-name')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'new-agent')
    input.dispatchEvent(new Event('input', { bubbles: true })); await flush()
  })
  const pos = (v.el.querySelector('.sq.draft') as HTMLElement).style.transform
  await click(v.el.querySelector('.df-foot button.primary'))
  return { v, render, resolve, reject, messages, pos, calls: () => calls }
}
test('pending hire remains disabled through response-to-feed gap and swaps without movement', async t => {
  const {v,render,resolve,pos,calls} = await setup(t)
  assert.equal(v.el.querySelector('.sq.draft')?.getAttribute('aria-busy'), 'true')
  assert.equal(v.el.querySelector<HTMLButtonElement>('.df-foot button.primary')?.disabled, true)
  await click(v.el.querySelector('.df-foot button.primary')); assert.equal(calls(), 1)
  await act(async () => { resolve({node:'new-agent'}); await flush() })
  assert.ok(v.el.querySelector('.sq.draft'), 'placeholder stays after response until feed arrives')
  await advance(11000)
  assert.equal((v.el.querySelector('.sq.draft') as HTMLElement).style.transform, pos)
  await v.render(render({...tree, roots:[born]} as unknown as TreePayload))
  assert.ok(!v.el.querySelector('.sq.draft'))
  const card = () => [...v.el.querySelectorAll<HTMLElement>('.sq')].find(el => el.querySelector('.name')?.textContent === 'new-agent')!
  assert.ok(card(), 'feed paints real card')
  assert.equal(card().style.transform, pos, 'first painted position equals placeholder')
  await advance(160)
  assert.equal(card().style.transform, pos, 'no spring movement after replacement')
})
test('a refused hire restores the same editable draft and fields', async t => {
  const {v,reject,messages,pos} = await setup(t)
  await act(async () => { reject(new Error('credits refused')); await flush() })
  assert.equal(v.el.querySelector('.sq.draft')?.getAttribute('aria-busy'), 'false')
  assert.equal(v.el.querySelector<HTMLButtonElement>('.df-foot button.primary')?.disabled, false)
  assert.equal(v.el.querySelector<HTMLInputElement>('.df-name')?.value, 'new-agent')
  assert.equal((v.el.querySelector('.sq.draft') as HTMLElement).style.transform, pos)
  assert.ok(messages.some(s => s.includes('credits refused')))
})
test('feed preceding response still hands the card the placeholder position', async t => {
  const {v,render,resolve,pos} = await setup(t)
  await v.render(render({...tree, roots:[born]} as unknown as TreePayload))
  await act(async () => { resolve({node:'new-agent'}); await flush() })
  assert.ok(!v.el.querySelector('.sq.draft'))
  const card = [...v.el.querySelectorAll<HTMLElement>('.sq')].find(el => el.querySelector('.name')?.textContent === 'new-agent')!
  assert.equal(card.style.transform, pos)
})
