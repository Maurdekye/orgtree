// envelopeflash.test.tsx — THE MACHINE ENVELOPE NEVER FLASHES AS THE USER'S
// WORDS, AND THE PENDING TAG NAMES WHERE A MESSAGE REALLY IS (D-229).
//
// User report, 2026-09-02: "i saw the turn envelope associated information for
// a second there before it reverted to a normal user turn message".
//
// The browser strips no markers, by ruling (orgstate.test.tsx: the desk must
// never guess authorship from marker-looking strings). So whether the reader
// ever sees `[ORG STATE …]` / `[PROVIDER USAGE …]` / a raw `[MAIL …]` block is
// decided ENTIRELY by what the server puts in `messages[]` — and the fix for
// the flash is server-side (read_chat reloads its projection sidecar on a
// fresh miss and otherwise HOLDS the row back for that poll, covered by the
// pending bubble). This file is the contract's other half: given the payload
// sequence the fixed server produces, EVERY frame the desk paints carries the
// user's message exactly once and never the chrome.
//
// ⚠ EVERY FRAME, NOT THE SETTLED DOM. A MutationObserver on the mounted host
// snapshots `textContent` after every DOM mutation batch React commits, so an
// intermediate paint — a frame between "bubble gone" and "row drawn", or a
// row drawn raw and then re-drawn projected — is recorded and judged, not
// skipped over by a final-state assertion. (jsdom does no layout, so a
// "frame" here is a DOM commit; there is no paint to sample below that.)
//
// ⚠ ANTI-VACUITY. §3 feeds the payload the OLD server produced (the raw user
// event) and requires the instrument to REPORT the chrome. A detector that
// cannot see the leak would make §1/§2 mean nothing.
//
// Run:  cd frontend && node tests/run.mjs envelopeflash

import {
  FakeServer, flush, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { refreshConvo, resetConvos } from '../src/convo'
import { DeskChat, pendTag } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, PendingMail } from '../src/types'

let _n = 0
const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

function node(id: string): CanvasNode {
  return {
    id, state: 'live', tier: 'sol', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'sol',
  }
}

/** the strings a user bubble must never carry */
const CHROME = ['[ORG STATE', '[END ORG STATE]', '[PROVIDER USAGE',
  '[END PROVIDER USAGE]', '[MAIL —', '[END MAIL]']

const MACHINE = '[ORG STATE #1 — current as of 2026-09-02T09:55:03.538Z. Newest wins; '
  + 'EARLIER COPIES IN THIS CONVERSATION ARE STALE.]\nYour reports: none yet.\n'
  + '[END ORG STATE]\n\n[PROVIDER USAGE #1 — current as of 2026-09-02T09:55:03Z]\n'
  + 'claude/primary* | session | 100% | limit-active\n[END PROVIDER USAGE]\n\n'

/** the projected user event — what the FIXED server puts in `messages[]`:
 *  the [MAIL] block (the desk parses it into a card) plus the trailing nudge */
const visibleOf = (at: string, body: string) =>
  `[MAIL — 1 message(s)]\nFROM @user (USER ⚠ THE USER — user instructions outrank your chain) · message · ${at}\n${body}\n[END MAIL]\n\n`
  + '(orgtree) The mail above includes a message from the user, addressed to you — act on it now.'

/** the RAW user event — what the OLD server put in `messages[]` for one poll */
const rawOf = (at: string, body: string) => MACHINE + visibleOf(at, body)

const count = (hay: string, needle: string) => hay.split(needle).length - 1
const chromeIn = (s: string) => CHROME.filter((c) => s.includes(c))

interface Kit {
  SL: string; ND: string; s: FakeServer
  el: HTMLElement
  /** every DOM commit's textContent, oldest first */
  frames: string[]
  /** record the current DOM as a frame too (belt: a step that committed
   *  nothing still contributes the state the reader was looking at) */
  snap: () => void
}

function frameTest(name: string, body: (k: Kit) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const SL = 'org'
    const ND = `ef${++_n}`
    const s = new FakeServer()
    installFetch(s)
    const nd = node(ND)
    const v = await mountView(
      <DeskChat node={nd} map={new Map([[nd.id, nd]])} op={op} slug={SL}
        toast={noop} pub={false} bare />,
      (host) => host)
    const frames: string[] = []
    // What the reader sees in the chat, minus the "↑ you: …" jump pin: that
    // overlay deliberately repeats the LAST user message's label as a
    // scroll-to control, so it is a second, legitimate copy of the words and
    // not a second message row. Everything else in the desk is judged.
    const scene = (host: HTMLElement): string => {
      const clone = host.cloneNode(true) as HTMLElement
      clone.querySelectorAll('.pinuser').forEach((n) => n.remove())
      return clone.textContent || ''
    }
    const MO = (globalThis as unknown as { window: { MutationObserver: typeof MutationObserver } })
      .window.MutationObserver
    const mo = new MO(() => { frames.push(scene(v.el)) })
    mo.observe(v.el, { subtree: true, childList: true, characterData: true })
    t.after(async () => {
      mo.disconnect()
      try { await v.unmount() } catch { /* gone */ }
      resetConvos()
      realClock()
    })
    await body({ SL, ND, s, el: v.el, frames, snap: () => frames.push(scene(v.el)) })
  })
}

