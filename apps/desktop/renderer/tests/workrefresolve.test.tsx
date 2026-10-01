import { mountView, inAct } from './harness'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RefProse } from '../src/canvas/reflinks'
import { workReferenceCandidates } from '../src/canvas/workrefs'
import { forgetWorkInflight } from '../src/api'

const reply = (references: unknown[]) => ({ status: 200, ok: true,
  headers: { get: () => null }, json: async () => ({ references }) }) as Response

test('prose candidates keep exact mention boundaries, including single-word slugs', () => {
  const text = 'ticket old-ticket old-ticket-long. `quoted` /path/item host.old-ticket a_b @item:o/canonical'
  assert.deepEqual(workReferenceCandidates(text), ['ticket','old-ticket','old-ticket-long','quoted'])
})

test('mounted foreground prose resolves historical names and canonical absence on demand', async t => {
  forgetWorkInflight()
  const calls: string[] = []
  globalThis.fetch = async url => {
    calls.push(String(url))
    return reply([{ slug: 'old-ticket', title: 'Historical title' }])
  }
  const picked: string[] = []
  const view = await mountView(<RefProse text="old-ticket and @item:org/missing"
    world={{ org: 'org', boundedItems: true, workRevision: 'one' }}
    index={new Map()} onPick={id => picked.push(id)} onOpen={() => {}} />, el => el)
  t.after(() => view.unmount())
  assert.equal(calls.length, 1)
  assert.match(decodeURIComponent(calls[0]), /names=old-ticket,and,missing/)
  const link = view.el.querySelector('.docket-ref') as HTMLElement
  assert.ok(link)
  await inAct(() => link.click())
  assert.deepEqual(picked, ['old-ticket'])
  assert.match(view.el.textContent ?? '', /missing/)
  assert.match(view.el.innerHTML, /no docket item named missing/)
})

test('late answers cannot cross org changes; full-index callers do no historical reads', async t => {
  forgetWorkInflight()
  const pending: ((r: Response) => void)[] = []
  globalThis.fetch = () => new Promise(resolve => pending.push(resolve))
  const render = (org: string, boundedItems = true) => <RefProse text="old-ticket"
    world={{ org, boundedItems }} index={new Map()} onPick={() => {}} />
  const view = await mountView(render('first'), el => el)
  t.after(() => view.unmount())
  await view.render(render('second'))
  await inAct(async () => { pending[0](reply([{ slug: 'old-ticket', title: 'Wrong org' }])) })
  assert.equal(view.el.querySelector('.docket-ref'), null)
  await inAct(async () => { pending[1](reply([])) })
  assert.equal(view.el.querySelector('.docket-ref'), null)
  await view.render(render('legacy', false))
  assert.equal(pending.length, 2)
})
