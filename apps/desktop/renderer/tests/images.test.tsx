// images.test.tsx — inline image presentation (user spec 2026-08-25): agents
// present images as part of a response, and images the user attaches render
// viewable directly. Every assertion here is on the RESOLVED value the DOM
// carries — the src attribute, the element present or absent — never on the
// helper having been called (a check that abstains reads exactly like a pass).
//
//   §11 the helpers: isImg
//   §12 md(): relative image srcs resolve per node, everything else untouched
//   §13 the desk: send_file image cards, delivered/user attachments, embedded
//       markdown images
//   §14 the lightbox: open on click, close on Esc/backdrop
//   §15 MailList: attachment thumbnails, unreachable rows fall back to chips
//
// Run:  cd frontend && node tests/run.mjs images

import {
  FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { refreshConvo, resetConvos } from '../src/convo'
import { DeskChat } from '../src/canvas/desk'
import { MailList } from '../src/canvas/mail'
import { md } from '../src/canvas/shared'
import { fmtBytes, isImg } from '../src/canvas/img'
import { closeLightbox } from '../src/canvas/lightbox'
import type { CanvasNode, MailRow } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

let _n = 0
const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const txt = (el: HTMLElement) => el.textContent ?? ''

function node(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, state: 'live', tier: 'haiku', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'haiku', ...extra,
  }
}

function deskEl(nd: CanvasNode, slug: string) {
  return (
    <DeskChat node={nd} map={new Map([[nd.id, nd]])} op={op} slug={slug}
      toast={noop} pub={false} bare />
  )
}

/** the render.test.tsx rig: mocked clock, fresh store key, FakeServer, and a
 *  teardown that survives a failed assertion — plus the lightbox overlay
 *  swept between tests (it lives on document.body, outside every mount) */
function domTest(name: string,
  body: (k: { SL: string; ND: string; s: FakeServer;
    mount: (el: React.ReactElement) => Promise<{ el: HTMLElement }> }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const SL = 'org'
    const ND = `img${++_n}`
    const s = new FakeServer()
    installFetch(s)
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      closeLightbox()
      resetConvos()
      realClock()
    })
    await body({
      SL, ND, s,
      mount: async (el) => {
        const v = await mountView(el, (host) => host)
        open.push(v)
        return { el: v.el }
      },
    })
  })
}

// ==================================================================== §11
// THE HELPERS
// ==================================================================== §11

test('§11.1 isImg keys on the extension, case-insensitively', () => {
  for (const n of ['a.png', 'B.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg',
                   'g.avif', 'h.bmp', 'i.ico', 'dir/x.PNG']) {
    assert.ok(isImg(n), `${n} is an image`)
  }
  for (const n of ['a.txt', 'b.pdf', 'c.png.exe', 'd', '', 'e.pngx']) {
    assert.ok(!isImg(n), `${n} is not`)
  }
  assert.ok(!isImg(undefined), 'undefined is not')
})

// Attachments arrive as explicit metadata, never marker-looking body lines.
const attachmentSegments = (body: string, name: string, bytes: number) => [{ kind: 'mail', rows: [{
  id: 'attachment-mail', from: '@user', kind: 'message', at: '2026-09-06T12:00:00Z', body,
  ev: {v: 1, variant: 'ordinary.message', actor: {kind: 'user', id: '@user'}, object: null, engine_authored: false, body},
  attachments: [{path: 'uploads/' + name, name, bytes}],
}] }]

// ==================================================================== §12
// md() — RELATIVE IMAGE RESOLUTION
// ==================================================================== §12

const B1 = '/api/orgs/org/nodes/alpha/file?path='
const B2 = '/api/orgs/org/nodes/beta/file?path='

test('§12.1 a relative src resolves against the given base, one encoding layer', () => {
  const h = md('![plot](outbox/plot.png)', B1).__html
  assert.ok(h.includes(`src="${B1}outbox%2Fplot.png"`),
    `resolved into the /file URL — got: ${h}`)
  // marked pre-encodes what it parses: decode-then-encode must not stack
  const h2 = md('![x](outbox/my%20file.png)', B1).__html
  assert.ok(h2.includes(`src="${B1}outbox%2Fmy%20file.png"`),
    `one layer of encoding, not two — got: ${h2}`)
  assert.ok(!h2.includes('%2520'), 'no double-encoding')
})

test('§12.2 absolute, data: and anchor srcs pass untouched', () => {
  const h = md('![a](https://example.com/x.png) ![b](/rooted.png)', B1).__html
  assert.ok(h.includes('src="https://example.com/x.png"'), 'https kept')
  assert.ok(h.includes('src="/rooted.png"'), 'rooted path kept')
})

