// changelog.test.tsx — the Changelog panel itself (docket
// changelog-window-one-row-per-version-pinnable-po). Where and when it opens:
// changelogopen.test.tsx.
//
// §1 one row per version, newest first, each with its version and its release
//    date & time in local time (USER 2026-10-24 22:16:17Z "each list entry has
//    the version number and release date", 22:17:14Z "release date & time");
//    the pane repeats both in full above the notes.
// §2 it is the Presentations panel's shape (22:13:55Z "structured identically
//    to the presentations panel"): the same frame, header, list and pane
//    classes, and the same Alt+arrow steps between rows.
// §3 a release without notes says so, and no row speaks of an unpublished
//    build (USER 2026-10-25 09:01:38Z "Published only": the engine lists
//    published releases only, crate::changelog).
// §4 the header's inline checkbox "Show this every time" switches the
//    after-update setting itself (USER 2026-10-25 09:09:02Z: 'change the
//    message on the changelog to "Show this every time" and make the checkbox
//    inline as well'), in the Presentations header's own checkbox line.
// §5 the setting: sentence case, on by default, remembered.
// §6 a new opening request shows the latest again.
// §7–§9 the list (USER 2026-10-25 10:14:15Z m8d297c7ec920, on alpha.6: "narrow
//    the list significantly, bolden and increase the size of the verison
//    number, put the timestamp on a new line left-aligned"): a narrow column of
//    its own (§7), each version bold and larger (§8), and its date & time alone
//    on the line below, at the left (§9). These read styles.css as jsdom
//    applies it (its cascade, without layout); the capture
//    (tools/rig/changelog-visual.mjs) measures the drawn rows.
//
// Run:  node apps/desktop/renderer/tests/run.mjs changelog
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import { useState } from 'react'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  CHANGELOG_AFTER_UPDATE_FIELD, CHANGELOG_AFTER_UPDATE_KEY, ChangelogAfterUpdateSetting, ChangelogModal,
  changelogAfterUpdateOn, setChangelogAfterUpdateOn,
} from '../src/changelog'
import { OPEN_APP_SETTINGS_EVENT } from '../src/canvas/settingskit'
import { fmtFull, fmtStamp } from '../src/timefmt'
import type { ChangelogEntry, ChangelogRow } from '../src/api'

declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
function stylesheet() { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style); return () => style.remove() }

// GitHub's publish times (docs/releases.json published_at)
const ROWS: ChangelogRow[] = [
  { version: '4.4.4', released_at: '2026-10-24T05:23:13Z', notes: true },
  { version: '4.4.3', released_at: '2026-10-23T15:29:30Z', notes: true },
  { version: '2.0.0', released_at: '2026-09-10T20:15:41Z', notes: false },
]
const ENTRIES: Record<string, ChangelogEntry> = {
  '4.4.4': { ...ROWS[0]!, notes: '# Orgtree 4.4.4\n\nReply to a highlighted passage.\n' },
  '4.4.3': { ...ROWS[1]!, notes: '# Orgtree 4.4.3\n\nThe tutorial update.\n' },
  '2.0.0': { ...ROWS[2]!, notes: null },
}

function stub(rows: ChangelogRow[] = ROWS, entries: Record<string, ChangelogEntry> = ENTRIES) {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = g.fetch
  const seen: string[] = []
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } }))
  g.fetch = ((input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://engine.test').pathname
    seen.push(path)
    if (path === '/api/changelog') return json({ running: '4.4.5-alpha.6', time_source: 'published', releases: rows })
    const one = /^\/api\/changelog\/(.+)$/.exec(path)
    const hit = one && entries[decodeURIComponent(one[1]!)]
    return hit ? json(hit) : json({ detail: 'no Changelog row' }, 404)
  }) as typeof fetch
  return { seen, restore: () => { g.fetch = saved } }
}

async function panel(opening = 0, rows?: ChangelogRow[], entries?: Record<string, ChangelogEntry>) {
  localStorage.clear()
  const f = stub(rows, entries)
  let set: ((n: number) => void) | null = null
  function Host() {
    const [n, setN] = useState(opening)
    set = setN
    return <ChangelogModal close={() => {}} opening={n} />
  }
  const view = await mountView(<Host />, (el) => el)
  await inAct(async () => { await flush(12) })
  return { f, view, reopen: async (n: number) => { await inAct(async () => { set?.(n); await flush(12) }) } }
}

const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.changelog-row')]
const selected = (el: HTMLElement) => el.querySelector<HTMLElement>('.changelog-row.on')?.dataset.version ?? null
const pane = (el: HTMLElement) => el.querySelector('.mailer-read')?.textContent ?? ''

