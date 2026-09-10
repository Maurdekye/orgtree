// pendcol.test.tsx — the pending bubble is a PREVIEW of the delivered one
// (user, 2026-08-28), and since 2026-09-10 that promise is total: "make
// pending ALL kinds visually identical to settled (except unavailable
// metadata), including wrappers/inherited CSS, backgrounds/borders/
// typography/spacing/attachments."
//
// HISTORY, because two user rulings meet here. 2026-08-28 established the
// COLUMN: text in its own block, attachments in one `.attach-row` beneath
// it, "the columnar display is best for this, yes", and "keep the
// 'delivering mid-task' text in the same spot" — the top right, never below
// the picture. 2026-09-10 superseded the remaining difference: the side
// gutter that held that tag made every pending card ~200px narrower than
// its settled twin, so the pending row is now the SAME full-width
// MailMessage card a settled transcript row draws, and the delivery tag /
// retract ✕ ride the card's own metadata strip, pushed to its right end —
// still the top-right spot, still never below the content.
//
// So the checkable properties are now:
//   * the pending card and the delivered card are the SAME DOM, byte for
//     byte, once the declared pending chrome (.pend-tag/.pend-x/.ghost-acts)
//     is set aside — asserted per attachment combination, because a fix
//     checked only on one shape can still be wrong with two images, no
//     text, or no image;
//   * the delivered card itself keeps the column (body above ONE attachment
//     row, nothing loose) — the anti-vacuity anchor: if the target were
//     ever wrong, parity could be satisfied by both being wrong together;
//   * the tag/✕ live in the card's metadata strip, after the envelope
//     fields, and never below the content.
//
// The other half of "identical" — computed styles, widths, stacking rhythm,
// everything jsdom cannot measure — is pendparity_probe.py's job, in real
// Edge against the real stylesheet.
//
// ⚠ COMPARE DOM NODES WITH assert.ok(a === b), NEVER deep equality.
// `assert.deepEqual(<p>one</p>, <p>two</p>)` PASSES — two same-tag elements
// are indistinguishable to a deep compare, so such a leg can never fail and
// a mutation harness would certify it as "caught" while nothing was checked.
//
// Run:  cd frontend && node tests/run.mjs pendcol

import {
  FakeServer, flush, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { refreshConvo, resetConvos } from '../src/convo'
import { DeskChat } from '../src/canvas/desk'
import { closeLightbox } from '../src/canvas/lightbox'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, PendingMail } from '../src/types'

let _n = 0
const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

function node(id: string): CanvasNode {
  return {
    id, state: 'live', tier: 'haiku', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'haiku',
  }
}

function deskEl(nd: CanvasNode, slug: string) {
  return (
    <DeskChat node={nd} map={new Map([[nd.id, nd]])} op={op} slug={slug}
      toast={noop} pub={false} bare />
  )
}

function domTest(name: string,
  body: (k: { SL: string; ND: string; s: FakeServer;
    mount: (el: React.ReactElement) => Promise<HTMLElement> }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const SL = 'org'
    const ND = `pc${++_n}`
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
        return v.el
      },
    })
  })
}

// ── fixtures ────────────────────────────────────────────────────────────────
const att = (name: string) => ({ name, path: `uploads/${name}`, bytes: 12345 })

const AT = '2026-09-10T12:00:00.000Z'
const row = (body: string, names: string[]) => ({
  id: 'm-parity', from: '@user', kind: 'message', body, at: AT,
  attachments: names.map(att),
})

/** a queued (undelivered) mail from the user, as `chat.pending_mail` carries it */
const queue = (s: FakeServer, body: string,
  names: string[] = [], extra: Partial<PendingMail> = {}): void => {
  s.pending_mail.push({ ...row(body, names), ...extra } as PendingMail)
}

/** the SAME message after delivery: the transcript's typed-segments replay of
 *  the identical envelope — the shape every delivered mail takes today, and
 *  therefore the parity target (a plain-text legacy row is a different,
 *  older transcript shape and not what a queued mail settles into) */
const delivered = (s: FakeServer, body: string, names: string[] = []): void => {
  s.messages.push({ role: 'user', text: '', seq: 1,
    segments: [{ kind: 'mail', rows: [row(body, names)] }] } as never)
}

// ── the shared property ─────────────────────────────────────────────────────
const pendCard = (el: HTMLElement): Element => {
  const b = el.querySelector('.pending.pendrow > .turn-mail')
  assert.ok(b, 'fixture: the pending card rendered')
  return b!
}
const deliveredCard = (el: HTMLElement): Element => {
  const b = el.querySelector('.typed-input .turn-mail')
  assert.ok(b, 'fixture: the delivered card rendered')
  return b!
}

/** the card minus the DECLARED pending chrome — the one thing allowed to
 *  differ, because it is metadata a settled row does not have */
