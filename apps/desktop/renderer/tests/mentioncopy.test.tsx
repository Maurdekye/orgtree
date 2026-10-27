// mentioncopy.test.tsx — a mention is one gesture away (USER 2026-10-27):
//   "also double clicking a docket item should copy its mention"
//   "double clicking a presentation in the list should also copy its mention"
//   "and add a context menu entry to copy an app or panel's mention"
// The docket row's double-click is in contextmenu.test.tsx (§B4b); this file
// covers the Presented lists (the org-wide modal and the desk tab) and the app
// and panel link menus (the Apps list rows and the @app:/@panel: chips). The
// clipboard is stubbed: nothing here touches the real one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, flush, inAct, realClock, useFakeClock } from './harness'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import { galleryRows, installGalleryFixture } from './galleryrows-fixture'
import { appLinkMenu, panelLinkMenu } from '../src/canvas/apps/links'
import type { MenuEntry } from '../src/canvas/contextmenu'
import { readFileSync } from 'node:fs'
import path from 'node:path'

declare const __SRC_DIR__: string

function stubClipboard(): { writes: string[]; restore: () => void } {
  const writes: string[] = []
  const nav = window.navigator as unknown as Record<string, unknown>
  const had = Object.getOwnPropertyDescriptor(nav, 'clipboard')
  Object.defineProperty(nav, 'clipboard', {
    configurable: true,
    value: { writeText: (t: string) => { writes.push(t); return Promise.resolve() } },
  })
  return { writes, restore: () => {
    if (had) Object.defineProperty(nav, 'clipboard', had)
    else delete nav.clipboard
  } }
}

for (const surface of ['modal', 'desk'] as const) {
  test(`${surface}: double-clicking a presentation row copies its @doc mention, a single click copies nothing`, async t => {
    useFakeClock(); installGalleryFixture()
    const clip = stubClipboard(); t.after(clip.restore)
    const props = { slug: 'synthetic', toast: () => {}, onFocusAgent: () => {} }
    const v = await mountView(surface === 'modal'
      ? <DocGalleryModal {...props} close={() => {}} />
      : <AgentGalleryView {...props} nid="test-project" node={{ id: 'test-project', kind: 'project' } as any} />, host => host)
    t.after(async () => { await v.unmount(); realClock() })
    await flush()
    const rows = [...v.el.querySelectorAll<HTMLElement>('.doc-gallery-row')]
    assert.equal(rows.length, 4, 'positive control: the Presented list rendered')
    const row = rows[1]!
    assert.equal(row.dataset.docId, galleryRows[1]!.id)

    await inAct(() => row.click()); await flush()
    assert.deepEqual(clip.writes, [], 'a single click only does what it did before')
    assert.equal(row.querySelector('.docket-copied'), null)

    await inAct(() => {
      row.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 12, clientY: 8 }))
    })
    await flush(3)
    assert.deepEqual(clip.writes, ['@doc:synthetic/project'], 'the mention token, exactly as agents write it')
    assert.ok(row.querySelector('.docket-copied'), 'confirmed with the same Copied! bubble the docket row shows')
    assert.equal(row.querySelector('.docket-copied')!.textContent, 'Copied!')
  })
}

// BOUNCE 2026-10-28 (capture, desk Presented): `.desk-presented-card span { white-space: normal;
// overflow-wrap: anywhere }` out-ranked the bubble's nowrap, so Copied! broke into 'Cop' / 'ied' /
// '!' in the scaled desk row. The real styles.css cascade decides, as in effortbar.test.tsx.
test('desk: the Copied! bubble stays on one line inside a Presented row', async t => {
  useFakeClock(); installGalleryFixture()
  const clip = stubClipboard(); t.after(clip.restore)
  const style = document.createElement('style')
  style.textContent = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  document.head.appendChild(style); t.after(() => style.remove())
  const v = await mountView(<AgentGalleryView slug="synthetic" toast={() => {}} onFocusAgent={() => {}} nid="test-project"
    node={{ id: 'test-project', kind: 'project' } as any} />, host => host)
  t.after(async () => { await v.unmount(); realClock() })
  await flush()
  const row = v.el.querySelector<HTMLElement>('.desk-presented-card')!
  assert.ok(row, 'positive control: the desk Presented row rendered')
  await inAct(() => {
    row.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 12, clientY: 8 }))
  })
  await flush(3)
  const bubble = row.querySelector<HTMLElement>('.docket-copied')
  assert.ok(bubble, 'positive control: the bubble appeared')
  const css = window.getComputedStyle(bubble)
  assert.equal(css.getPropertyValue('white-space'), 'nowrap', 'one line, as in the docket row')
  assert.notEqual(css.getPropertyValue('overflow-wrap'), 'anywhere', 'and no break inside the word')
})

const entry = (entries: MenuEntry[], label: string) =>
  entries.find((e): e is Exclude<MenuEntry, 'sep'> => e !== 'sep' && e.label === label)
const at = (entries: MenuEntry[], label: string) => entries.findIndex(e => e !== 'sep' && e.label === label)

test('the app and panel link menus offer Copy mention beside Settings', async t => {
  const clip = stubClipboard(); t.after(clip.restore)
  const toasts: string[][] = []
  const toast = (lines?: string[] | null) => { if (lines) toasts.push(lines) }

  const appMenu = appLinkMenu('acme', 'notes-app', document.body, toast)
  const copyApp = entry(appMenu, 'Copy mention')
  assert.ok(copyApp, 'the app menu has Copy mention')
  assert.ok(at(appMenu, 'Copy mention') < at(appMenu, 'Settings'), 'and it sits above Settings')
  await inAct(async () => { copyApp.onSelect() }); await flush(3)

  const panelMenu = panelLinkMenu('acme', { id: 'notes-app-2', open: true, running: true }, document.body, toast)
  const copyPanel = entry(panelMenu, 'Copy mention')
  assert.ok(copyPanel, 'the panel menu has Copy mention')
  assert.ok(at(panelMenu, 'Copy mention') < at(panelMenu, 'Settings'), 'and it sits above Settings')
  await inAct(async () => { copyPanel.onSelect() }); await flush(3)

  assert.deepEqual(clip.writes, ['@app:acme/notes-app', '@panel:acme/notes-app-2'])
  assert.deepEqual(toasts, [['copied mention'], ['copied mention']])
})
