// kbdhire.test.tsx — the keyboard-only hire (user request 2026-08-28):
// "when manually hiring an agent, the name field is auto-focused. upon
// confirming the hire and zooming into desk view, the message entry text area
// is auto focused as well. this should allow a full keyboard-only hire
// workflow beyond the initial hire button click." — and, following up, "i
// think this is already possible, but confirm that an uninitialized hire can
// already be confirmed with enter or ctrl+enter (requiring no click)".
//
// The last sentence of the first request is the specification: after the badge
// click, the mouse is never needed again. That is a CHAIN, and a chain is only
// as good as its weakest link — a focused name field and a focused message box
// with a mouse-only confirm button between them is not a keyboard workflow. So
// this suite walks the whole path in one go and asserts every step of it.
//
// ⚠ HOW THIS IS ASSERTED, AND WHY. Focus is exactly the kind of thing that is
// easy to assert about and easy to assert WRONGLY. Two rules here:
//   • every focus check reads `document.activeElement` and compares it to the
//     element identity — never "a focus() call was made", never a ref, never a
//     class. A handler bound to the wrong node passes the second kind of check
//     and fails the user.
//   • every key check DISPATCHES A REAL KEY and then asserts the CONSEQUENCE —
//     that the hire op actually fired with the right name — never that a
//     handler exists. A handler bound to the wrong element, or shadowed by
//     something else's key handling, is precisely the shape that survives an
//     inspection and dies on a keypress.
//
// ⚠ WHAT jsdom CAN AND CANNOT ANSWER HERE. It does no layout, so nothing in
// this file may be asserted from geometry. It does implement focus, activeElement
// and event dispatch faithfully, which is what this suite is about — and the
// timing hazard the feature really has (the desk mounts DURING an animated
// camera glide, so a focus call can fire before the textarea exists or be
// undone when the glide lands) is reachable here, because the camera and the
// spring both run on the harness's mocked clock. The one thing jsdom cannot
// see is whether the element is VISIBLE when focused — a browser refuses focus
// to a `display:none` element and jsdom does not — and that is what
// tests/kbdhire_probe.py covers next door.
//
// ANTI-VACUITY: §4 and §7 assert the opposite outcome with the same readers,
// so a green §2/§3/§6 cannot be a reader that finds nothing.
//
// ⚠⚠ EVERY § IS A SUBTEST OF ONE PARENT, AND THAT IS LOAD-BEARING — DO NOT
// FLATTEN THEM BACK INTO TOP-LEVEL `test()` CALLS. node:test runs top-level
// tests in a file CONCURRENTLY; `useFakeClock()` swaps a PROCESS-GLOBAL timer
// implementation; and every § here mounts `OrgCanvas`, which polls and runs a
// spring loop on rAF. Flattened, one §'s canvas spins against a clock another
// § has already reset. The first draft of this file was exactly that shape and
// it took the user's machine to 22 GB in 36 seconds — measured by `memory-leak`
// on 2026-08-28, the same trap `pendcol.test.tsx` documents and the third agent
// to hit it. Subtests run SEQUENTIALLY, so only one fake clock is ever live.
//
// The per-§ `timeout` is the second half of that guard: it bounds this file's
// own blast radius so a hang here fails as a test instead of as an incident.
// The runner passes no timeout at all, which is why a hang had no ceiling —
// that half is `memory-leak`'s, not this file's, and this guard should stay
// even after it lands.
//
// ⚠ AND WHILE YOU ARE HERE: compare DOM nodes with `assert.ok(a === b)`, never
// `assert.equal`/`deepEqual`. Not for speed — `memory-leak` measured the
// failure message at a constant 75 characters, sub-millisecond, so the
// once-popular "the diff hangs the runner" story is FALSE (see
// pendcol.test.tsx). The real reason is that a deep compare of two same-tag
// elements PASSES, so such a leg could never fail.
//
// Run:  cd frontend && node tests/run.mjs kbdhire