const strip = (el: Element): Element => {
  const clone = el.cloneNode(true) as Element
  for (const c of clone.querySelectorAll('.pend-tag, .pend-x, .ghost-acts')) c.remove()
  return clone
}
// React's accessibility IDs are unique per mounted instance.
const canonical = (el: Element): string =>
  strip(el).innerHTML.replace(/:r[0-9a-z]+:/g, ':react-id:')

/** parity + the no-loose-attachment half of the 2026-08-28 column ruling,
 *  asserted on the PENDING card (the delivered one anchors §6). */
function assertParity(el: HTMLElement, want: { imgs: number; chips?: number }, label: string): void {
  const pend = pendCard(el), done = deliveredCard(el)
  assert.equal(canonical(pend), canonical(done),
    `${label}: the queued card is byte-identical to the delivered one (chrome aside)`)
  const chips = want.chips ?? 0
  const rowEl = pend.querySelector('.attach-row')
  assert.equal(Boolean(rowEl), want.imgs + chips > 0,
    `${label}: attachment row present == ${want.imgs + chips > 0}`)
  const thumbs = [...pend.querySelectorAll('.attach-thumbwrap')]
  assert.equal(thumbs.length, want.imgs, `${label}: ${want.imgs} thumbnail(s)`)
  for (const t of thumbs) {
    assert.ok(t.closest('.attach-row'),
      `${label}: every thumbnail is inside the attachment row, never loose`)
  }
  const loose = [...pend.querySelectorAll('.attach-chip')]
    .filter((c) => !c.closest('.attach-row'))
  assert.equal(loose.length, 0, `${label}: no attachment chip loose beside the text`)
  if (rowEl) {
    assert.equal(rowEl.children.length, want.imgs + chips,
      `${label}: all ${want.imgs + chips} attachment(s) in the one row`)
  }
}

