import './harness'
import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as docs from '../src/canvas/docs'
import { DocReader } from '../src/canvas/docs'
import { DocGalleryModal } from '../src/canvas/gallery'
import { mockupUrl } from '../src/api'

// Inline HTML presentations (user 2026-10-26 21:33Z m027a7754ab06, "yes"
// 21:36:52Z m180c5c6cad58; one-way, m2da6e3eb205d and mc5f0c7fac8ff). The
// reader shows the SELECTED presentation in a sandboxed srcdoc frame. jsdom
// runs no frame scripts, so these tests read what the app builds; the
// Session 0 capture runs the frame in Chromium.

const at = '2026-10-26T20:00:00Z'
const encoder = new TextEncoder()
type Row = { id: string; title: string; format: 'html' | 'markdown'; viewed_at?: string | null }
type Page = { status?: number; html?: string; length?: number; omitLength?: boolean }
const hostile = '<!DOCTYPE html><html lang="en"><head><script>window.IN_APP_EXECUTION = true</script></head>'
  + '<body><button id="untrusted-control">unsafe</button></body></html>'

function serve(rows: Row[], pages: Record<string, Page>, opening?: string) {
  const calls: string[] = []
  let cancelled = 0
  const full = rows.map((r) => ({ node: 'agent', tier: 'sol', at, node_state: 'live', evicted: false, viewed_at: at, ...r }))
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url), 'http://localhost')
    calls.push((init?.method ?? 'GET') + ' ' + u.pathname)
    const mock = u.pathname.match(/\/documents\/([^/]+)\/mockup$/)?.[1]
    if (mock) {
      const page = pages[decodeURIComponent(mock)] ?? { status: 404, html: '{"detail":"that document no longer exists"}' }
      const bytes = encoder.encode(page.html ?? '')
      const headers = new Headers()
      if (!page.omitLength) headers.set('Content-Length', String(page.length ?? bytes.byteLength))
      return { ok: (page.status ?? 200) < 400, status: page.status ?? 200, statusText: 'Error', headers,
        body: { cancel: async () => { cancelled++ } },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        text: async () => page.html ?? '' } as unknown as Response
    }
    const id = u.pathname.match(/\/documents\/([^/]+)$/)?.[1]
    const json = (v: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => v }) as unknown as Response
    if (id === 'viewed') return json({ ok: true })
    if (id) return json({ ...full.find((r) => r.id === id), body: '<p>source</p>' })
    return json({ documents: full, total: full.length, next_offset: null, offset: 0,
      ...(opening && u.searchParams.has('opening') ? { opening_id: opening, opening_position: full.findIndex((r) => r.id === opening) } : {}) })
  }) as typeof fetch
  return { calls, cancelled: () => cancelled }
}

const frameOf = (el: ParentNode) => el.querySelector<HTMLIFrameElement>('iframe.html-presentation-frame')
const reader = (id: string) => <DocReader slug="org" docId={id} toast={() => {}} close={() => {}} />

test('the reader shows the selected HTML presentation in a sandboxed frame, never in the app DOM', async (t) => {
  const served = serve([{ id: 'dash', title: 'Release dashboard', format: 'html' }], { dash: { html: hostile } })
  const view = await mountView(reader('dash'), (host) => host)
  t.after(() => view.unmount())
  await flush(); await flush()
  const frame = frameOf(view.el)
  assert.ok(frame, 'the reader renders the presentation inline')
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts', 'scripts only: opaque origin, no forms, popups or top navigation')
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer')
  assert.ok(served.calls.includes('GET /api/orgs/org/documents/dash/mockup'), 'the stored preview the window shows')
  const doc = frame.getAttribute('srcdoc') ?? ''
  assert.ok(doc.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src \'none\';'),
    'the author doctype first, then the policy: ' + doc.slice(0, 120))
  for (const directive of ["connect-src 'none'", "form-action 'none'", "frame-src 'none'", "script-src 'unsafe-inline' data:", 'base-uri about:']) {
    assert.ok(doc.includes(directive), directive)
  }
  assert.ok(doc.indexOf('<base href="about:srcdoc">') < doc.indexOf('<script>window.IN_APP_EXECUTION'), 'policy and base precede author scripts')
  assert.equal(view.el.querySelector('#untrusted-control'), null)
  assert.equal((window as unknown as { IN_APP_EXECUTION?: boolean }).IN_APP_EXECUTION, undefined)
  const link = view.el.querySelector<HTMLAnchorElement>('a.html-presentation-window')
  assert.equal(link?.getAttribute('href'), mockupUrl('org', 'dash'))
  assert.equal(link?.target, '_blank')
  assert.match(link?.rel ?? '', /noopener/)
  assert.equal(link?.textContent, 'Open in a new window')
})

