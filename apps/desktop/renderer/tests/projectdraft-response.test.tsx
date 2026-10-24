import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import type { OpRequest, OpResult, TreePayload } from '../src/types'

const tree = { slug: 'project-response', name: 'Synthetic', roots: [], dirs: [], tiers: { sol: 2 },
  default_top_grant: 12, max_top_grant: 100, cascade_hire: true,
  audiences: [], audience_requests: [], credit_requests: [], user_inbox_count: 0,
  default_visibility: 'team', default_tools: {},
} as unknown as TreePayload
async function click(el: Element | null) {
  assert.ok(!!el, 'click target exists')
  await inAct(async () => { (el as HTMLElement).click(); await flush() })
}
async function type(el: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  assert.ok(!!el, 'input exists')
  await inAct(() => {
    const proto = el!.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function setup(t: test.TestContext) {
  useFakeClock(); localStorage.clear(); installFetch(new FakeServer())
  const requests: Array<{ body: OpRequest; resolve: (value: OpResult) => void; reject: (error: Error) => void }> = []
  const op = (body: OpRequest) => new Promise<OpResult>((resolve, reject) => requests.push({ body, resolve, reject }))
  const render = (slug = tree.slug) => <OrgCanvas tree={{ ...tree, slug }} slug={slug} mailEvt={null} toast={() => {}} op={op} />
  const view = await mountView(render(), el => el)
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  const name = () => view.el.querySelector<HTMLInputElement>('.sq.draft .df-name')
  const summary = () => view.el.querySelector<HTMLTextAreaElement>('.sq.draft .df-charter')
  const primary = () => view.el.querySelector<HTMLButtonElement>('.sq.draft .df-foot .primary')
  const cancel = () => click(view.el.querySelector('.sq.draft .df-foot button:not(.primary)'))
  const project = async (n: string, text: string) => {
    await click(view.el.querySelector('.sq.user button.project-token')); await advance(1200)
    await type(name(), n); await type(summary(), text)
  }
  const submit = () => click(primary())
  await project('project-a', 'Summary A')
  return { view, requests, render, name, summary, primary, cancel, project, submit }
}

test('late project success preserves replacement agent name, charter and staged permissions', async t => {
  const c = await setup(t); await c.submit(); await c.cancel()
  await click(c.view.el.querySelector('.sq.user button.t-sol')); await advance(1200)
  await type(c.name(), 'agent-b'); await type(c.summary(), 'Unsaved charter B')
  await click(c.view.el.querySelector('.sq.draft .df-gear'))
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Visible agents"]')!
  const chosen = [...select.options].find(o => o.value !== select.value)!.value
  await inAct(() => { select.value = chosen; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await click(document.querySelector('.settings [aria-label="Close draft settings"]')!)
  await inAct(async () => { c.requests[0]!.resolve({ node: 'project-a' }); await flush() })
  assert.equal(c.name()?.value, 'agent-b')
  assert.equal(c.summary()?.value, 'Unsaved charter B')
  await click(c.view.el.querySelector('.sq.draft .df-gear'))
  assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="Visible agents"]')?.value, chosen)
})

test('late project success preserves a replacement project and its pending request', async t => {
  const c = await setup(t); await c.submit(); await c.cancel()
  await c.project('project-b', 'Summary B'); await c.submit()
  await inAct(async () => { c.requests[0]!.resolve({ node: 'project-a' }); await flush() })
  assert.equal(c.name()?.value, 'project-b')
  assert.equal(c.summary()?.value, 'Summary B')
  assert.equal(c.primary()?.disabled, true, 'B still owns its pending request')
  await inAct(async () => { c.requests[1]!.resolve({ node: 'project-b' }); await flush() })
  assert.equal(c.view.el.querySelector('.sq.draft') === null, true, 'B clears only on its own response')
})

test('pending project blocks repeated Create and Enter while Cancel stays usable', async t => {
  const c = await setup(t)
  await inAct(() => {
    c.primary()!.click()
    c.name()!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    c.primary()!.click()
  })
  assert.equal(c.requests.length, 1, 'guard repeat submissions before a render too')
  assert.equal(c.primary()?.disabled, true)
  assert.equal(c.view.el.querySelector<HTMLButtonElement>('.df-foot button:not(.primary)')?.disabled, false)
  await c.cancel()
  assert.equal(c.view.el.querySelector('.sq.draft') === null, true)
})

test('a stale failure cannot re-enable a replacement project request', async t => {
  const c = await setup(t); await c.submit(); await c.cancel()
  await c.project('project-b', 'Summary B'); await c.submit()
  await inAct(async () => { c.requests[0]!.reject(new Error('old refusal')); await flush() })
  assert.equal(c.name()?.value, 'project-b')
  assert.equal(c.primary()?.disabled, true)
})

test('a current refusal keeps the form fields and permits a corrected retry', async t => {
  const c = await setup(t); await c.submit()
  await inAct(async () => { c.requests[0]!.reject(new Error('name refused')); await flush() })
  assert.equal(c.name()?.value, 'project-a'); assert.equal(c.summary()?.value, 'Summary A')
  assert.equal(c.primary()?.disabled, false)
  await type(c.name(), 'corrected'); await c.submit()
  assert.equal(c.requests.length, 2); assert.equal(c.requests[1]!.body.name, 'corrected')
})

test('an old org response cannot clear a new org draft when the canvas instance is reused', async t => {
  const c = await setup(t); await c.submit()
  await c.view.render(c.render('other-org')); await c.cancel()
  await c.project('project-b', 'Other org summary')
  await inAct(async () => { c.requests[0]!.resolve({ node: 'project-a' }); await flush() })
  assert.equal(c.name()?.value, 'project-b')
  assert.equal(c.summary()?.value, 'Other org summary')
})
