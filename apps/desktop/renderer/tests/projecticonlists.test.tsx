// projecticonlists.test.tsx — A PROJECT SHOWS ITS OWN ICON WHEREVER IT IS LISTED
// (USER 2026-11-03 17:58:35Z m054eb408ae0d "project icons dont appear here";
// 17:59:01Z md6daf92d99de "the icon appears circularly truncated"). The composer's @ autocomplete and
// the hire-under chip drew the generic folder because TierChip was given no project name, so it
// could not find the theme. Small project icons are never clipped to a circle: the whole icon is
// scaled to fit (object-fit: contain) inside the project's rounded-square mark.
//
// Run:  node apps/desktop/renderer/tests/run.mjs projecticonlists
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { flush, inAct, mountView } from './harness'
import { QuickChat } from '../src/QuickChatBox'
import { legacyAppBackend } from './appfeed-fixture'
import { hydrateTree } from '../src/archived'
import type { TreePayload } from '../src/types'

declare const __SRC_DIR__: string
const ROCKET_D = 'M9.19 6.35'
const FOLDER_D = 'M20 6h-8l-2-2H4'
const ROSE = /e11d48|225,\s*29,\s*72/

test('the @ autocomplete wears each project\'s own icon and colour; an unset project keeps the folder', async t => {
  const old = globalThis.fetch
  globalThis.fetch = legacyAppBackend((async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ providers: [] }) })) as typeof fetch)
  t.after(() => { globalThis.fetch = old })
  const node = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, state: 'live', kind: 'project', tier: 'project', children: [], ...extra })
  const tree = { slug: 'org', roots: [node('proj-themed', { theme_color: '#e11d48', theme_icon: 'rocket' }), node('proj-plain')] } as unknown as TreePayload
  hydrateTree(tree)
  const view = await mountView(<QuickChat slug="org" tree={tree} op={async () => ({} as never)} toast={() => {}} onHired={() => {}} />, h => h)
  t.after(() => view.unmount())
  const box = view.el.querySelector<HTMLInputElement>('.quickchat-input')!
  await inAct(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(box, '@proj-')
    box.dispatchEvent(new window.Event('input', { bubbles: true }))
    box.setSelectionRange(6, 6)
    box.dispatchEvent(new window.Event('select', { bubbles: true }))
    await flush(5)
  })
  const items = [...document.querySelectorAll<HTMLElement>('.agent-mentions .agent-mention-item')]
  const row = (name: string) => items.find(i => i.textContent?.includes(name))!.querySelector('.project-mark') as HTMLElement
  assert.ok(row('@proj-themed').innerHTML.includes(ROCKET_D), 'the themed project shows its icon, not the folder')
  assert.match(row('@proj-themed').outerHTML, ROSE, 'in its theme colour')
  assert.ok(row('@proj-plain').innerHTML.includes(FOLDER_D), 'no icon set: the folder')
})

test('small project icons are never cropped to a circle: contain inside the rounded-square mark', () => {
  const css = readFileSync(joinPath(__SRC_DIR__, 'styles.css'), 'utf8')
  const rule = (sel: string) => {
    const at = css.indexOf(sel); assert.ok(at >= 0, sel + ' exists')
    return css.slice(at, css.indexOf('}', at))
  }
  const img = rule('.project-icon-img {')
  assert.match(img, /object-fit:\s*contain/)
  assert.doesNotMatch(img, /border-radius:\s*50%|clip-path/)
  const small = rule(':is(.agent-mention-item, .ref-chip')
  assert.match(small, /\.project-mark > \.project-icon-img/)
  assert.match(small, /width:\s*100%/)
  assert.match(small, /object-fit:\s*contain/)
  assert.match(small, /border-radius:\s*0/)
  assert.doesNotMatch(small, /50%\s*;|clip-path/)
  // and no rule rounds a project mark to a circle
  for (const m of css.matchAll(/([^{}]*\.project-mark[^{}]*)\{([^}]*)\}/g))
    assert.doesNotMatch(m[2]!, /border-radius:\s*50%|clip-path:\s*circle/, 'circle crop on: ' + m[1]!.trim().slice(0, 80))
})
