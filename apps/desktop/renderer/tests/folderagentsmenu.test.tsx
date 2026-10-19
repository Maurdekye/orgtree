import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useContextMenu } from '../src/canvas/contextmenu'
import type { MenuEntry, MenuItem } from '../src/canvas/contextmenu'

const noop = () => {}
const menuEl = () => document.querySelector('.ctxmenu:not(.ctxmenu-submenu)') as HTMLElement | null

function FolderMenu({ entry }: { entry: MenuEntry }) {
  const menu = useContextMenu()
  return <div onContextMenu={e => menu.open(e, [entry])}><span>folder</span>{menu.node}</div>
}

async function openFolderMenu(view: { el: HTMLElement }) {
  const target = view.el.querySelector('span')!
  await inAct(async () => {
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10,
    }))
    await flush(3)
  })
}

test('folder menu exposes Edit AGENTS.md without a redundant Open folder child', async t => {
  const opened: string[] = []
  const folderAction = Object.assign(noop, {
    folderAgentsFile: {
      exists: async () => true,
      edit: () => opened.push('agents'),
    },
  })
  const entry = { label: 'Scratch folder', onSelect: folderAction } as MenuItem
  const view = await mountView(<FolderMenu entry={entry} />, el => el)
  t.after(() => view.unmount())
  await openFolderMenu(view)

  const parent = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find(item => item.textContent?.startsWith('Scratch folder'))
  assert.ok(parent, 'the original folder entry remains')
  assert.equal(parent.getAttribute('aria-haspopup'), 'menu',
    'a folder with AGENTS.md exposes its actions as a submenu')
  await inAct(async () => { parent.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'ArrowRight', bubbles: true, cancelable: true,
  })); await flush(2) })
  const submenu = document.querySelector<HTMLElement>('.ctxmenu-submenu[aria-label="Scratch folder"]')
  assert.ok(submenu, 'the folder submenu opens through the standard keyboard path')
  assert.deepEqual([...submenu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim()),
    ['Edit AGENTS.md'])
  const edit = [...submenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find(item => item.textContent?.startsWith('Edit AGENTS.md'))
  assert.ok(edit)
  await inAct(async () => { edit.click(); await flush(2) })
  assert.deepEqual(opened, ['agents'])
})

test('folder without a root AGENTS.md retains direct opening and offers editing', async t => {
  const opens: number[] = []
  const folderAction = Object.assign(() => opens.push(1), {
    folderAgentsFile: { exists: async () => false, edit: noop },
  })
  const entry = { label: 'Team scratch folder', onSelect: folderAction } as MenuItem
  const view = await mountView(<FolderMenu entry={entry} />, el => el)
  t.after(() => view.unmount())
  await openFolderMenu(view)

  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find(button => button.textContent?.startsWith('Team scratch folder'))
  assert.ok(item)
  assert.equal(item.getAttribute('aria-haspopup'), 'menu')
  await inAct(async () => { item.click(); await flush(2) })
  assert.deepEqual(opens, [1])
})