// ── §1 the handover the fixed server produces, frame by frame ──────────────
frameTest('§1 pending → held → projected: the message is on screen exactly once in '
  + 'EVERY frame and the chrome in none', async ({ SL, ND, s, frames, snap, el }) => {
  const body = 'please use the fallback, i just reconfigured it'
  s.assistantMsg('an answer from an earlier turn')
  await refreshConvo(SL, ND, { force: true })
  await flush()
  snap()
  const before = frames.length

  // 1. the user posts; the turn drains it: pending, via turn, stage turn
  const m = s.postMail(body)
  s.drain()
  m.stage = 'turn'
  await refreshConvo(SL, ND, { force: true })
  await flush()
  snap()

  // 2. the provider echoed the event but its projection row was torn/late:
  //    the server HOLDS the row back — the payload is unchanged except for
  //    the receipt, so the bubble stays and nothing raw appears
  s.chat = ((orig) => (last: number | null) =>
    ({ ...orig(last), prompts_withheld: 1 }))(s.chat.bind(s))
  await refreshConvo(SL, ND, { force: true })
  await flush()
  snap()

  // 3. the row lands, projected — the same payload retires the bubble
  const at = m.at
  s.echo()
  s.messages[s.messages.length - 1]!.text = visibleOf(at, body)
  s.chat = ((orig) => (last: number | null) =>
    ({ ...orig(last), prompts_withheld: 0 }))(s.chat.bind(s))
  await refreshConvo(SL, ND, { force: true })
  await flush()
  snap()

  const judged = frames.slice(before)
  assert.ok(judged.length >= 3,
    `the instrument recorded the handover's frames — got ${judged.length}`)
  judged.forEach((f, i) => {
    assert.equal(count(f, body), 1,
      `frame ${i}: the message is on screen exactly once — got ${count(f, body)} in ${JSON.stringify(f.slice(0, 300))}`)
    assert.deepEqual(chromeIn(f), [],
      `frame ${i}: no machine chrome — found ${JSON.stringify(chromeIn(f))}`)
  })
  // …and the settled state is a NORMAL user turn message: the mail card,
  // not a pending bubble
  assert.ok(el.querySelector('.turn-mail.from-user'),
    'the durable row renders as the user mail card')
  assert.equal(el.querySelectorAll('.msg.user.pending').length, 0,
    'the pending bubble is gone once the row exists')
})

// ── §2 the stage receipt is the tag the reader sees ────────────────────────
frameTest('§2 the pending tag says where the message IS — and a stranded one is a '
  + 'warning, never "delivering…"', async ({ SL, ND, s, el }) => {
  const rows: PendingMail[] = [
    { id: 't', from: '@user', body: 'riding the turn', at: '2026-09-02T09:51:37.383Z',
      delivering: true, via: 'turn', stage: 'turn' },
    { id: 's', from: '@user', body: 'in the steer store', at: '2026-09-02T09:51:37.384Z',
      delivering: true, stage: 'steer' },
    { id: 'q', from: '@user', body: 'behind the busy turn', at: '2026-09-02T09:51:37.385Z',
      delivering: true, stage: 'queued' },
    { id: 'x', from: '@user', body: 'owned by nobody', at: '2026-09-02T09:51:37.386Z',
      delivering: true, stage: 'stranded' },
    // a backend from before the receipt existed: the two legacy labels
    { id: 'lt', from: '@user', body: 'legacy turn', at: '2026-09-02T09:51:37.387Z',
      delivering: true, via: 'turn' },
    { id: 'ls', from: '@user', body: 'legacy steer', at: '2026-09-02T09:51:37.388Z',
      delivering: true },
  ]
  s.busy = true
  s.pending_mail.push(...rows)
  await refreshConvo(SL, ND, { force: true })
  await flush()

  const tagOf = (body: string): HTMLElement => {
    const bubble = Array.from(el.querySelectorAll<HTMLElement>('.msg.user.pending'))
      .find((b) => (b.textContent || '').includes(body))
    assert.ok(bubble, `a bubble for ${JSON.stringify(body)} is on screen`)
    const tag = bubble!.querySelector<HTMLElement>('.pend-tag')
    assert.ok(tag, `the bubble for ${JSON.stringify(body)} carries a tag`)
    return tag!
  }
  assert.equal(tagOf('riding the turn').textContent, 'delivering…')
  assert.equal(tagOf('in the steer store').textContent, 'delivering mid-task…')
  assert.match(tagOf('behind the busy turn').textContent || '', /^queued — delivers at the next turn boundary/)
  const stranded = tagOf('owned by nobody')
  assert.match(stranded.textContent || '', /stuck — no turn owns this message/)
  assert.ok(stranded.classList.contains('warn'), 'the stranded tag is a WARNING')
  // the legacy shapes keep their exact words
  assert.equal(tagOf('legacy turn').textContent, 'delivering…')
  assert.equal(tagOf('legacy steer').textContent, 'delivering mid-task…')
  // …and no other tag wears the warning
  assert.equal(el.querySelectorAll('.pend-tag.warn').length, 1)
  // the pure function agrees with the DOM (so a test elsewhere can use it)
  assert.equal(pendTag(rows[3]!), stranded.textContent)
})

// ── §3 anti-vacuity: the instrument SEES the leak the fix removes ──────────
frameTest('§3 the OLD server\'s raw row IS reported by the frame instrument — so a '
  + 'clean §1 is clean, not blind', async ({ SL, ND, s, frames, snap }) => {
  const body = 'the leak the fix removes'
  await refreshConvo(SL, ND, { force: true })
  await flush()
  const before = frames.length
  // what read_chat handed the desk for one poll before D-229: the whole
  // provider event, projection missing
  s.userMsg(rawOf('2026-09-02T09:55:01.944Z', body))
  await refreshConvo(SL, ND, { force: true })
  await flush()
  snap()
  const leaked = frames.slice(before).filter((f) => chromeIn(f).length > 0)
  assert.ok(leaked.length > 0,
    'the raw row renders its chrome (the desk strips none, by ruling) and the instrument reports it')
  assert.ok(leaked.some((f) => f.includes('[PROVIDER USAGE') && f.includes('[ORG STATE')),
    'both machine blocks are what leaked — the user\'s exact observation')
})
