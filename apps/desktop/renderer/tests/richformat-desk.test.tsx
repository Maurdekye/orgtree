// C1 and C3 (spec §2.2): desk thought body and compaction summary. (C2, slash-command
// output, was withdrawn by the spec author: CLI machine output stays mention-inert, rev 1.1 D1.)
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Msg } from '../src/canvas/desk'
import type { ChatMessage } from '../src/types'
import { ORG, RICH, expectRich, refs } from './fixtures/richformat'

const mount = async (m: ChatMessage) => {
  const view = await mountView(<Msg m={m} slug={ORG} nid="alpha" refs={refs} />, el => el)
  await inAct(async () => { await flush(2) })
  return view
}

test('RT-C1 an expanded thought renders Markdown, LaTeX and mentions', async t => {
  const view = await mount({ role: 'assistant', text: 'done', thinking: RICH, think_secs: 5, seq: 1, thinking_event_id: 'th1' } as ChatMessage)
  t.after(() => view.unmount())
  await inAct(async () => { (view.el.querySelector('button.thoughtline') as HTMLButtonElement).click(); await flush(2) })
  const body = view.el.querySelector('.thoughtbody')
  assert.ok(body, 'the thought opened')
  expectRich(body!)
})

test('RT-C3 an opened compaction summary renders Markdown, LaTeX and mentions, and still copies its source', async t => {
  const view = await mount({ role: 'system', text: 'Context compacted', summary: RICH, seq: 3 } as ChatMessage)
  t.after(() => view.unmount())
  await inAct(async () => { (view.el.querySelector('.msg.sys.click') as HTMLElement).click(); await flush(2) })
  const body = view.el.querySelector('.compaction-summary')
  assert.ok(body, 'the summary opened as a rendered block')
  assert.equal(body!.tagName === 'PRE', false, 'no longer a <pre>')
  expectRich(body!)
  assert.ok(view.el.querySelector('.msg.sys button[aria-label="Copy summary"]'), 'the copy control remains')
})
