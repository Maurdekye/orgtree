// pendcol.test.tsx — the pending bubble is a PREVIEW of the delivered one, so
// it must be laid out like it (user, 2026-08-28):
//
//   "when attaching an image preview, during the pre-send the contents are
//    arranged in a row (text, image, and 'delivering mid-task' text), but when
//    the actual message is sent, they are arranged in a column. i want the text
//    content and any image attachments to be arranged in the message the same
//    way during the preview and the actual send. keep the 'delivering mid-task'
//    text in the same spot."
//
// and, settling which one wins: "the columnar display is best for this, yes".
//
// ⚠ WHAT jsdom CAN PROVE HERE, AND WHAT IT CANNOT. jsdom does no layout and
// does not apply the stylesheet, so "in a row" is not measurable as a pixel
// position. But the row was not a styling accident — it was STRUCTURAL: the
// thumbnails were direct children of a `display:flex` bubble, siblings of the
// text, so the flex laid them out beside it. The delivered bubble instead puts
// the text in one block and the attachments in an `.attach-row` beneath it.
// So the checkable property, and the one that actually differed, is:
//
//     the text block and the attachments block are SIBLINGS, in that order,
//     and NO attachment sits loose beside the text.
//
// §7 asserts that of both views at once, which is the user's actual request —
// not "the preview is a column" but "the two agree".
//
// ⚠ COMBINATIONS, NOT THE EXAMPLE. The user hit this with one image and some
// text. A fix checked only in that shape can still be wrong with two images
// (thumbs splitting across containers), with no text (a blank text block above
// the picture) or with no image (an empty attachment row below the text), so
// there is a leg for each — and §3/§4 are the ones that fail if the blocks are
// rendered unconditionally.
//
// ⚠ CORRECTION, 2026-08-28. This header used to say that `assert.equal()` on
// two jsdom Elements hangs the runner because node "formats a diff across the
// whole document". THAT IS WRONG and the correction is left here rather than
// deleted, because the wrong version was convincing and someone will think of
// it again. `memory-leak` measured it: the failure message is a CONSTANT 75
// characters from 31 elements to 6001, sub-millisecond, because a jsdom
// element has no own enumerable properties to serialise. See
// deepdom.test.tsx, which pins that behaviour.
//
// The ~90 s hang and the "Array buffer allocation failed" were real — M7 in
// pendcol_mutate.py hit one — but the assert did not cause them. The better
// candidate, documented in sysnotice.test.tsx's own header, is the fake
// clock: node:test runs top-level tests concurrently, `useFakeClock()` swaps
// a PROCESS-GLOBAL timer implementation, and a polling hook then spins
// against a clock another test already reset. THIS FILE IS THAT SHAPE — its
// `domTest` calls useFakeClock() and mounts DeskChat, which polls. Suspect
// the clock before the assertion.
//
// The style rule below survives the correction on its own merits, for a
// different reason than the one first given:
// ⚠ COMPARE DOM NODES WITH assert.ok(a === b), NEVER deep equality.
// `assert.deepEqual(<p>one</p>, <p>two</p>)` PASSES — two same-tag elements
// are indistinguishable to a deep compare, so such a leg can never fail and a
// mutation harness would certify it as "caught" while nothing was checked.
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

/** a queued (undelivered) mail from the user, as `chat.pending_mail` carries it */
const queue = (s: FakeServer, body: string,
  names: string[] = [], extra: Partial<PendingMail> = {}): void => {
  s.pending_mail.push({
    id: `m${s.pending_mail.length + 1}`, from: '@user', body,
    at: new Date(Date.now()).toISOString(),
    attachments: names.map(att), ...extra,
  } as PendingMail)
}

/** the SAME message after delivery: the transcript replays the body with the
 *  envelope's [ATTACHED FILE] lines, which the bubble parses back out */
const delivered = (s: FakeServer, body: string, names: string[] = []): void => {
  s.userMsg([body, ...names.map((n) =>
    `[ATTACHED FILE: uploads/${n} (12 KB) — in your working folder]`)]
    .filter(Boolean).join('\n'))
}

// ── the shared property ─────────────────────────────────────────────────────
/** The message content lives directly in the delivered bubble; the pending
 *  bubble nests it one level so the delivery tag can sit beside it without
 *  being part of the message. Both are "the thing holding text + attachments". */
const contentOf = (bubble: Element): Element =>
  bubble.querySelector(':scope > .pendbody') ?? bubble

