import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ImportSettings } from '../src/canvas/importsettings'

const organizations = [
  { slug: 'large', name: 'Large organization', nodes: 522, native_context: Array.from({ length: 522 }, (_, i) =>
    ({ node: `agent-${i}`, provider: 'claude', status: 'held', reason: 'Session requires review.' })) },
  { slug: 'small', name: 'Small organization', nodes: 1, native_context: [] },
  { slug: 'empty', name: 'Empty organization', nodes: 0, conflict: 'Already exists.' },
]

async function click(el: HTMLElement, label: string) {
  const button = [...el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)
  assert.ok(button, label)
  await inAct(async () => { button.click(); await flush(8) })
}

async function fixture(response: () => Promise<Response>) {
  const original = globalThis.fetch, scroll = HTMLElement.prototype.scrollIntoView
  const scrolled: HTMLElement[] = [], calls: string[] = []
  HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this) }
  let previewFailure = false
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/orgs') return new Response('[]')
    assert.equal(init?.method, 'POST')
    calls.push(String(url))
    if (String(url).endsWith('/preview') && !previewFailure)
      return new Response(JSON.stringify({ organizations, warnings: [] }))
    return response()
  }
  const v = await mountView(<ImportSettings />, el => el)
  await inAct(() => {
    const input = v.el.querySelector<HTMLInputElement>('[aria-label="V1 data folder"]')!
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'C:/synthetic-import')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return { ...v, calls, scrolled, failPreview: () => { previewFailure = true },
    preview: () => click(v.el, 'Preview organizations'),
    copy: async () => {
      await inAct(() => { v.el.querySelector<HTMLInputElement>('[aria-label="Acknowledge duplicate work"]')!.click() })
      await click(v.el, 'Copy selected organizations')
    },
    close: async () => { await v.unmount(); globalThis.fetch = original; HTMLElement.prototype.scrollIntoView = scroll },
  }
}

test('all organization summaries remain visible while 522 native agent details are closed by default', async () => {
  const v = await fixture(async () => new Response('{}'))
  try {
    await v.preview()
    for (const org of organizations) assert.match(v.el.textContent!, new RegExp(org.name))
    assert.match(v.el.textContent!, /522 agents/)
    assert.ok([...v.el.querySelectorAll('p')].some(p => p.textContent === '1 agent'))
    assert.match(v.el.textContent!, /0 agents/)
    const details = [...v.el.querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent === 'Agent details (522)')!
    assert.ok(details)
    assert.equal(details.open, false)
    assert.equal(details.querySelectorAll('b').length, 522, 'details remain available, not discarded')
    details.open = true
    assert.equal(details.open, true)
    assert.match(details.textContent!, /agent-521/)
    const boxes = v.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    assert.equal(boxes[0].checked, true)
    assert.equal(boxes[2].checked, false)
    assert.equal(boxes[2].disabled, true)
    assert.equal(v.scrolled.length, 0, 'successful preview does not spuriously focus an error')
  } finally { await v.close() }
})

for (const kind of ['HTTP', 'network'] as const) test(`${kind} import failure reaches the focused feedback after the action with exact error text`, async () => {
  const message = kind === 'HTTP' ? 'Links and reparse points are not imported: C:/synthetic/link' : 'Failed to fetch'
  const v = await fixture(async () => {
    if (kind === 'network') throw new TypeError(message)
    return new Response(JSON.stringify({ detail: message }), { status: 422 })
  })
  try {
    await v.preview(); await v.copy()
    const feedback = v.el.querySelector<HTMLElement>('[role="alert"]')!
    assert.match(feedback.textContent!, /Import failed/)
    assert.ok(feedback.textContent!.includes(message))
    assert.equal(document.activeElement, feedback)
    assert.equal(v.scrolled.at(-1), feedback)
    const copy = [...v.el.querySelectorAll('button')].find(b => b.textContent === 'Copy selected organizations')!
    assert.ok(copy.compareDocumentPosition(feedback) & Node.DOCUMENT_POSITION_FOLLOWING)
    assert.match(feedback.textContent!, /lost response can leave completed copies/)
    assert.doesNotMatch(feedback.textContent!, /No organizations imported/)
    assert.equal(v.calls.filter(c => !c.endsWith('/preview')).length, 1, 'no automatic retry')
  } finally { await v.close() }
})

test('Preview failure identifies the action and focuses its exact server detail', async () => {
  const v = await fixture(async () => new Response(JSON.stringify({ detail: 'Source changed; preview again.' }), { status: 409 }))
  try {
    v.failPreview(); await v.preview()
    const feedback = v.el.querySelector<HTMLElement>('[role="alert"]')!
    assert.match(feedback.textContent!, /Preview failed/)
    assert.match(feedback.textContent!, /Source changed; preview again/)
    assert.equal(document.activeElement, feedback)
    assert.equal(v.scrolled.at(-1), feedback)
  } finally { await v.close() }
})

for (const count of [0, 1]) test(`partial response with ${count} committed copies exposes failures, focuses result and prevents blind retry`, async () => {
  const v = await fixture(async () => new Response(JSON.stringify({ imported: count ? [{ slug: 'large', name: 'Large organization' }] : [],
    warnings: [], failed: [{ slug: 'small', error: 'Copy refused.', not_attempted: ['empty'] }] })))
  try {
    await v.preview(); await v.copy()
    const feedback = v.el.querySelector<HTMLElement>('[role="status"]')!
    assert.match(feedback.textContent!, /Import finished with errors/)
    assert.match(feedback.textContent!, count ? /Imported Large organization/ : /No organizations imported/)
    assert.match(feedback.textContent!, /small: Copy refused/)
    assert.match(feedback.textContent!, /Not copied: empty/)
    assert.equal(document.activeElement, feedback)
    assert.equal(v.scrolled.at(-1), feedback)
    assert.ok(![...v.el.querySelectorAll('button')].some(b => b.textContent === 'Copy selected organizations'))
  } finally { await v.close() }
})