test('the frame document keeps the author doctype first and scans leading comments linearly', () => {
  const build = (docs as { presentationDocument?: (html: string, fit: boolean) => string }).presentationDocument
  assert.equal(typeof build, 'function')
  const policy = '<meta http-equiv="Content-Security-Policy"'
  assert.ok(build!('<!-- a --> <!doctype html><p>x</p>', true).startsWith('<!-- a --> <!doctype html>' + policy))
  assert.ok(build!('<p>quirks, as in the window</p>', true).startsWith(policy))
  assert.ok(build!('<!--never closed <!doctype html>', true).startsWith(policy))
  assert.ok(build!('<!doctype html>', true).includes('let fit=true'))
  assert.ok(build!('<!doctype html>', false).includes('let fit=false'))
  const started = performance.now()
  const comments = build!('<!-- c -->'.repeat(20000) + '<p>no doctype</p>', true)
  const unclosed = build!('<!--' + '-'.repeat(1_000_000), true)
  assert.ok(performance.now() - started < 1000, 'no backtracking over agent-written comments')
  assert.ok(comments.startsWith(policy) && unclosed.startsWith(policy))
})

test('Fit width and 100% post into the frame without reloading it, and the choice carries over', async (t) => {
  serve([{ id: 'wide', title: 'Wide dashboard', format: 'html' }, { id: 'next', title: 'Next', format: 'html' }],
    { wide: { html: '<!doctype html><div style="width:1600px">wide</div>' }, next: { html: '<p>next</p>' } })
  const view = await mountView(reader('wide'), (host) => host)
  t.after(() => view.unmount())
  await flush(); await flush()
  const frame = frameOf(view.el)
  assert.ok(frame)
  const before = frame.getAttribute('srcdoc')
  assert.ok(before?.includes('let fit=true'), 'Fit width is the default')
  const posted: unknown[] = []
  Object.defineProperty(frame, 'contentWindow', { configurable: true,
    value: { postMessage: (message: unknown, origin: string) => { posted.push([message, origin]) } } })
  const button = (label: string) => [...view.el.querySelectorAll<HTMLButtonElement>('.html-presentation-size button')]
    .find((b) => b.textContent === label)!
  assert.equal(button('Fit width').getAttribute('aria-pressed'), 'true')
  await inAct(() => button('100%').click())
  assert.deepEqual(posted.at(-1), [{ orgtreePresentationFit: false }, '*'])
  assert.equal(button('100%').getAttribute('aria-pressed'), 'true')
  assert.equal(frameOf(view.el), frame, 'the same frame element')
  assert.equal(frame.getAttribute('srcdoc'), before, 'no reload: the presentation keeps its own state')
  const next = await mountView(reader('next'), (host) => host)
  await flush(); await flush()
  assert.ok(frameOf(next.el)?.getAttribute('srcdoc')?.includes('let fit=false'), 'the next presentation opens at 100%')
  await inAct(() => [...next.el.querySelectorAll<HTMLButtonElement>('.html-presentation-size button')].find((b) => b.textContent === 'Fit width')!.click())
  await next.unmount()
})

test('a preview over 4 MiB keeps only its window link and is never read', async (t) => {
  const limit = 4 * 1024 * 1024
  const served = serve([
    { id: 'big', title: 'Declared too large', format: 'html' },
    { id: 'undeclared', title: 'Read too large', format: 'html' },
    { id: 'edge', title: 'Exactly the limit', format: 'html' },
  ], {
    big: { html: '<p>x</p>', length: 5 * 1024 * 1024 },
    undeclared: { html: 'x'.repeat(limit + 10), omitLength: true },
    edge: { html: 'y'.repeat(limit) },
  })
  for (const [id, inline] of [['big', false], ['undeclared', false], ['edge', true]] as const) {
    const view = await mountView(reader(id), (host) => host)
    t.after(() => view.unmount())
    await flush(); await flush()
    assert.equal(Boolean(frameOf(view.el)), inline, id)
    assert.ok(view.el.querySelector('a.html-presentation-window'), id + ': the window link stays')
    if (!inline) {
      assert.match(view.el.querySelector('.html-presentation-note')?.textContent ?? '',
        /^This presentation is \d+\.\d MiB\. Presentations over 4 MiB open only in their own window\.$/)
    }
  }
  assert.equal(served.cancelled(), 1, 'the declared-too-large body is cancelled unread')
  assert.match(document.body.textContent ?? '', /This presentation is 5\.0 MiB/)
})