/** THE PROPERTY THE USER ASKED FOR, asserted identically on either view. */
function assertColumn(bubble: Element, want: { text: boolean; imgs: number; chips?: number },
  label: string): void {
  const host = contentOf(bubble)
  const text = host.querySelector(':scope > .msgtext')
  const row = host.querySelector(':scope > .attach-row')
  const chips = want.chips ?? 0
  const anyAtt = want.imgs + chips > 0

  // 1. the blocks exist exactly when they have something to say — an empty
  //    text block above a picture, or an empty row below text, is the
  //    "collapses oddly" case
  assert.equal(Boolean(text), want.text, `${label}: text block present == ${want.text}`)
  assert.equal(Boolean(row), anyAtt, `${label}: attach row present == ${anyAtt}`)

  // 2. no attachment sits loose beside the text. THIS is what made it a row:
  //    thumbs were direct children of the flex bubble, siblings of the text.
  const thumbs = [...bubble.querySelectorAll('.attach-thumbwrap')]
  assert.equal(thumbs.length, want.imgs, `${label}: ${want.imgs} thumbnail(s)`)
  for (const t of thumbs) {
    assert.ok(t.closest('.attach-row'),
      `${label}: every thumbnail is inside the attachment row, never loose`)
  }
  const loose = [...bubble.querySelectorAll('.attach-chip')]
    .filter((c) => !c.closest('.attach-row'))
  assert.equal(loose.length, 0, `${label}: no attachment chip loose beside the text`)

  // 3. …and when both blocks exist they are SIBLINGS, text first — which is
  //    what "column" means structurally once nothing is loose
  if (text && row) {
    assert.ok(text.parentElement === row.parentElement,
      `${label}: text and attachments share a parent`)
    assert.ok(text.compareDocumentPosition(row) & 4 /* FOLLOWING */,
      `${label}: the text comes first, the attachments below it`)
  }
  // 4. …and multiple attachments share ONE row rather than splitting
  if (row) {
    assert.equal(row.children.length, want.imgs + chips,
      `${label}: all ${want.imgs + chips} attachment(s) in the one row`)
  }
}

const pendBubble = (el: HTMLElement) => {
  const b = el.querySelector('.msg.pending.pendrow')
  assert.ok(b, 'fixture: the pending bubble rendered')
  return b!
}
const deliveredBubble = (el: HTMLElement) => {
  const b = el.querySelector('.msg.user:not(.pending)')
  assert.ok(b, 'fixture: the delivered bubble rendered')
  return b!
}

