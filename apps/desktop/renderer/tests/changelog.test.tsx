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
// §3 an unpublished build is its own row, with the draft it leads to or a line
//    saying its notes come with the release.
// §4 the header link names the setting's state and asks App settings to open at
//    it (22:14:57Z "a link to that option on the changelog panel's header").
// §5 the setting: sentence case, on by default, remembered.
// §6 a new opening request shows the latest again.
//
// Run:  node apps/desktop/renderer/tests/run.mjs changelog
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import { useState } from 'react'
import assert from 'node:assert/strict'
import {
  CHANGELOG_AFTER_UPDATE_FIELD, CHANGELOG_AFTER_UPDATE_KEY, ChangelogAfterUpdateSetting, ChangelogModal,
  changelogAfterUpdateOn, setChangelogAfterUpdateOn,
} from '../src/changelog'
import { OPEN_APP_SETTINGS_EVENT } from '../src/canvas/settingskit'
import { fmtFull, fmtStamp } from '../src/timefmt'
import type { ChangelogEntry, ChangelogRow } from '../src/api'

const ROWS: ChangelogRow[] = [
  { version: '4.4.5-alpha.3', released_at: '2026-10-24T15:20:40Z', unpublished: true, notes: true },
  { version: '4.4.4', released_at: '2026-10-24T02:58:37Z', unpublished: false, notes: true },
  { version: '4.4.3', released_at: '2026-10-23T13:05:20Z', unpublished: false, notes: true },
  { version: '2.0.0', released_at: '2026-09-10T20:06:40Z', unpublished: false, notes: true },
]
const ENTRIES: Record<string, ChangelogEntry> = {
  '4.4.5-alpha.3': { ...ROWS[0]!, notes_version: '4.4.5', notes: '# Orgtree 4.4.5\n\nDraft of the next release.\n' },
  '4.4.4': { ...ROWS[1]!, notes_version: '4.4.4', notes: '# Orgtree 4.4.4\n\nReply to a highlighted passage.\n' },
  '4.4.3': { ...ROWS[2]!, notes_version: '4.4.3', notes: '# Orgtree 4.4.3\n\nThe tutorial update.\n' },
  '2.0.0': { ...ROWS[3]!, notes_version: '2.0.0', notes: 'Orgtree 2.0.0 is the stable desktop release.\n' },
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
    if (path === '/api/changelog') return json({ running: rows[0]?.version ?? '', time_source: 'tagged', releases: rows })
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
    assert.deepEqual(rows(view.el).map((r) => r.dataset.version), ['4.4.5-alpha.3', '4.4.4', '4.4.3', '2.0.0'])
    for (const [i, r] of rows(view.el).entries()) {
      assert.equal(r.querySelector('.mfrom')?.textContent, ROWS[i]!.version)
      assert.equal(r.querySelector('.mtime')?.textContent, fmtStamp(ROWS[i]!.released_at))
      assert.match(r.querySelector('.mtime')?.textContent ?? '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'date and time, local')
    }
    assert.equal(selected(view.el), '4.4.5-alpha.3', 'the latest is open')
    // the pane: its version and its full date & time above the notes
    await inAct(async () => { rows(view.el)[1]!.click(); await flush(8) })
    assert.equal(selected(view.el), '4.4.4')
    const meta = view.el.querySelector('.mailer-read .doc-pane-meta-row')?.textContent ?? ''
    assert.match(meta, /4\.4\.4/)
    assert.ok(meta.includes(fmtFull('2026-10-24T02:58:37Z')), meta)
    assert.match(pane(view.el), /Reply to a highlighted passage/)
    assert.ok(view.el.querySelector('.mailer-read .changelog-notes h1'), 'the notes are rendered Markdown')
    assert.ok(f.seen.includes('/api/changelog/4.4.4'), f.seen.join(','))
  } finally { await view.unmount(); f.restore() }
})

test('§2 it is the Presentations panel shape, with its Alt+arrow steps', async () => {
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
    assert.equal(selected(view.el), '4.4.4')
    await step('ArrowDown')
    assert.equal(selected(view.el), '4.4.3')
    await step('ArrowUp')
    assert.equal(selected(view.el), '4.4.4')
  } finally { await view.unmount(); f.restore() }
})

test('§3 an unpublished build is its own row, with the draft it leads to or a line saying none yet', async () => {
  const { f, view } = await panel()
  try {
    const top = rows(view.el)[0]!
    assert.ok(top.classList.contains('unpublished'))
    assert.match(top.textContent ?? '', /Unpublished build/)
    assert.match(pane(view.el), /Unpublished build/)
    assert.match(pane(view.el), /Draft notes for 4\.4\.5/)
    assert.match(pane(view.el), /Draft of the next release/)
    assert.ok(!/Unpublished build/.test(rows(view.el)[1]!.textContent ?? ''), 'a published row says nothing of the kind')
  } finally { await view.unmount(); f.restore() }
  const bare = { ...ENTRIES, '4.4.5-alpha.3': { ...ENTRIES['4.4.5-alpha.3']!, notes_version: null, notes: null } }
  const second = await panel(0, ROWS, bare)
  try {
    assert.match(pane(second.view.el), /Release notes for 4\.4\.5 are written when it is released\./)
  } finally { await second.view.unmount(); second.f.restore() }
})

test('§4 the header link names the setting state and opens App settings at it', async () => {
  const { f, view } = await panel()
  const asks: unknown[] = []
  const hear = (e: Event) => asks.push((e as CustomEvent).detail)
  window.addEventListener(OPEN_APP_SETTINGS_EVENT, hear)
  try {
    const link = view.el.querySelector<HTMLButtonElement>('.gallery-head .changelog-setting-link')!
    assert.equal(link.textContent, 'Open after updates: On')
    await inAct(() => { link.click() })
    assert.deepEqual(asks, [{ tab: 'display', focus: CHANGELOG_AFTER_UPDATE_FIELD }])
    assert.equal(CHANGELOG_AFTER_UPDATE_FIELD, 'changelog_after_update')
    await inAct(async () => { setChangelogAfterUpdateOn(false); await flush(4) })
    assert.equal(link.textContent, 'Open after updates: Off', 'it follows the setting')
  } finally { window.removeEventListener(OPEN_APP_SETTINGS_EVENT, hear); await view.unmount(); f.restore() }
})

test('§5 the setting: sentence case, on by default, remembered off and on', async () => {
  localStorage.clear()
  assert.equal(changelogAfterUpdateOn(), true, 'on by default')
  const view = await mountView(<ChangelogAfterUpdateSetting />, (el) => el)
  try {
    const row = view.el.querySelector<HTMLElement>(`[data-settings-field="${CHANGELOG_AFTER_UPDATE_FIELD}"]`)!
    assert.ok(row, 'the row names its field for the header link')
    assert.match(row.textContent ?? '', /^Open changelog after updates/)
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
    assert.equal(selected(view.el), '4.4.3')
    await reopen(1)
    assert.equal(selected(view.el), '4.4.3', 'the same request changes nothing')
    await reopen(2)
    assert.equal(selected(view.el), '4.4.5-alpha.3')
  } finally { await view.unmount(); f.restore() }
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