test('only the selected presentation gets a frame, inside the reading pane', async (t) => {
  useFakeClock()
  const served = serve([
    { id: 'one', title: 'First presentation', format: 'html', viewed_at: null },
    { id: 'two', title: 'Second presentation', format: 'html' },
    { id: 'notes', title: 'Notes', format: 'markdown' },
  ], { one: { html: '<p>first body</p>' }, two: { html: '<p>second body</p>' } }, 'one')
  const view = await mountView(<DocGalleryModal slug="org" toast={() => {}} close={() => {}} />, (host) => host)
  t.after(async () => { try { await view.unmount() } finally { realClock() } })
  await flush(); await flush()
  const frames = () => [...view.el.querySelectorAll<HTMLIFrameElement>('iframe')]
  assert.equal(frames().length, 1)
  assert.ok(frames()[0]!.closest('.mailer-read'), 'in the reading pane')
  assert.equal(view.el.querySelector('.mailer-list iframe'), null, 'never in the list')
  assert.ok(frames()[0]!.getAttribute('srcdoc')?.includes('first body'))
  const second = [...view.el.querySelectorAll<HTMLElement>('.doc-gallery-row')].find((r) => r.textContent?.includes('Second presentation'))!
  await inAct(() => second.click()); await flush(); await flush()
  assert.equal(frames().length, 1)
  assert.ok(frames()[0]!.getAttribute('srcdoc')?.includes('second body'))
  assert.ok(served.calls.includes('GET /api/orgs/org/documents/two/mockup'))
  assert.equal(served.calls.filter((c) => c.endsWith('/notes/mockup')).length, 0, 'no preview read for an unselected row')
})

test('presentations stay one-way: no SDK in the frame and no app listener for it', async (t) => {
  serve([{ id: 'dash', title: 'Release dashboard', format: 'html' }], { dash: { html: '<p>dashboard</p>' } })
  const added: string[] = []
  const original = window.addEventListener
  window.addEventListener = function (this: Window, type: string, ...rest: unknown[]) {
    added.push(type)
    return (original as (...args: unknown[]) => void).call(this, type, ...rest)
  } as typeof window.addEventListener
  t.after(() => { window.addEventListener = original })
  const view = await mountView(reader('dash'), (host) => host)
  t.after(() => view.unmount())
  await flush(); await flush()
  const frame = frameOf(view.el)
  assert.ok(frame)
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { postMessage: () => {} } })
  await inAct(() => [...view.el.querySelectorAll<HTMLButtonElement>('.html-presentation-size button')].find((b) => b.textContent === '100%')!.click())
  await inAct(() => [...view.el.querySelectorAll<HTMLButtonElement>('.html-presentation-size button')].find((b) => b.textContent === 'Fit width')!.click())
  assert.equal(added.includes('message'), false, 'the app never listens to a presentation frame')
  const doc = frame.getAttribute('srcdoc') ?? ''
  for (const bridge of ['MessageChannel', 'parent.postMessage', "'orgtree'", 'orgtree-panel']) {
    assert.equal(doc.includes(bridge), false, bridge)
  }
})

test('a preview that cannot load says so and keeps the window link', async (t) => {
  serve([{ id: 'gone', title: 'Gone', format: 'html' }], { gone: { status: 500, html: '{"detail":"preview unavailable"}' } })
  const view = await mountView(reader('gone'), (host) => host)
  t.after(() => view.unmount())
  await flush(); await flush()
  assert.equal(frameOf(view.el), null)
  const note = view.el.querySelector('.html-presentation-note')
  assert.equal(note?.textContent, 'Could not load the HTML presentation: preview unavailable')
  assert.ok(note?.classList.contains('ask-warn'))
  assert.ok(view.el.querySelector('a.html-presentation-window'))
})