// ==================================================================== §1
domTest('§1 pending, text + one image: a column, like the delivered bubble',
  async ({ SL, ND, s, mount }) => {
    queue(s, 'look at this', ['cat.png'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    assertColumn(pendBubble(el), { text: true, imgs: 1 }, 'pending 1 img')
  })

domTest('§2 pending, text + TWO images: both in the one row, still below the text',
  async ({ SL, ND, s, mount }) => {
    // the case the single-image example cannot catch: a fix that wrapped only
    // the first attachment, or gave each its own row, passes §1 and fails here
    queue(s, 'two of them', ['cat.png', 'dog.jpg'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    assertColumn(pendBubble(el), { text: true, imgs: 2 }, 'pending 2 imgs')
  })

domTest('§3 pending, image and NO text: no empty text block above the picture',
  async ({ SL, ND, s, mount }) => {
    queue(s, '', ['cat.png'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    assertColumn(pendBubble(el), { text: false, imgs: 1 }, 'pending img only')
  })

domTest('§4 pending, text and NO image: no empty attachment row below it',
  async ({ SL, ND, s, mount }) => {
    queue(s, 'just words')
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    const b = pendBubble(el)
    assertColumn(b, { text: true, imgs: 0 }, 'pending text only')
    assert.match(b.textContent ?? '', /just words/, 'and the words are on screen')
  })

domTest('§5 pending, a NON-image attachment rides the same row',
  async ({ SL, ND, s, mount }) => {
    // anti-vacuity for the chip half: the loose-chip check in assertColumn
    // can only fail if chips are ever rendered at all
    queue(s, 'the report', ['notes.pdf'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    const b = pendBubble(el)
    assertColumn(b, { text: true, imgs: 0, chips: 1 }, 'pending chip')
    assert.ok(b.querySelector('.attach-row .attach-chip'), 'the chip is in the row')
  })

// ==================================================================== §6
domTest('§6 the DELIVERED bubble has that same shape — it is the target',
  async ({ SL, ND, s, mount }) => {
    // if this ever stops holding, §7's parity could be satisfied by both
    // views being wrong together, so it is asserted on its own first
    delivered(s, 'look at this', ['cat.png'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    assertColumn(deliveredBubble(el), { text: true, imgs: 1 }, 'delivered 1 img')
  })

domTest('§6b delivered, two images: one row, as above',
  async ({ SL, ND, s, mount }) => {
    delivered(s, 'two of them', ['cat.png', 'dog.jpg'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    assertColumn(deliveredBubble(el), { text: true, imgs: 2 }, 'delivered 2 imgs')
  })

// ==================================================================== §7
domTest('§7 PARITY: the same message reads the same queued and delivered',
  async ({ SL, ND, s, mount }) => {
    // THE USER'S ACTUAL REQUEST. Not "the preview is a column" but "the two
    // agree" — so this compares them to each other rather than to a constant.
    // One node, one screen: the delivered copy of an earlier message and the
    // queued copy of the next, which is exactly what they were looking at.
    delivered(s, 'first one', ['cat.png', 'dog.jpg'])
    queue(s, 'first one', ['cat.png', 'dog.jpg'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()

    /** the ordered content blocks, by kind — the arrangement, nothing else */
    const shape = (bubble: Element) => [...contentOf(bubble).children]
      .map((c) => c.classList.contains('msgtext') ? 'text'
        : c.classList.contains('attach-row') ? `attach×${c.children.length}`
          : `?${c.className}`)
    const pend = shape(pendBubble(el))
    const done = shape(deliveredBubble(el))
    assert.deepEqual(pend, done,
      'the queued message and the delivered message are arranged identically')
    // …and not identically EMPTY, which would satisfy deepEqual vacuously
    assert.deepEqual(done, ['text', 'attach×2'], 'fixture: both actually rendered')
  })

// ==================================================================== §8
domTest('§8 the delivery tag keeps its spot — beside the message, not in it',
  async ({ SL, ND, s, mount }) => {
    // explicit user instruction: "keep the 'delivering mid-task' text in the
    // same spot". It was a direct child of the flex bubble, after the content;
    // it still is. Folding it into the new content block would have moved it
    // under the picture, which is the one thing they asked not to happen.
    queue(s, 'steered', ['cat.png'], { delivering: true })
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    const b = pendBubble(el)
    const tag = b.querySelector('.pend-tag')
    assert.ok(tag, 'the tag renders')
    assert.match(tag!.textContent ?? '', /delivering mid-task/)
    assert.ok(tag!.parentElement === b,
      'it hangs off the bubble itself, beside the message — not inside it')
    assert.ok(!tag!.closest('.pendbody'),
      'specifically NOT inside the content block, which would move it below the image')
    const body = b.querySelector(':scope > .pendbody')
    assert.ok(body && (body.compareDocumentPosition(tag!) & 4),
      'and it still comes after the message, where it was')
    assertColumn(b, { text: true, imgs: 1 }, 'delivering bubble')
  })

domTest('§8b the retract ✕ keeps that same spot on an undelivered mail',
  async ({ SL, ND, s, mount }) => {
    // the tag's sibling in the same slot — the other branch of that ternary
    queue(s, 'not yet sent', ['cat.png'])
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    const b = pendBubble(el)
    const x = b.querySelector('.chip-x')
    assert.ok(x, 'the retract button renders while the mail is undelivered')
    assert.ok(x!.parentElement === b, 'in the bubble, beside the message')
    assert.ok(!x!.closest('.pendbody'), 'not inside the message block')
  })

// ==================================================================== §9
domTest('§9 the bubble holds exactly one content block beside the tag',
  async ({ SL, ND, s, mount }) => {
    // the invariant the stylesheet rests on: `.pendrow` is a flex row whose
    // job is the gutter. A second content sibling would be laid out BESIDE
    // the message and bring the original bug back in a new place.
    queue(s, 'words', ['cat.png', 'notes.pdf'], { delivering: true })
    await refreshConvo(SL, ND)
    const el = await mount(deskEl(node(ND), SL))
    await flush()
    const kids = [...pendBubble(el).children]
    assert.equal(kids.length, 2, 'the message block and the tag, nothing else')
    assert.ok(kids[0]!.classList.contains('pendbody'), 'content first')
    assert.ok(kids[1]!.classList.contains('pend-tag'), 'tag second')
  })