import {
  advance, FakeServer, flush, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useEffect, useState } from 'react'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import type { OpResult, TreePayload } from '../src/types'

const noop = () => {}

// ---------------------------------------------------------------- fixtures
/** shaped like the payload, not type-checked into it — the fixture idiom of
 *  deskinit/audpile, trimmed to what OrgCanvas actually dereferences */
const asTree = (v: unknown) => v as TreePayload

interface FixNode { id: string; children?: FixNode[] }

function mk(n: FixNode): unknown {
  return {
    id: n.id, title: n.id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: (n.children ?? []).map(mk), lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  }
}

function tree(roots: FixNode[]): TreePayload {
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: roots.map(mk), cost_usd_total: 0,
    audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

// ------------------------------------------------------------- the readers
/** the element the browser would send the next keystroke to */
function active(): Element | null {
  const w = (globalThis as unknown as { window: Window }).window
  return w.document.activeElement
}

/** a short, readable name for whatever has focus — for assertion messages, so
 *  a failure says WHAT was focused instead of "not equal" */
function activeName(): string {
  const el = active()
  if (!el) return '(nothing)'
  const cls = el.className ? '.' + String(el.className).split(/\s+/).join('.') : ''
  return el.tagName.toLowerCase() + cls
}

/** which agent's desk is open, by the class `focusId` drives — or null.
 *  `:not(.user)` because the eye wears `.desk` too for its switchboard, which
 *  is a different surface. */
function openDesk(host: HTMLElement): string | null {
  const card = host.querySelector('.sq.desk:not(.user)')
  if (!card) return null
  return card.querySelector('.cc-name')?.textContent ?? '(desk with no name)'
}

function draftInput(host: HTMLElement): HTMLInputElement | null {
  return host.querySelector('input.df-name')
}

function composer(host: HTMLElement): HTMLTextAreaElement | null {
  return host.querySelector('.sq.desk:not(.user) .cc-composer textarea')
}

// -------------------------------------------------------------- the driver
/** a canvas whose tree the test can REPLACE — what the hire's broadcast
 *  refetch does in the real app, frames after the hire response lands */
function Rig({ boot, op, hold }: {
  boot: TreePayload
  op: (o: Record<string, unknown>) => Promise<OpResult>
  hold: { set?: (t: TreePayload) => void }
}) {
  const [t, setT] = useState(boot)
  useEffect(() => { hold.set = setT }, [hold])
  return <OrgCanvas tree={t} op={op as never} slug="mine" toast={noop}
    mailEvt={null} />
}

interface Kit {
  host: HTMLElement
  setTree: (t: TreePayload) => Promise<void>
  ops: Record<string, unknown>[]
  /** dispatch a real key at whatever currently has focus */
  press: (key: string, mod?: { ctrlKey?: boolean; shiftKey?: boolean })
    => Promise<void>
  /** type into a controlled React input the way a user would */
  type: (el: HTMLInputElement, text: string) => Promise<void>
}

/** The sections, collected rather than registered. `test()` is called ONCE at
 *  the bottom of this file and replays them as sequential subtests — see the
 *  process-global-clock note in the header. Registering them directly would
 *  make them concurrent siblings, which is the shape that took the machine
 *  down. */
const SECTIONS: { name: string; body: (k: Kit) => Promise<void> }[] = []

/** how long any one § may take before it is a failure rather than an
 *  incident. Generous — the slowest § drives a 3s camera glide in 16ms steps
 *  and lands around 200ms — but finite, which is the whole point. */
const SECTION_TIMEOUT = 30_000

function uiTest(name: string, body: (k: Kit) => Promise<void>): void {
  SECTIONS.push({ name, body })
}

async function runSection(t: TestContext, body: (k: Kit) => Promise<void>) {
  {
    useFakeClock()
    installFetch(new FakeServer())
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      resetConvos()
      realClock()
    })
    const ops: Record<string, unknown>[] = []
    const hold: { set?: (x: TreePayload) => void } = {}
    const op = (o: Record<string, unknown>) => {
      ops.push(o)
      return Promise.resolve({ node: 'newbie' } as unknown as OpResult)
    }
    const v = await mountView(
      <Rig boot={tree([{ id: 'boss' }])} op={op} hold={hold} />, (el) => el)
    open.push(v)
    await flush()
    const { act } = await import('react')
    // (off `window`, not `globalThis`: the harness hoists only a hand-picked
    // few of jsdom's constructors onto the global, and these are not among
    // them — the window it built always has all of them)
    const w = (globalThis as unknown as { window: Window }).window as unknown as {
      HTMLInputElement: typeof HTMLInputElement
      Event: typeof Event
      KeyboardEvent: typeof KeyboardEvent
    }
    await body({
      host: v.el, ops,
      setTree: async (x) => { await act(async () => { hold.set?.(x) }) },
      press: async (key, mod = {}) => {
        const el = active()
        assert.ok(el, `pressing ${key} with nothing focused — the keyboard `
          + 'workflow is already broken at this step')
        await act(async () => {
          el.dispatchEvent(new w.KeyboardEvent('keydown',
            { key, bubbles: true, ...mod }))
          await flush()
        })
      },
      type: async (el, text) => {
        // a React controlled input ignores a plain `.value =`; go through the
        // prototype setter and fire the event React actually listens for
        const setter = Object.getOwnPropertyDescriptor(
          w.HTMLInputElement.prototype, 'value')?.set
        assert.ok(setter, 'no value setter on HTMLInputElement')
        await act(async () => {
          setter.call(el, text)
          el.dispatchEvent(new w.Event('input', { bubbles: true }))
          await flush()
        })
      },
    })
  }
}