test('§1 one row per version, newest first, with its version and its local release date & time', async () => {
  const { f, view } = await panel()
  try {
    assert.deepEqual(rows(view.el).map((r) => r.dataset.version), ['4.4.4', '4.4.3', '2.0.0'])
    for (const [i, r] of rows(view.el).entries()) {
      assert.equal(r.querySelector('.mfrom')?.textContent, ROWS[i]!.version)
      assert.equal(r.querySelector('.mtime')?.textContent, fmtStamp(ROWS[i]!.released_at))
      assert.match(r.querySelector('.mtime')?.textContent ?? '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'date and time, local')
    }
    assert.equal(selected(view.el), '4.4.4', 'the latest is open')
    assert.match(pane(view.el), /Reply to a highlighted passage/)
    // the pane: its version and its full date & time above the notes
    await inAct(async () => { rows(view.el)[1]!.click(); await flush(8) })
    assert.equal(selected(view.el), '4.4.3')
    const meta = view.el.querySelector('.mailer-read .doc-pane-meta-row')?.textContent ?? ''
    assert.match(meta, /4\.4\.3/)
    assert.ok(meta.includes(fmtFull('2026-10-23T15:29:30Z')), meta)
    assert.match(pane(view.el), /The tutorial update/)
    assert.ok(view.el.querySelector('.mailer-read .changelog-notes h1'), 'the notes are rendered Markdown')
    assert.ok(f.seen.includes('/api/changelog/4.4.3'), f.seen.join(','))
  } finally { await view.unmount(); f.restore() }
})

test('§2 it is the Presentations panel shape, with its Alt+arrow steps', async () => {
  // jsdom has no scrollIntoView; a step scrolls the newly selected row into view
  const proto = window.HTMLElement.prototype
  const oldScroll = proto.scrollIntoView
  const scrolled: string[] = []
  proto.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.dataset.version ?? '') }
  const { f, view } = await panel()
  try {
    const frame = view.el.querySelector('.settings.gallery-modal.changelog-modal')
    assert.ok(frame, 'the gallery frame classes')
    assert.equal(frame!.querySelector('.gallery-head h3')?.textContent?.trim(), 'Changelog')
    assert.ok(frame!.querySelector('.mailpane .mailer-list'), 'the list column')
    assert.ok(frame!.querySelector('.mailpane .mailer-read'), 'the reading pane')
    assert.ok(rows(view.el).every((r) => r.classList.contains('mailrow') && r.classList.contains('doc-gallery-row')))
    const root = view.el.querySelector<HTMLElement>('.mailer')!
    const step = async (key: string) => inAct(async () => {
      root.dispatchEvent(new window.KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }))
      await flush(8)
    })
    await step('ArrowDown')
    assert.equal(selected(view.el), '4.4.3')
    await step('ArrowDown')
    assert.equal(selected(view.el), '2.0.0')
    await step('ArrowUp')
    assert.equal(selected(view.el), '4.4.3')
    assert.deepEqual(scrolled, ['4.4.3', '2.0.0', '4.4.3'], 'each step brings its row into view')
  } finally { await view.unmount(); f.restore(); proto.scrollIntoView = oldScroll }
})

test('§3 a release without notes says so, and no row speaks of an unpublished build', async () => {
  const { f, view } = await panel()
  try {
    await inAct(async () => { rows(view.el)[2]!.click(); await flush(8) })
    assert.equal(selected(view.el), '2.0.0')
    assert.match(pane(view.el), /No release notes\./)
    assert.ok(!/Unpublished|Draft notes|written when/.test(view.el.textContent ?? ''), view.el.textContent ?? '')
    assert.ok(rows(view.el).every((r) => !r.classList.contains('unpublished')))
  } finally { await view.unmount(); f.restore() }
})

test('§4 the header checkbox "Show this every time" switches the setting itself, inline', async () => {
  const { f, view } = await panel()
  const asks: unknown[] = []
  const hear = (e: Event) => asks.push((e as CustomEvent).detail)
  window.addEventListener(OPEN_APP_SETTINGS_EVENT, hear)
  try {
    const head = view.el.querySelector<HTMLElement>('.changelog-modal .gallery-head')!
    // the Presentations header's own checkbox line (canvas/gallery.tsx, "Show retired agents")
    const line = head.querySelector<HTMLLabelElement>(':scope > label.checkline.gallery-showretired.changelog-every-time')
    assert.ok(line, head.innerHTML)
    assert.equal(line.textContent?.trim(), 'Show this every time')
    assert.equal(head.querySelector('.changelog-setting-link'), null, 'no link to App settings any more')
    const box = line.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    assert.equal(box.checked, true, 'on by default')
    await inAct(() => { box.click() })
    assert.equal(localStorage.getItem(CHANGELOG_AFTER_UPDATE_KEY), '0')
    assert.equal(changelogAfterUpdateOn(), false)
    assert.equal(box.checked, false)
    await inAct(() => { box.click() })
    assert.equal(changelogAfterUpdateOn(), true)
    assert.equal(box.checked, true)
    assert.deepEqual(asks, [], 'App settings stays shut')
    // it follows the same setting switched in App settings › Display › Startup
    await inAct(async () => { setChangelogAfterUpdateOn(false); await flush(4) })
    assert.equal(box.checked, false)
  } finally { window.removeEventListener(OPEN_APP_SETTINGS_EVENT, hear); await view.unmount(); f.restore() }
})