// ==================================================================== §1
domTest('§1 pending, text + one image: the same card as the delivered bubble',
  async ({ SL, ND, s, mount }) => {
    queue(s, 'look at this', ['cat.png'])
    delivered(s, 'look at this', ['cat.png'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    assertParity(el, { imgs: 1 }, 'pending 1 img')
  })

domTest('§2 pending, text + TWO images: both in the one row, still below the text',
  async ({ SL, ND, s, mount }) => {
    // the case the single-image example cannot catch: a fix that wrapped only
    // the first attachment, or gave each its own row, passes §1 and fails here
    queue(s, 'two of them', ['cat.png', 'dog.jpg'])
    delivered(s, 'two of them', ['cat.png', 'dog.jpg'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    assertParity(el, { imgs: 2 }, 'pending 2 imgs')
  })

domTest('§3 pending, image and NO text: identical to its delivered twin',
  async ({ SL, ND, s, mount }) => {
    queue(s, '', ['cat.png'])
    delivered(s, '', ['cat.png'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    assertParity(el, { imgs: 1 }, 'pending img only')
  })

domTest('§4 pending, text and NO image: no attachment row below it',
  async ({ SL, ND, s, mount }) => {
    queue(s, 'just words')
    delivered(s, 'just words')
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    assertParity(el, { imgs: 0 }, 'pending text only')
    assert.match(pendCard(el).textContent ?? '', /just words/, 'and the words are on screen')
  })

domTest('§5 pending, a NON-image attachment rides the same row',
  async ({ SL, ND, s, mount }) => {
    // anti-vacuity for the chip half: the loose-chip check in assertParity
    // can only fail if chips are ever rendered at all
    queue(s, 'the report', ['notes.pdf'])
    delivered(s, 'the report', ['notes.pdf'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    assertParity(el, { imgs: 0, chips: 1 }, 'pending chip')
    assert.ok(pendCard(el).querySelector('.attach-row .attach-chip'), 'the chip is in the row')
  })

// ==================================================================== §6
domTest('§6 the DELIVERED card has the column shape — it is the target',
  async ({ SL, ND, s, mount }) => {
    // if this ever stops holding, the parity above could be satisfied by both
    // views being wrong together, so it is asserted on its own first
    delivered(s, 'look at this', ['cat.png'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    const card = deliveredCard(el)
    const head = card.querySelector(':scope > header.turn-mail-head')
    const body = card.querySelector(':scope > .event-fallback, :scope > .event-body, :scope > .turn-mail-preview')
    const rowEl = card.querySelector(':scope > .attach-row')
    assert.ok(head && body && rowEl, 'header, body and attachment row all render')
    assert.ok(head!.compareDocumentPosition(body!) & 4, 'metadata first, body below it')
    assert.ok(body!.compareDocumentPosition(rowEl!) & 4, 'the text comes first, the attachments below it')
    assert.equal([...card.querySelectorAll('.attach-thumbwrap')].length, 1)
    assert.ok(card.querySelector('.attach-thumbwrap')!.closest('.attach-row'),
      'the thumbnail is inside the attachment row')
  })

domTest('§6b delivered, two images: one row, as above',
  async ({ SL, ND, s, mount }) => {
    delivered(s, 'two of them', ['cat.png', 'dog.jpg'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    const rowEl = deliveredCard(el).querySelector(':scope > .attach-row')
    assert.ok(rowEl, 'one attachment row')
    assert.equal(rowEl!.children.length, 2, 'both images in it')
  })

// ==================================================================== §7
domTest('§7 PARITY: the same message reads the same queued and delivered',
  async ({ SL, ND, s, mount }) => {
    // THE USER'S ACTUAL REQUEST, stated as arrangement: one node, one screen,
    // the delivered copy of an earlier message and the queued copy of the
    // next — their content blocks in the same order, and not vacuously empty.
    delivered(s, 'first one', ['cat.png', 'dog.jpg'])
    queue(s, 'first one', ['cat.png', 'dog.jpg'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    const shape = (card: Element) => [...strip(card).children]
      .map((c) => c.matches('header.turn-mail-head') ? 'head'
        : c.matches('.event-fallback, .event-body, .turn-mail-preview') ? 'body'
          : c.classList.contains('attach-row') ? `attach×${c.children.length}`
            : `?${c.className}`)
    const pend = shape(pendCard(el))
    const done = shape(deliveredCard(el))
    assert.deepEqual(pend, done,
      'the queued message and the delivered message are arranged identically')
    // …and not identically EMPTY, which would satisfy deepEqual vacuously
    assert.deepEqual(done, ['head', 'body', 'attach×2'], 'fixture: both actually rendered')
  })

// ==================================================================== §8
domTest('§8 the delivery tag is its own line BELOW the card — never inside it',
  async ({ SL, ND, s, mount }) => {
    // The seat moved twice on user direction and this pins the CURRENT one
    // (2026-09-10, root ed542f0): delivery status occupies its own line
    // below the full-width card. It is NOT part of the card — the card must
    // stay byte-identical to its settled twin — and not a side column,
    // which is the width bug the parity work removed.
    queue(s, 'steered', ['cat.png'], { delivering: true })
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    const bubble = el.querySelector('.pending.pendrow')
    assert.ok(bubble, 'the pending row rendered')
    const tag = bubble!.querySelector('.pend-tag')
    assert.ok(tag, 'the tag renders')
    assert.match(tag!.textContent ?? '', /delivering mid-task/)
    assert.ok(tag!.parentElement === bubble,
      'its own line in the row — not inside the card')
    assert.equal(tag!.closest('.turn-mail'), null,
      'specifically NOT in the card, whose DOM must match its settled twin')
    const card = pendCard(el)
    assert.ok(card.compareDocumentPosition(tag!) & 4,
      'and it reads BELOW the message, where the user placed it')
  })

domTest('§8b the retract ✕ takes that same seat on an undelivered mail',
  async ({ SL, ND, s, mount }) => {
    // the tag's sibling in the same slot — the other branch of that ternary
    queue(s, 'not yet sent', ['cat.png'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    const card = pendCard(el)
    const x = card.querySelector('button.pend-x')
    assert.ok(x, 'the retract button renders while the mail is undelivered')
    assert.equal(x!.getAttribute('title'), 'retract (undelivered)')
    assert.ok(x!.closest('header.turn-mail-head'), 'in the metadata strip')
    assert.ok(!x!.closest('.event-fallback, .event-body, .attach-row'),
      'not inside the message content')
  })

// ==================================================================== §9
domTest('§9 the pending row is the card plus at most the status line below it',
  async ({ SL, ND, s, mount }) => {
    // the row is a plain BLOCK: the full-width card first, then — only while
    // delivering — the status line beneath (root ed542f0, user 2026-09-10).
    // Anything else beside or between them would reopen the width/column bug.
    queue(s, 'words', ['cat.png', 'notes.pdf'], { delivering: true })
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    const bubble = el.querySelector('.pending.pendrow')
    assert.ok(bubble, 'the pending row rendered')
    const kids = [...bubble!.children]
    assert.equal(kids.length, 2, 'the card and its status line, nothing else')
    assert.ok(kids[0]!.classList.contains('turn-mail'), 'the shared card first')
    assert.ok(kids[1]!.classList.contains('pend-tag'), 'the status line second')
    // …and an UNDELIVERED row (retractable) is the card alone: the ✕ rides
    // the card's metadata strip, so no second block exists at all
    const s2 = new FakeServer(); installFetch(s2)
    s2.pending_mail.push({ ...row('not sent yet', []), id: 'm-undelivered' } as PendingMail)
    const ND2 = ND + 'b'
    await refreshConvo(SL, ND2)
    const el2 = await mount(deskEl(node(ND2), SL))
    await flush()
    const b2 = el2.querySelector('.pending.pendrow')
    assert.ok(b2, 'the undelivered row rendered')
    assert.equal([...b2!.children].length, 1, 'card only')
    assert.ok(b2!.querySelector('.turn-mail-head .pend-x'),
      'the retract ✕ stays in the metadata strip')
  })
