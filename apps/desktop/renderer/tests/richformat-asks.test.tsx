// C15-C18 (spec §2.2): answered-card typed answer and note, credit/scope request
// reasons, MCP elicitation message, custom app description.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AnsweredCard } from '../src/events/answered'
import { AskCard } from '../src/canvas/asks'
import type { AskInfo } from '../src/types'
import { ORG, RICH, expectRich, onOpen, refs, world } from './fixtures/richformat'

const mount = async (node: React.ReactNode) => {
  const view = await mountView(node, el => el)
  await inAct(async () => { await flush(3) })
  return view
}

test('RT-C15 an answered card renders the typed answer and the note as rich text', async t => {
  const view = await mount(<AnsweredCard dismissed={false} note={RICH} world={world} onOpen={onOpen} org={ORG}
    questions={[{ label: 'Q', question: 'Which?', options: [], multi: false, selected: [], typed: RICH }]} />)
  t.after(() => view.unmount())
  expectRich(view.el.querySelector('.answered-typed')!)
  expectRich(view.el.querySelector('.answered-note')!)
})

const noop = () => {}
const base = { id: 'a1', node: 'alpha', status: 'open', at: '2026-11-03T10:00:00Z' }

test('RT-C16 a credit request reason renders rich text (legacy credit card and batch credits tab)', async t => {
  const legacy = await mount(<AskCard ask={{ ...base, kind: 'credit', old: 2, new: 4, reason: RICH } as unknown as AskInfo}
    slug={ORG} toast={noop} refs={refs} seat={4} committed={1} />)
  t.after(() => legacy.unmount())
  expectRich(legacy.el.querySelector('.ask-credit-side .ask-q.dim')!)
  const batch = await mount(<AskCard ask={{ ...base, id: 'a2', kind: 'batch', tabs: [{ kind: 'credits', label: 'Credits', old: 2, new: 4, reason: RICH }] } as unknown as AskInfo}
    slug={ORG} toast={noop} refs={refs} seat={4} committed={1} />)
  t.after(() => batch.unmount())
  expectRich(batch.el.querySelector('.ask-credit-side .ask-q.dim')!)
})

test('RT-C16 a scope request reason renders rich text', async t => {
  const view = await mount(<AskCard ask={{ ...base, id: 'a3', kind: 'batch', tabs: [{ kind: 'scope', label: 'Scope: Read /x', reason: RICH, item: { kind: 'dir', path: '/x' } }] } as unknown as AskInfo}
    slug={ORG} toast={noop} refs={refs} />)
  t.after(() => view.unmount())
  const reason = [...view.el.querySelectorAll('.ask-q.dim')].find(e => (e.textContent ?? '').includes('bold'))
  assert.ok(reason, 'the scope reason rendered')
  expectRich(reason!)
})

test('RT-C17 an MCP elicitation message renders rich text', async t => {
  const view = await mount(<AskCard ask={{ ...base, id: 'a4', kind: 'elicitation', elicitation: { server: 'srv', message: RICH, mode: 'form',
    schema: { properties: {} }, expires_at: '2026-11-04T00:00:00Z' } } as unknown as AskInfo} slug={ORG} toast={noop} refs={refs} />)
  t.after(() => view.unmount())
  expectRich(view.el.querySelector('.elicitation-card .ask-q')!)
})