// ------------------------------------------------------------- the gesture
/** the ONE mouse action the user is allowed: the hire badge. Everything after
 *  this point in every § below is keyboard only. */
async function clickHireBadge(host: HTMLElement): Promise<void> {
  const { act } = await import('react')
  const card = [...host.querySelectorAll('.sq')].find((c) =>
    c.querySelector('.name')?.textContent === 'boss')
  assert.ok(card, 'no card for boss — the fixture did not render')
  // the bottom set (`.hsof` with no `.side`) hires a REPORT. Chips are
  // hover-gated in CSS, not in React, so they are in the document here.
  const chip = card.querySelector('.hsof:not(.side) button.t-haiku')
  assert.ok(chip, 'no bottom hire chip on boss')
  await act(async () => {
    (chip as HTMLButtonElement).click()
    await flush()
  })
  await advance(200)          // spawn()'s 60ms glide-to-draft timer
}

const withNewbie = (id: string) => tree([{ id: 'boss', children: [{ id }] }])

// ==========================================================================
uiTest('§1 the hire draft opens with the NAME FIELD focused', async (k) => {
  await clickHireBadge(k.host)
  const input = draftInput(k.host)
  assert.ok(input, 'the hire badge opened no draft form')
  assert.ok(active() === input,
    `the draft opened with ${activeName()} focused, not the name field — the `
    + 'user has to click before they can type the name')
})

// ==========================================================================
uiTest('§2 ENTER in the name field confirms the hire, with no click',
  async (k) => {
    await clickHireBadge(k.host)
    await k.type(draftInput(k.host)!, 'newbie')
    await k.press('Enter')
    assert.equal(k.ops.length, 1,
      'Enter in the name field submitted no hire — the confirm button is the '
      + 'only way through and the workflow needs the mouse')
    assert.equal(k.ops[0]?.op, 'hire')
    assert.equal(k.ops[0]?.name, 'newbie',
      'the hire fired but not with the typed name')
  })

