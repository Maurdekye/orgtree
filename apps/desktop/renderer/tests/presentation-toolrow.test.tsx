import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolChip } from '../src/canvas/desk'
import { PresentationCard } from '../src/canvas/docs'

const doc = { id: 'report', title: 'Verification report' }
const retainedInput = { title: doc.title, body: 'Plan body' }
const chip = { id: 'present-report', name: 'orgtree_present', arg: doc.title, input_seq: 17,
  presentation: doc, writing_secs: 1.2, started_at: '2026-10-14T16:00:00Z', ended_at: '2026-10-14T16:00:00.031Z', result: 'Presented report' }
const labels = () => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map(el => el.textContent)
async function right(el: Element) {
  await inAct(() => el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
  await flush()
}

test('presentation has an ordinary timed tool row then a separate title-only card with normal fold behavior', async t => {
  const originalFetch = globalThis.fetch
  const reads: string[] = []
  const inputPath = '/api/orgs/org/nodes/worker/toolinput/17/present-report'
  globalThis.fetch = async (url, init) => {
    const pathname = new URL(String(url), 'http://localhost').pathname
    assert.equal(pathname, inputPath)
    assert.equal(init?.method ?? 'GET', 'GET')
    reads.push(pathname)
    return new Response(JSON.stringify({ input: retainedInput }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const opened: string[] = []
  const view = await mountView(<ToolChip t={chip} slug="org" nid="worker" onOpenDoc={id => opened.push(id)} />, el => el)
  t.after(() => view.unmount())
  const row = view.el.querySelector('.tline')!
  const card = view.el.querySelector('.presentation-chat-card')!
  assert.ok(row)
  assert.match(row.textContent ?? '', /orgtree_present/)
  assert.ok(row.querySelector('[aria-label="written in 1.2s"]'))
  assert.ok(row.querySelector('[aria-label="ran for 31 ms"]'))
  assert.equal(row.parentElement?.nextElementSibling, card)
  assert.equal(card.textContent, doc.title)
  assert.equal(card.querySelector('.tool-writing-time,.tool-exec-time,.tool-running'), null)
  assert.equal(view.el.querySelector('.toolinput'), null)
  assert.deepEqual(reads, [], 'retained input is fetched only after expansion')
  await inAct(() => (row as HTMLElement).click()); await flush()
  assert.match(view.el.querySelector('.toolinput')?.textContent ?? '', /Plan body/)
  assert.deepEqual(reads, [inputPath])
  assert.deepEqual(opened, [])
  await inAct(() => (card as HTMLElement).click())
  assert.deepEqual(opened, [doc.id])
  assert.deepEqual(reads, [inputPath], 'opening the separate card does not refetch call details')
})

test('presentation without a writing observation keeps only the execution time in its tool line', async t => {
  const view = await mountView(<ToolChip t={{ ...chip, writing_secs: undefined }} slug="org" nid="worker" onOpenDoc={() => {}} />, el => el)
  t.after(() => view.unmount())
  const row = view.el.querySelector('.tline')!
  assert.ok(row)
  assert.equal(row.querySelector('.tool-writing-time'), null)
  assert.ok(row.querySelector('[aria-label="ran for 31 ms"]'))
  assert.equal(view.el.querySelector('.presentation-chat-card')?.textContent, doc.title)
})

test('transcript title card uses exactly the desk document card menu for markdown and HTML', async t => {
  const opened: string[] = []
  const render = (format?: 'html') => <>
    <ToolChip t={{ ...chip, presentation: { ...doc, format } }} slug="org" nid="worker" onOpenDoc={id => opened.push(id)} />
    <PresentationCard slug="org" doc={{ ...doc, format }} className="doc-badge" direct onOpen={id => opened.push(id)}>{doc.title}</PresentationCard>
  </>
  const view = await mountView(render(), el => el)
  t.after(() => view.unmount())
  for (const format of [undefined, 'html'] as const) {
    await view.render(render(format))
    await right(view.el.querySelector('.doc-badge')!)
    const expected = labels()
    assert.ok(expected.includes('Copy title'))
    assert.ok(expected.includes(format === 'html' ? 'Download HTML prototype' : 'Download as Markdown'))
    await right(view.el.querySelector('.presentation-chat-card')!)
    assert.deepEqual(labels(), expected)
    assert.deepEqual(opened, [], 'right-click opens neither document')
    await inAct(() => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent === 'Open reader')!.click())
    assert.deepEqual(opened.splice(0), [doc.id])
  }
})

test('failed presentation remains an ordinary error tool row without a title card', async t => {
  const view = await mountView(<ToolChip t={{ ...chip, error: 'refused' }} slug="org" nid="worker" onOpenDoc={() => {}} />, el => el)
  t.after(() => view.unmount())
  assert.ok(view.el.querySelector('.tline'))
  assert.match(view.el.querySelector('.terrtxt')?.textContent ?? '', /refused/)
  assert.equal(view.el.querySelector('.presentation-chat-card'), null)
})
