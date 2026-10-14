import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolChip } from '../src/canvas/desk'
import { fileUrl } from '../src/api'

const chip = { id: 'send-file-report', name: 'orgtree_send_file', arg: 'report.txt',
  input_seq: 23, writing_secs: 1.2,
  started_at: '2026-10-14T16:00:00Z', ended_at: '2026-10-14T16:00:00.031Z', result: 'Delivered report',
  file: { path: 'report.txt', name: 'report.txt', bytes: 2048, note: 'Exported report' } }

test('sent file has ordinary timed expandable row then an unchanged download card without clocks', async t => {
  const originalFetch = globalThis.fetch
  const reads: string[] = []
  const inputPath = '/api/orgs/org/nodes/worker/toolinput/23/send-file-report'
  globalThis.fetch = async (url, init) => {
    const pathname = new URL(String(url), 'http://localhost').pathname
    assert.equal(pathname, inputPath)
    assert.equal(init?.method ?? 'GET', 'GET')
    reads.push(pathname)
    return new Response(JSON.stringify({ input: { path: 'report.txt', note: 'Exported report' } }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const view = await mountView(<ToolChip t={chip} slug="org" nid="worker" />, el => el)
  t.after(() => view.unmount())
  const row = view.el.querySelector('.tline')!
  const card = view.el.querySelector<HTMLAnchorElement>('a.filecard')!
  assert.ok(row)
  assert.match(row.textContent ?? '', /orgtree_send_file/)
  assert.ok(row.querySelector('[aria-label="written in 1.2s"]'))
  assert.ok(row.querySelector('[aria-label="ran for 31 ms"]'))
  assert.equal(row.parentElement?.nextElementSibling, card)
  assert.equal(card.querySelector('.tool-writing-time,.tool-exec-time,.tool-running'), null)
  assert.equal(card.querySelector('.fc-name')?.textContent, 'report.txt')
  assert.match(card.textContent ?? '', /2 KB/)
  assert.equal(card.querySelector('.fc-note')?.textContent, 'Exported report')
  assert.equal(card.getAttribute('href'), fileUrl('org', 'worker', 'report.txt'))
  assert.equal(card.download, 'report.txt')
  assert.equal(view.el.querySelector('.toolinput'), null)
  assert.deepEqual(reads, [], 'retained input is fetched only after expansion')
  await inAct(() => (row as HTMLElement).click()); await flush()
  assert.match(view.el.querySelector('.toolinput')?.textContent ?? '', /report.txt/)
  assert.deepEqual(reads, [inputPath])
  assert.match(view.el.querySelector('.respre')?.textContent ?? '', /Delivered report/)
  assert.equal(card.querySelector('.toolinput,.respre'), null)
})

test('sent image keeps its picture, caption and download link while timings stay on the tool row', async t => {
  const file = { path: 'shot.png', name: 'shot.png', bytes: 194560, note: 'Synthetic preview' }
  const view = await mountView(<ToolChip t={{ ...chip, id: 'send-image-preview', arg: file.name, file }} slug="org" nid="worker" />, el => el)
  t.after(() => view.unmount())
  const row = view.el.querySelector('.tline')!
  const card = view.el.querySelector('.imgcard')!
  assert.ok(row)
  assert.ok(row.querySelector('[aria-label="ran for 31 ms"]'))
  assert.equal(row.parentElement?.nextElementSibling, card)
  assert.equal(card.querySelector('.tool-writing-time,.tool-exec-time,.tool-running'), null)
  const image = card.querySelector<HTMLImageElement>('.imgcard-img')!
  assert.equal(image.alt, file.name)
  assert.equal(image.getAttribute('src'), fileUrl('org', 'worker', file.path))
  assert.equal(card.querySelector('.fc-name')?.textContent, file.name)
  assert.match(card.textContent ?? '', /190 KB/)
  assert.equal(card.querySelector('.fc-note')?.textContent, file.note)
  const link = card.querySelector<HTMLAnchorElement>('a.fdl')!
  assert.equal(link.getAttribute('href'), fileUrl('org', 'worker', file.path))
  assert.equal(link.download, file.name)
  await inAct(() => image.click()); await flush()
  assert.ok(document.querySelector('.lb-overlay'), 'same image opens the existing lightbox')
  await inAct(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
})

test('unknown-writing sent files keep native links without inventing a card menu', async t => {
  const view = await mountView(<ToolChip t={{ ...chip, id: 'send-unknown', writing_secs: undefined }} slug="org" nid="worker" />, el => el)
  t.after(() => view.unmount())
  const row = view.el.querySelector('.tline')!
  assert.ok(row)
  assert.equal(row.querySelector('.tool-writing-time'), null)
  assert.ok(row.querySelector('[aria-label="ran for 31 ms"]'))
  const card = view.el.querySelector('a.filecard')!
  const ev = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
  await inAct(() => card.dispatchEvent(ev)); await flush()
  assert.equal(ev.defaultPrevented, false)
  assert.equal(document.querySelector('.ctxmenu'), null)
})

test('failed sent file stays an ordinary error row without a delivery card', async t => {
  const view = await mountView(<ToolChip t={{ ...chip, id: 'send-error', error: 'refused' }} slug="org" nid="worker" />, el => el)
  t.after(() => view.unmount())
  assert.ok(view.el.querySelector('.tline'))
  assert.match(view.el.querySelector('.terrtxt')?.textContent ?? '', /refused/)
  assert.equal(view.el.querySelector('.filecard,.imgcard'), null)
})

test('download card retains its existing native link menu without activating or folding the call', async t => {
  const view = await mountView(<ToolChip t={{ ...chip, id: 'send-native-link' }} slug="org" nid="worker" />, el => el)
  t.after(() => view.unmount())
  const card = view.el.querySelector<HTMLAnchorElement>('a.filecard')!
  assert.equal(card.getAttribute('href'), fileUrl('org', 'worker', 'report.txt'))
  assert.equal(card.download, 'report.txt')
  const ev = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
  await inAct(() => card.dispatchEvent(ev)); await flush()
  assert.equal(ev.defaultPrevented, false)
  assert.equal(document.querySelector('.ctxmenu'), null)
  assert.equal(view.el.querySelector('.toolinput'), null)
})