// ==========================================================================
uiTest('§3 CTRL+ENTER confirms it too', async (k) => {
  await clickHireBadge(k.host)
  await k.type(draftInput(k.host)!, 'newbie')
  await k.press('Enter', { ctrlKey: true })
  assert.equal(k.ops.length, 1,
    'Ctrl+Enter in the name field submitted no hire')
  assert.equal(k.ops[0]?.name, 'newbie')
})

// ==========================================================================
uiTest('§4 CONTROL: Enter on an EMPTY draft hires nothing and leaves the '
  + 'form open', async (k) => {
  // the user's "uninitialized hire" at its barest — the dialog open, nothing
  // typed. A hire needs a name, so the right behaviour is to do nothing at
  // all: not submit a nameless agent, and not close the form either.
  await clickHireBadge(k.host)
  await k.press('Enter')
  assert.equal(k.ops.length, 0,
    'Enter on an empty draft submitted a hire with no name')
  assert.ok(draftInput(k.host),
    'Enter on an empty draft CLOSED the form — the user loses the dialog by '
    + 'pressing the key that should confirm it')
  // …and it is still ready for the name, so the recovery is just to type
  assert.ok(active() === draftInput(k.host),
    `after a no-op Enter the focus moved to ${activeName()}`)
})

// ==========================================================================
uiTest('§5 ESCAPE cancels the draft and hires nothing', async (k) => {
  await clickHireBadge(k.host)
  await k.type(draftInput(k.host)!, 'newbie')
  await k.press('Escape')
  assert.equal(k.ops.length, 0, 'Escape submitted a hire')
  assert.equal(draftInput(k.host), null,
    'Escape left the draft form open — it is the conventional cancel and the '
    + 'only keyboard way out')
})

// ==========================================================================
uiTest('§6 THE WHOLE CHAIN: badge → type → Enter → the new desk opens with '
  + 'the MESSAGE BOX focused', async (k) => {
  await clickHireBadge(k.host)
  await k.type(draftInput(k.host)!, 'newbie')
  await k.press('Enter')
  assert.equal(k.ops.length, 1, 'the draft did not submit a hire op')

  await k.setTree(withNewbie('newbie'))
  await advance(3000)        // the card is born, its spring settles, the glide

  assert.equal(openDesk(k.host), 'newbie',
    'the new agent’s desk did not open at all')
  const ta = composer(k.host)
  assert.ok(ta, 'the desk opened with no message box in it')
  assert.ok(active() === ta,
    `the desk opened with ${activeName()} focused, not the message box — the `
    + 'user still has to reach for the mouse to type the kickoff, which is '
    + 'the whole point of the request')
  // the box must also be usable: a disabled textarea can hold focus in jsdom
  // but takes no keystrokes anywhere
  assert.equal(ta.disabled, false,
    'the message box is focused but disabled — focus on a dead control is '
    + 'worse than no focus, because it looks ready')
})

// ==========================================================================
uiTest('§7 CONTROL: the message box focus is not free — it does not happen '
  + 'while no desk is open', async (k) => {
  // §6 would be vacuous if something focused a composer regardless. Before the
  // hire there is no desk and no composer, and focus must be on neither.
  assert.equal(openDesk(k.host), null, 'a desk was already open at rest')
  assert.equal(composer(k.host), null, 'a composer exists with no desk open')
  await clickHireBadge(k.host)
  assert.equal(composer(k.host), null,
    'a composer exists while only the draft is open — §6 would be reading a '
    + 'focus that was already there')
})

// ==========================================================================
// THE ONE TOP-LEVEL TEST. Everything above only COLLECTED itself; this is
// where the sections actually run, and they run one at a time. See the header:
// concurrent top-level tests plus a process-global fake clock plus a polling
// mount is the combination that took the machine to 22 GB.
test('keyboard-only hire', { concurrency: 1 }, async (t: TestContext) => {
  for (const s of SECTIONS) {
    await t.test(s.name, { timeout: SECTION_TIMEOUT },
      (st: TestContext) => runSection(st, s.body))
  }
})
