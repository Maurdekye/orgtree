import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { ToolChip } from '../src/canvas/desk'

test('tool file links show only the filename, expose the full path on hover, and replace a duplicate truncated argument', async t => {
  const path = 'C:\\Users\\ncola_k8bx\\AppData\\Roaming\\Orgtree v2\\data\\scratch\\orgtree\\agent-tooltip-luna\\CLAUDE.md'
  const view = await mountView(<ToolChip t={{ id: 'read-1', name: 'Read', arg: path.slice(0, 90),
    file_paths: [{ path, link: true }, { path: 'C:\\workspace\\docs\\SKILL.md', link: true }] }} slug="org" nid="agent" />, el => el)
  t.after(() => view.unmount())
  const line = view.el.querySelector('.tline')!
  const links = Array.from(line.querySelectorAll<HTMLAnchorElement>('a[data-local-path]'))
  assert.equal(links.length, 2, 'each explicit path remains an app local-file link')
  assert.equal(links[0].getAttribute('data-local-path'), path)
  assert.equal(links[0].classList.contains('local-file'), true)
  assert.equal(links[0].textContent, 'CLAUDE.md', 'the link label has no leading separator')
  assert.equal(links[0].title, `Show in folder — ${path}`)
  assert.equal(links[1].textContent, 'SKILL.md', 'the SKILL.md link label has no leading separator')
  assert.equal(links[1].title, 'Show in folder — C:\\workspace\\docs\\SKILL.md')
  assert.equal(line.querySelector('.targ') === null, true, 'the path is not repeated in the truncated argument')
  assert.ok(line.textContent?.indexOf('Read')! < line.textContent?.indexOf('CLAUDE.md')!,
    'the link follows the tool call label and argument')
  assert.equal(links[0].closest('.tline'), line, 'the path stays on the tool-call line')
})

test('Skill and edit tool paths keep the separator outside each filename link', async t => {
  const skillPath = 'C:\\workspace\\skills\\review\\SKILL.md'
  const editPath = 'C:\\workspace\\src\\settings.json'
  const view = await mountView(<>
    <ToolChip t={{ id: 'skill-1', name: 'Skill', arg: 'review', file_paths: [{ path: skillPath, link: true }] }} slug="org" nid="agent" />
    <ToolChip t={{ id: 'edit-1', name: 'Edit', arg: editPath, file_paths: [{ path: editPath, link: true }] }} slug="org" nid="agent" />
  </>, el => el)
  t.after(() => view.unmount())
  const lines = Array.from(view.el.querySelectorAll('.tline'))
  assert.equal(lines.length, 2)
  const skillLink = lines[0].querySelector<HTMLAnchorElement>('a[data-local-path]')!
  const editLink = lines[1].querySelector<HTMLAnchorElement>('a[data-local-path]')!
  assert.equal(skillLink.textContent, 'SKILL.md')
  assert.equal(editLink.textContent, 'settings.json')
  assert.match(lines[0].textContent ?? '', /Skill review\s+SKILL\.md/)
  assert.match(lines[1].textContent ?? '', /Edit\s+settings\.json/)
})

test('relative file paths without an event working directory stay plain text', async t => {
  const view = await mountView(<ToolChip t={{ id: 'read-2', name: 'Read',
    file_paths: [{ path: 'notes/todo.md', link: false }] }} slug="org" nid="agent" />, el => el)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('a[data-local-path]') === null, true)
  assert.match(view.el.querySelector('.tline')?.textContent ?? '', /notes\/todo\.md/)
})

test('tool-row file links open the shared file context menu with file actions', async t => {
  const path = 'C:\\synthetic\\scratch\\cancel-next.png'
  const oldBridge = Object.getOwnPropertyDescriptor(window, 'orgtreeDesktop')
  const oldClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const copied: string[] = []
  const opened: string[] = []
  const revealed: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
    localFileStatus: async (target: string) => ({ ok: true, exists: target === path }),
    openLocalFile: async (target: string) => { opened.push(target); return { ok: true } },
    revealFile: async (target: string) => { revealed.push(target); return { ok: true } },
  } })
  t.after(() => {
    if (oldBridge) Object.defineProperty(window, 'orgtreeDesktop', oldBridge)
    else delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop
    if (oldClipboard) Object.defineProperty(navigator, 'clipboard', oldClipboard)
    else delete (navigator as Navigator & { clipboard?: unknown }).clipboard
  })
  const view = await mountView(<ToolChip t={{ id: 'read-menu', name: 'Read',
    file_paths: [{ path, link: true }] }} slug="org" nid="agent" />, el => el)
  t.after(() => view.unmount())
  const link = view.el.querySelector<HTMLAnchorElement>('a[data-local-path]')!
  const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })
  await inAct(() => { link.dispatchEvent(event) })
  await flush(3)

  assert.equal(event.defaultPrevented, true, 'the file link takes its own context menu')
  const labels = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu [role="menuitem"]')]
    .map(item => item.textContent)
  assert.deepEqual(labels, ['Open', 'Show in folder', 'Copy path', 'Copy file name'])
  const copyPath = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu [role="menuitem"]')]
    .find(item => item.textContent === 'Copy path')!
  await inAct(() => { copyPath.click() })
  await flush(2)
  assert.deepEqual(copied, [path], 'Copy path copies the full local path')

  for (const [label, target] of [['Open', opened], ['Show in folder', revealed]] as const) {
    await inAct(() => { link.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })) })
    await flush(3)
    const item = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu [role="menuitem"]')]
      .find(candidate => candidate.textContent === label)!
    await inAct(() => { item.click() })
    await flush(2)
    assert.deepEqual(target, [path], `${label} uses the selected local path`)
  }
})

test('tool-row file menu reports a path that disappeared before the menu opened', async t => {
  const oldBridge = Object.getOwnPropertyDescriptor(window, 'orgtreeDesktop')
  Object.defineProperty(window, 'orgtreeDesktop', { configurable: true, value: {
    localFileStatus: async () => ({ ok: true, exists: false }),
  } })
  t.after(() => {
    if (oldBridge) Object.defineProperty(window, 'orgtreeDesktop', oldBridge)
    else delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop
  })
  const view = await mountView(<ToolChip t={{ id: 'missing-menu', name: 'Read',
    file_paths: [{ path: 'C:\\synthetic\\missing.txt', link: true }] }} slug="org" nid="agent" />, el => el)
  t.after(() => view.unmount())
  const link = view.el.querySelector<HTMLAnchorElement>('a[data-local-path]')!
  await inAct(() => { link.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })) })
  await flush(3)

  const menu = document.querySelector('.ctxmenu')!
  assert.ok(menu, 'the missing path still gets a context menu')
  assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent), ['File no longer exists'])
  assert.equal((menu.querySelector('[role="menuitem"]') as HTMLButtonElement).disabled, true)
})