test('§12.3 no base → the src is left alone', () => {
  const h = md('![plot](outbox/alone.png)').__html
  assert.ok(h.includes('src="outbox/alone.png"'), `untouched — got: ${h}`)
})

test('§12.4 the cache never crosses two nodes rendering the same text', () => {
  const text = '![same](outbox/same-text.png)'
  const a = md(text, B1).__html
  const b = md(text, B2).__html
  assert.ok(a.includes(`src="${B1}outbox%2Fsame-text.png"`), 'alpha resolves to alpha')
  assert.ok(b.includes(`src="${B2}outbox%2Fsame-text.png"`), 'beta resolves to beta')
})

// ==================================================================== §13
// THE DESK
// ==================================================================== §13

domTest('§13.1 a send_file IMAGE renders as the picture, download still on the card',
  async ({ SL, ND, s, mount }) => {
    s.assistantMsg('sent it', {
      tools: [{ name: 'mcp__orgtree__orgtree_send_file', arg: 'shot.png',
        id: 't1', file: { name: 'shot.png', path: 'outbox/shot.png', bytes: 4096, note: 'the render' } }],
    })
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL))
    await flush()
    const img = el.querySelector('.imgcard-img')
    assert.ok(img, 'the card shows the image itself')
    assert.equal(img!.getAttribute('src'),
      `/api/orgs/${SL}/nodes/${ND}/file?path=outbox%2Fshot.png`,
      'served from the node file endpoint')
    const dl = el.querySelector('.imgcard a.fdl')
    assert.ok(dl, 'and the download link survives on the caption')
    assert.equal(dl!.getAttribute('download'), 'shot.png')
    assert.ok(txt(el as HTMLElement).includes('the render'), 'the note renders')
  })

domTest('§13.2 a send_file NON-image keeps the download card, no phantom img',
  async ({ SL, ND, s, mount }) => {
    s.assistantMsg('sent it', {
      tools: [{ name: 'mcp__orgtree__orgtree_send_file', arg: 'r.pdf',
        id: 't1', file: { name: 'r.pdf', path: 'outbox/r.pdf', bytes: 4096 } }],
    })
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL))
    await flush()
    assert.ok(!el.querySelector('.imgcard-img'), 'no inline image')
    const card = el.querySelector('a.filecard')
    assert.ok(card, 'the download card renders')
    assert.equal(card!.getAttribute('download'), 'r.pdf')
  })

domTest('§13.3 a delivered user IMAGE attachment renders viewable, the marker line disappears',
  async ({ SL, ND, s, mount }) => {
    s.userMsg('look at this').segments = attachmentSegments('look at this', 'cat.png', 12288)
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL))
    await flush()
    const thumb = el.querySelector('img.attach-thumb')
    assert.ok(thumb, 'the attachment renders as a thumbnail')
    assert.equal(thumb!.getAttribute('src'),
      `/api/orgs/${SL}/nodes/${ND}/file?path=uploads%2Fcat.png`)
    assert.ok(!txt(el as HTMLElement).includes('[ATTACHED FILE'),
      'the machine line left the bubble')
    assert.ok(txt(el as HTMLElement).includes('look at this'), 'the words stayed')
  })

domTest('§13.4 a delivered user NON-image attachment gets a download chip',
  async ({ SL, ND, s, mount }) => {
    s.userMsg('here').segments = attachmentSegments('here', 'data.csv', 900)
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL))
    await flush()
    assert.ok(!el.querySelector('img.attach-thumb'), 'no thumbnail for a csv')
    const chip = el.querySelector('a.attach-chip')
    assert.ok(chip, 'a download chip instead')
    assert.equal(chip!.getAttribute('href'),
      `/api/orgs/${SL}/nodes/${ND}/file?path=uploads%2Fdata.csv`)
  })

domTest('§13.5 a relative markdown image in an agent reply resolves to its own files',
  async ({ SL, ND, s, mount }) => {
    s.assistantMsg('the curve:\n\n![curve](outbox/curve.png)')
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL))
    await flush()
    const img = el.querySelector('.msgtext.md img')
    assert.ok(img, 'the embedded image rendered')
    assert.equal(img!.getAttribute('src'),
      `/api/orgs/${SL}/nodes/${ND}/file?path=outbox%2Fcurve.png`)
  })

// ==================================================================== §14
// THE LIGHTBOX
// ==================================================================== §14

