import './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { ToolChip } from '../src/canvas/desk'
import { localFileMenu } from '../src/canvas/localfile'
import { revealFileFromEvent } from '../src/canvas/shared'

function bridge(t: TestContext, value: object) {
  const old = Object.getOwnPropertyDescriptor(window, 'orgtreeDesktop')
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value })
  t.after(() => old ? Object.defineProperty(window, 'orgtreeDesktop', old)
    : delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop)
}

test('missing tool paths retain the attempted directory across read/write/edit/glob and harness tool names', async t => {
  bridge(t, { localFileStatus: async () => ({ ok: true, exists: false }) })
  const paths = ['C:\\synthetic\\missing\\Read.md', 'D:/synthetic/new/Write.md',
    '/synthetic/unknown/Edit.md', '//synthetic/share/Glob*.md', 'C:\\synthetic\\native\\view.txt']
  const names = ['Read', 'Write', 'Edit', 'Glob', 'mcp__filesystem__read_file']
  const v = await mountView(<>{paths.map((path, i) => <ToolChip key={path}
    t={{ id: `missing-${i}`, name: names[i], arg: path, file_paths: [{ path, link: true }] }} slug="org" nid="agent" />)}</>, el => el)
  t.after(() => v.unmount())
  await flush(3)
  const links = [...v.el.querySelectorAll<HTMLElement>('[data-local-path]')]
  assert.equal(links.length, paths.length)
  for (const [i, link] of links.entries()) {
    assert.equal(link.textContent, paths[i], 'the whole attempted path is visible, including its original separators')
    assert.equal(link.querySelector('.dim')?.textContent, paths[i].slice(0, Math.max(paths[i].lastIndexOf('/'), paths[i].lastIndexOf('\\')) + 1))
    assert.match(link.title, /not found|unavailable|unresolved/i)
    assert.ok(link.title.includes(paths[i]), 'full attempted path remains available on hover')
    assert.equal(link.getAttribute('aria-disabled'), 'true')
  }
})

test('a missing-file context menu keeps Copy path and copies the whole attempted path without file actions', async t => {
  bridge(t, { localFileStatus: async () => ({ ok: true, exists: false }) })
  const path = 'C:\\synthetic\\directory that does not exist\\missing.txt'
  const anchor = document.createElement('a'), copied: string[] = []
  const menu = await localFileMenu(anchor, path, async (_el, value) => { copied.push(value); return true })
  const entries = menu.filter(entry => entry !== 'sep')
  assert.equal(entries.some(entry => entry.label === 'Open' || entry.label === 'Show in folder'), false)
  const copy = entries.find(entry => entry.label === 'Copy path')
  assert.equal(!!copy && !copy.disabled, true, 'missing does not disable clipboard actions')
  copy?.onSelect?.()
  await flush(1)
  assert.deepEqual(copied, [path])
})

test('status failures still expose the exact path and offer the shared clipboard menu', async t => {
  bridge(t, { localFileStatus: async () => { throw Error('synthetic status unavailable') } })
  const path = 'C:/synthetic/blocked/file.txt'
  const v = await mountView(<ToolChip t={{ id: 'unknown', name: 'write_file', file_paths: [{ path, link: true }] }} slug="org" nid="agent" />, el => el)
  t.after(() => v.unmount())
  await flush(3)
  assert.equal(v.el.querySelector('[data-local-path]')?.textContent, path)
  const entries = (await localFileMenu(v.el, path, async () => true)).filter(e => e !== 'sep')
  assert.equal(entries.some(e => e.label === 'Copy path' && !e.disabled), true)
  assert.equal(entries.some(e => e.label === 'Open' || e.label === 'Show in folder'), false)
})

test('relative paths with no working directory are copyable but never passed to native file actions', async t => {
  const checked: string[] = [], revealed: string[] = []
  bridge(t, { localFileStatus: async (path: string) => { checked.push(path); return { ok: true, exists: true } },
    revealFile: async (path: string) => { revealed.push(path); return { ok: true } } })
  const path = '../unknown/same-name.txt'
  const v = await mountView(<ToolChip t={{ id: 'relative', name: 'read_file', file_paths: [{ path, link: false }] }} slug="org" nid="agent" />, el => el)
  t.after(() => v.unmount())
  const link = v.el.querySelector<HTMLElement>('[data-local-path]')
  assert.equal(!!link, true, 'unresolved relative path still owns a copy menu')
  assert.equal(link?.textContent, path)
  await inAct(() => link?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
  await flush(3)
  assert.equal([...document.querySelectorAll('.ctxmenu [role="menuitem"]')].some(e => e.textContent === 'Copy path'), true)
  revealFileFromEvent({ target: link, preventDefault() {} })
  assert.deepEqual(checked, [], 'no invented base directory')
  assert.deepEqual(revealed, [])
})

test('known missing links cannot reveal a file through the document click delegate', async t => {
  const revealed: string[] = []
  bridge(t, { localFileStatus: async () => ({ ok: true, exists: false }),
    revealFile: async (path: string) => { revealed.push(path); return { ok: true } } })
  const v = await mountView(<ToolChip t={{ id: 'click', name: 'Read', file_paths: [{ path: 'C:/synthetic/missing.txt', link: true }] }} slug="org" nid="agent" />, el => el)
  t.after(() => v.unmount())
  await flush(3)
  let prevented = false
  revealFileFromEvent({ target: v.el.querySelector('[data-local-path]'), preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.deepEqual(revealed, [], 'missing paths never masquerade as openable files')
})

test('resolved files keep the filename-only label, full-path title and existing file actions', async t => {
  bridge(t, { localFileStatus: async () => ({ ok: true, exists: true }) })
  const path = 'C:\\synthetic\\existing\\plan.md'
  const v = await mountView(<ToolChip t={{ id: 'existing', name: 'Read', file_paths: [{ path, link: true }] }} slug="org" nid="agent" />, el => el)
  t.after(() => v.unmount())
  await flush(3)
  const link = v.el.querySelector<HTMLElement>('[data-local-path]')!
  assert.equal(link.textContent, 'plan.md')
  assert.equal(link.title, `Show in folder — ${path}`)
  assert.deepEqual((await localFileMenu(link, path, async () => true)).filter(e => e !== 'sep').map(e => e.label),
    ['Open', 'Show in folder', 'Copy path', 'Copy file name'])
})

test('a created file is rechecked at tool completion and an older status response cannot hide it again', async t => {
  let finishOld!: (value: { ok: boolean; exists: boolean }) => void
  let calls = 0
  bridge(t, { localFileStatus: () => ++calls === 1 ? new Promise(resolve => { finishOld = resolve })
    : Promise.resolve({ ok: true, exists: true }) })
  const path = 'C:/synthetic/new/created.md'
  const chip = (ended_at?: string) => <ToolChip t={{ id: 'created', name: 'Write', ended_at,
    file_paths: [{ path, link: true }] }} slug="org" nid="agent" />
  const v = await mountView(chip(), el => el)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelector('[data-local-path]')?.textContent, path, 'unknown while the check is pending')
  await v.render(chip('2026-10-22T19:40:00Z'))
  await flush(3)
  assert.equal(v.el.querySelector('[data-local-path]')?.textContent, 'created.md')
  await inAct(() => finishOld({ ok: true, exists: false }))
  assert.equal(v.el.querySelector('[data-local-path]')?.textContent, 'created.md', 'the earlier result cannot replace current status')
})