test('§5 the setting: sentence case, on by default, remembered off and on', async () => {
  localStorage.clear()
  assert.equal(changelogAfterUpdateOn(), true, 'on by default')
  const view = await mountView(<ChangelogAfterUpdateSetting />, (el) => el)
  try {
    const row = view.el.querySelector<HTMLElement>(`[data-settings-field="${CHANGELOG_AFTER_UPDATE_FIELD}"]`)!
    assert.ok(row, 'the row names its field')
    assert.match(row.textContent ?? '', /^Open changelog after updates/)
    assert.match(row.textContent ?? '', /an update that brings a newer published release/, 'the hint says when it opens')
    const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    assert.equal(box.checked, true)
    await inAct(() => { box.click() })
    assert.equal(localStorage.getItem(CHANGELOG_AFTER_UPDATE_KEY), '0')
    assert.equal(changelogAfterUpdateOn(), false)
    assert.equal(box.checked, false)
    await inAct(() => { box.click() })
    assert.equal(changelogAfterUpdateOn(), true)
  } finally { await view.unmount(); localStorage.clear() }
})

test('§6 a new opening request shows the latest again', async () => {
  const { f, view, reopen } = await panel(1)
  try {
    await inAct(async () => { rows(view.el)[2]!.click(); await flush(8) })
    assert.equal(selected(view.el), '2.0.0')
    await reopen(1)
    assert.equal(selected(view.el), '2.0.0', 'the same request changes nothing')
    await reopen(2)
    assert.equal(selected(view.el), '4.4.4')
  } finally { await view.unmount(); f.restore() }
})

test('§7 the version list is a narrow column of its own, not the Presentations panel\'s third', async () => {
  const unstyle = stylesheet()
  const { f, view } = await panel()
  try {
    const list = view.el.querySelector<HTMLElement>('.changelog-modal .mailpane .mailer-list')!
    const s = window.getComputedStyle(list)
    // the gallery's 33.333333% drew it about 390 px wide in the user's alpha.6 window
    assert.match(s.width, /^\d+(\.\d+)?px$/, `a fixed width, not a share of the panel: "${s.width}"`)
    assert.ok(Number.parseFloat(s.width) <= 160, `narrow: ${s.width}`)
    assert.equal(s.maxWidth, s.width, 'a wider panel does not widen it')
  } finally { await view.unmount(); f.restore(); unstyle() }
})

test('§8 each version is bold and larger than its row\'s other text', async () => {
  const unstyle = stylesheet()
  const { f, view } = await panel()
  try {
    for (const r of rows(view.el)) {
      const version = r.querySelector<HTMLElement>('.l1 .mfrom')!
      const v = window.getComputedStyle(version)
      assert.ok(v.fontWeight === 'bold' || Number(v.fontWeight) >= 700, `bold: "${v.fontWeight}"`)
      // the row's lines are 11 px, as the version was
      const line = window.getComputedStyle(r.querySelector<HTMLElement>('.l1')!)
      assert.equal(line.fontSize, '11px')
      assert.ok(Number.parseFloat(v.fontSize) >= 14, `larger than the 11 px it was: "${v.fontSize}"`)
    }
  } finally { await view.unmount(); f.restore(); unstyle() }
})

test('§9 its release date & time is alone on the line below the version, at the left', async () => {
  const unstyle = stylesheet()
  const { f, view } = await panel()
  try {
    for (const [i, r] of rows(view.el).entries()) {
      const lines = [...r.children] as HTMLElement[]
      assert.deepEqual(lines.map((l) => l.className), ['l1', 'l2'], 'two lines: the version, then its time')
      assert.equal(lines[0]!.textContent, ROWS[i]!.version, 'the version alone on the first')
      const time = lines[1]!.querySelector<HTMLElement>(':scope > .mtime')
      assert.equal(time?.textContent, fmtStamp(ROWS[i]!.released_at))
      assert.equal(lines[1]!.textContent, time?.textContent, 'the time alone on the second')
      // nothing pushes it right: it starts where the version starts
      const s = window.getComputedStyle(lines[1]!)
      assert.ok(!/^(flex-end|end|right|center|space-between|space-around|space-evenly)$/.test(s.justifyContent), s.justifyContent)
      assert.ok(!/^(right|end|center)$/.test(s.textAlign), s.textAlign)
      assert.notEqual(window.getComputedStyle(time!).marginLeft, 'auto')
      // the same mono face it had beside the version (`.mailrow .l1`), not the gallery line's inherited one
      assert.match(s.fontFamily, /var\(--mono\)|Consolas/, s.fontFamily)
    }
  } finally { await view.unmount(); f.restore(); unstyle() }
})

test('a list that cannot be read says so and can be asked again', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = g.fetch
  let calls = 0
  g.fetch = (() => { calls++; return Promise.resolve(new Response(JSON.stringify({ detail: 'engine away' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } })) }) as typeof fetch
  const view = await mountView(<ChangelogModal close={() => {}} />, (el) => el)
  try {
    await inAct(async () => { await flush(12) })
    assert.match(view.el.textContent ?? '', /could not load the changelog/)
    await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.doc-list-retry')!.click(); await flush(12) })
    assert.equal(calls, 2)
  } finally { await view.unmount(); g.fetch = saved }
})