domTest('§14.1 clicking the picture opens the viewer; Esc closes it',
  async ({ SL, ND, s, mount }) => {
    s.assistantMsg('sent', {
      tools: [{ name: 'mcp__orgtree__orgtree_send_file', arg: 'v.png',
        id: 't1', file: { name: 'v.png', path: 'outbox/v.png', bytes: 1 } }],
    })
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL))
    await flush()
    const img = el.querySelector('.imgcard-img') as HTMLElement
    assert.ok(img, 'fixture: the image card rendered')
    await inAct(() => { img.click() })
    const ov = document.querySelector('.lb-overlay')
    assert.ok(ov, 'the viewer opened')
    assert.equal(ov!.querySelector('img.lb-img')!.getAttribute('src'),
      `/api/orgs/${SL}/nodes/${ND}/file?path=outbox%2Fv.png`,
      'on the same file URL')
    assert.ok(ov!.querySelector('a.lb-dl'), 'with a download link')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.ok(!document.querySelector('.lb-overlay'), 'Esc closed it')
  })

domTest('§14.2 a markdown-embedded image opens the viewer through the delegated listener',
  async ({ SL, ND, s, mount }) => {
    s.assistantMsg('![d](outbox/deleg.png)')
    await refreshConvo(SL, ND)
    const { el } = await mount(deskEl(node(ND), SL))
    await flush()
    const img = el.querySelector('.msgtext.md img') as HTMLElement
    assert.ok(img, 'fixture: the embedded image rendered')
    await inAct(() => { img.click() })
    const ov = document.querySelector('.lb-overlay')
    assert.ok(ov, 'the viewer opened without any React handler')
    // backdrop click closes
    await inAct(() => { (ov as HTMLElement).click() })
    assert.ok(!document.querySelector('.lb-overlay'), 'backdrop click closed it')
  })

// ==================================================================== §15
// MAILLIST ATTACHMENTS
// ==================================================================== §15

function mailRow(over: Partial<MailRow> = {}): MailRow {
  return {
    id: 'm1', from: 'alpha', kind: 'message', body: 'with a picture',
    at: '2026-08-25T10:00:00Z', ...over,
  } as MailRow
}

/** mount a MailList and open its one mail (selection is a row click) */
async function openedMail(
  mount: (el: React.ReactElement) => Promise<{ el: HTMLElement }>,
  row: MailRow, props: Record<string, unknown>) {
  const { el } = await mount(
    <MailList delivered={[row]} {...props} />)
  await flush()
  await inAct(() => { (el.querySelector('.mailrow') as HTMLElement).click() })
  await flush()
  return el
}

domTest('§15.1 an image attachment renders as a thumbnail in the reading pane',
  async ({ mount }) => {
    const row = mailRow({
      attachments: [{ name: 'shot.png', path: 'outbox/shot.png', bytes: 2048 },
                    { name: 'notes.txt', path: 'outbox/notes.txt', bytes: 10 }],
    })
    const el = await openedMail(mount, row, {
      fileHref: (p: string) => `/api/orgs/org/nodes/alpha/file?path=${encodeURIComponent(p)}`,
    })
    const thumb = el.querySelector('img.attach-thumb')
    assert.ok(thumb, 'the png renders as a thumbnail')
    assert.equal(thumb!.getAttribute('src'),
      '/api/orgs/org/nodes/alpha/file?path=outbox%2Fshot.png')
    const chip = el.querySelector('a.attach-chip')
    assert.ok(chip, 'the txt stays a download chip')
    assert.ok(txt(chip as HTMLElement).includes('notes.txt'))
  })

domTest('§15.2 a row whose files are unreachable falls back to plain chips',
  async ({ mount }) => {
    const row = mailRow({
      attachments: [{ name: 'shot.png', path: 'uploads/shot.png', bytes: 2048 }],
    })
    // the user Sent folder returns '' for rows without a known recipient
    const el = await openedMail(mount, row, { fileHref: () => '' })
    assert.ok(!el.querySelector('img.attach-thumb'), 'no thumbnail')
    assert.ok(!el.querySelector('a.attach-chip'), 'no dead link either')
    const chip = el.querySelector('span.attach-chip')
    assert.ok(chip, 'a plain chip names the file')
    assert.ok(txt(chip as HTMLElement).includes('shot.png'))
  })

domTest('§15.3 a relative image in the mail BODY resolves through mdBase',
  async ({ mount }) => {
    const row = mailRow({ body: 'see ![](outbox/inline.png)' })
    const el = await openedMail(mount, row, {
      mdBase: () => '/api/orgs/org/nodes/alpha/file?path=',
    })
    const img = el.querySelector('.mailer-body img')
    assert.ok(img, 'the body image rendered')
    assert.equal(img!.getAttribute('src'),
      '/api/orgs/org/nodes/alpha/file?path=outbox%2Finline.png')
  })

test('§16 fmtBytes still formats after the move to img.tsx', () => {
  assert.equal(fmtBytes(512), '512 B')
  assert.equal(fmtBytes(2048), '2 KB')
  assert.equal(fmtBytes(3 * 1048576), '3.0 MB')
  assert.equal(fmtBytes(null), '0 B')
})
