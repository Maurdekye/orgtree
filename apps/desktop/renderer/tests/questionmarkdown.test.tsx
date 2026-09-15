import test from 'node:test'
import assert from 'node:assert/strict'
import { AskCard } from '../src/canvas/asks'
import type { AskInfo } from '../src/types'
import { mountView, StrictMode } from './harness'

const card = (question: string, options?: { label: string; description?: string }[]) =>
  <StrictMode><AskCard ask={{
    id: 'markdown-question', node: 'agent', kind: 'question', status: 'open',
    question, options,
  } as AskInfo} slug="orgtree" toast={() => {}} /></StrictMode>

test('question bodies and options use the shared sanitized Markdown renderer', async (t) => {
  const view = await mountView(card(
    '# Heading\n\n- **bold** and `code`\n- [link](https://example.test)\n\n> quote\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst value = 1\n```\n\nSync<float3>',
    [{ label: '**Safe choice**', description: 'A `short` description' }]), (e) => e)
  t.after(() => view.unmount())

  const body = view.el.querySelector('.ask-q') as HTMLElement
  assert.ok(body.querySelector('h1'))
  assert.ok(body.querySelector('ul'))
  assert.ok(body.querySelector('strong'))
  assert.ok(body.querySelector('code'))
  assert.ok(body.querySelector('a[href^="https://example.test"]'))
  assert.ok(body.querySelector('blockquote'))
  assert.ok(body.querySelector('table'))
  assert.ok(body.querySelector('pre'))
  assert.match(body.textContent ?? '', /Sync<float3>/)
  assert.equal(body.querySelector('script'), null)

  const option = view.el.querySelector('.ask-option-label') as HTMLElement
  const description = view.el.querySelector('.ask-option-description') as HTMLElement
  assert.ok(option.querySelector('strong'))
  assert.ok(description.querySelector('code'))
})
