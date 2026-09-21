// attentionaudit.test.tsx — the Attention view's mount rule rests on an
// EXHAUSTIVENESS ARGUMENT about other people's code. This checks it.
//
// `useAwaitingRestore` in attention/AttentionView.tsx decides when a panel
// mounted for a pending window restore may be released, and its three states —
// landed, pending, closed — are only exhaustive while one claim holds:
//
//     NO CALLER CAN CLEAR AN ATTENTION-KIND ROW EXCEPT THE SURFACE THAT OWNS IT
//
// That claim is about `windowlayout.ts` and its callers, none of which this
// feature owns. An argument written in a comment decays silently: somebody adds
// a caller, greps the comment, finds it does not describe their code, and
// concludes the comment is stale rather than that they have just invalidated an
// exhaustiveness proof. That is the failure v3-ux-review-opus described in
// finding f2 — and f2 existed because the comment's first draft undercounted
// the callers, which is exactly the decay arriving early.
//
// So the audit is enforced rather than asserted. These tests fail the moment
// the caller set changes, and they say what to do about it. They are
// deliberately NOT a style rule: a new caller is allowed, it just has to be
// looked at, and the failure message is where that look starts.
//
// ⚠ IT PINS A SET, NOT A COUNT. A count tells a maintainer that something moved;
// the set tells them WHICH call is new, which is the only part that helps.
//
// Run:  node apps/desktop/renderer/tests/run.mjs attentionaudit

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { OrgSlotContext } from '../src/canvas/OrgCanvas'
import type { AttentionViewProps } from '../src/attention/AttentionView'

declare const __SRC_DIR__: string

/** every .ts/.tsx under the renderer's src, with its repo-relative name */
function sources(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      const rel = prefix ? `${prefix}/${entry}` : entry
      if (statSync(full).isDirectory()) { walk(full, rel); continue }
      if (!/\.tsx?$/.test(entry)) continue
      out.push({ name: rel, text: readFileSync(full, 'utf8') })
    }
  }
  walk(__SRC_DIR__, '')
  return out
}

/** Call sites of `fn`, as "file :: the calling line", ignoring imports, the
 *  declaration itself, and prose in comments — a mention is not a call.
 *
 *  ⚠ NOT "file:line", WHICH IS WHAT THIS PINNED FIRST AND WAS WRONG. Merging a
 *  dependency shifted every caller in popout.tsx by a couple of hundred lines
 *  and fired §1 with nothing whatever having changed about WHO calls it. A
 *  tripwire that cries on unrelated edits is one people learn to re-baseline
 *  without reading, which is the opposite of the point.
 *
 *  The calling LINE is stable under edits elsewhere in the file and still says
 *  which call is new, which is the only part that helps. Duplicates are kept
 *  rather than deduped, so two identical call lines cannot hide a new one
 *  behind an old one — the list's length is the count. */
function callsOf(fn: string): string[] {
  const hits: string[] = []
  for (const { name, text } of sources()) {
    text.split('\n').forEach((line) => {
      if (!line.includes(`${fn}(`)) return
      const trimmed = line.trim()
      if (trimmed.startsWith('import ') || trimmed.startsWith('*')
        || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
      if (new RegExp(`(export\\s+)?function\\s+${fn}\\s*\\(`).test(line)) return
      hits.push(`${name} :: ${trimmed}`)
    })
  }
  return hits.sort()
}

const WHY = (what: string) => `
${what}

WHY THIS TEST EXISTS. attention/AttentionView.tsx's useAwaitingRestore releases a
panel that was mounted so a saved window could be restored into it. Its three
states are exhaustive only while no caller can clear an attention-kind row
except the surface that owns it. A new caller may well be fine — the OrgCanvas
one is, because it can only reach rows carrying restore.document — but it has
to be LOOKED AT, and the audit comment in useAwaitingRestore has to be updated
to say why the new one is harmless. Do that, then update the set below.`

test('§1 closeSavedWindow\'s callers are the three the audit accounts for', () => {
  assert.deepEqual(callsOf('closeSavedWindow'), [
    // inside MovableSurface: the surface that owns the window.
    // ⚠ THE REDOCK CALL IS GUARDED — a BORROWING surface deliberately does not
    // flip the row. That NARROWS the set of writes rather than widening it, so
    // the invariant holds a fortiori; nothing in Attention sets `borrow`.
    'popout.tsx :: if (!transient) closeSavedWindow(layoutKey)',
    'popout.tsx :: closeSavedWindow(layoutKey)',   // the surface's own unmount
    // NOT in MovableSurface. Harmless for this feature because it closes rows
    // drawn from restoredWindows(...).filter(r => r.restore?.document), and an
    // attention-kind row never carries one — this view passes no `restore`.
    'canvas/OrgCanvas.tsx :: closeSavedWindow(row.key); '
      + 'setRestoredDocs(old => old.filter(r => r.key !== row.key))',
  ].sort(), WHY('A caller of closeSavedWindow was added or removed.'))
})

test('§2 saveWindow is not called from outside its own module', () => {
  const outside = callsOf('saveWindow').filter((at) => !at.startsWith('windowlayout.ts '))
  assert.deepEqual(outside, [], WHY(
    'saveWindow is exported, so `open: false` can be written WITHOUT going '
    + 'through closeSavedWindow. Until now nothing outside windowlayout.ts called '
    + 'it, which is what makes "closeSavedWindow is the only writer" true. '
    + 'Something does now.'))
})

test('§3 captureWindow never records a window as closed', () => {
  // its signature is (key, kind, org, w, open = true, restore?) — the flag is a
  // parameter, so a call passing `false` would be a fourth write path
  const bad: string[] = []
  for (const { name, text } of sources()) {
    if (name === 'windowlayout.ts') continue
    text.split('\n').forEach((line, i) => {
      if (!line.includes('captureWindow(')) return
      if (line.trim().startsWith('import ')) return
      // the 5th argument, when one is given at all
      const args = line.slice(line.indexOf('captureWindow(') + 'captureWindow('.length)
      if (/,\s*false\s*[,)]/.test(args)) bad.push(`${name}:${i + 1}`)
    })
  }
  assert.deepEqual(bad, [], WHY(
    'A captureWindow call now passes open=false, which records a window as '
    + 'closed without going through closeSavedWindow.'))
})

test('§4 the Attention panels record no `restore` payload, which is what makes '
  + 'the third closeSavedWindow caller unable to reach them', () => {
  const view = readFileSync(path.join(__SRC_DIR__, 'attention', 'AttentionView.tsx'), 'utf8')
  // usePersistedModalOpen(kind, org, open, restore?) — this view passes three
  // arguments, never a fourth. A restore payload carrying `document` is exactly
  // what OrgCanvas's restored-document reader filters on.
  const calls = view.match(/usePersistedModalOpen\([^)]*\)/g) ?? []
  assert.equal(calls.length, 2, 'both panels register their open marker')
  for (const call of calls) {
    assert.equal(call.split(',').length, 3,
      `${call} now passes a restore payload. If it ever carries \`document\`, `
      + 'OrgCanvas\'s restored-document reader can close the row out from under '
      + 'this view — see the audit in useAwaitingRestore.')
  }
  assert.equal(/restore=\{/.test(view), false,
    'no PinFrame here passes a `restore` prop either')
})

// ------------------------------------------------------------------ §5
//
// A MUTATION KILLED BY A CRASH IS NOT A KILL, and this is what stops one
// coming back. MEASURED under a real mutant (finding f4): an assertion handed a
// jsdom element as `actual` takes ~4.7 SECONDS to fail and dies with
// `RangeError: Array buffer allocation failed`, because node's reporter
// serialises that element together with its document and window graph. The
// same assertion with a boolean actual fails in ~3ms with its own message.
//
// The cost is not cosmetic. A crash cannot distinguish "the assertion caught
// the defect" from "the process died", and it can take later cases in the file
// down with it — so the suite stops reporting exactly when it has something to
// say. Under the f4 mutant three cases silently did not run.
//
// This pins the rule for THIS FEATURE'S OWN SUITES only. It is not a project
// style rule and does not reach anyone else's tests.
//
// ⚠ IT PATROLS, IT DOES NOT ENFORCE — and knowing the difference is the whole
// point, because a check believed to be exhaustive is worse than a check known
// to be partial. It is a SINGLE-LINE regex, so at least two ordinary shapes walk
// straight past it (v3-ux-review-opus, reviewing this very test):
//
//   const el = v.el.querySelector('.attn-empty')
//   assert.equal(el, null)          // the assertion line names no DOM at all
//
//   assert.equal(                   // call and node on different lines, so
//     v.el.querySelector('.x'),     // neither line matches both halves
//     null)
//
// Both crash exactly as the flagged shape does. They are not caught, and a
// green §5 therefore means "the common shape is absent", never "no assertion
// can blow up". Chasing them would mean parsing rather than grepping, which is
// a worse trade than saying plainly what this does not cover — so if you are
// adding an assertion that touches the DOM, the rule in the header is yours to
// follow, not this test's to catch.

test('§5 the common DOM-node-as-actual shape is absent (patrolled, not enforced)', () => {
  const offenders: string[] = []
  for (const name of readdirSync(path.join(__SRC_DIR__, '..', 'tests'))) {
    if (!/^attention.*\.test\.tsx$/.test(name) && name !== 'polledstatus.test.tsx') continue
    const text = readFileSync(path.join(__SRC_DIR__, '..', 'tests', name), 'utf8')
    text.split('\n').forEach((line, i) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
      // an equality assertion whose first argument reaches a DOM node without
      // being reduced to a boolean, a string or an attribute first
      if (!/assert\.(equal|deepEqual|strictEqual|notEqual)\(/.test(line)) return
      if (!/querySelector|\.el|parentElement/.test(line)) return
      if (/!!|\?\.|textContent|getAttribute|className|\.length|=== |!== /.test(line)) return
      offenders.push(`${name}:${i + 1}  ${trimmed}`)
    })
  }
  assert.deepEqual(offenders, [], `
An assertion is handing a DOM node to the reporter. When it FAILS it will take
seconds and die with RangeError: Array buffer allocation failed instead of
printing its message, and it may take later cases in the file with it — which
is finding f4, measured rather than supposed.

Reduce it first: \`!!el.querySelector(sel)\`, a \`textContent\`, an attribute, or
\`assert.ok(a === b, message)\`. The message carries the meaning either way.`)
})

// ------------------------------------------------------------------ §6
//
// THE HOST'S SLOT CONTRACT, CHECKED BY THE COMPILER RATHER THAN BY ME READING IT.
//
// `OrgCanvas` renders a view in its slot as `renderOrgSlot(ctx)`, so whoever
// composes this feature writes something very close to
// `<AttentionView {...ctx} />`. That only works while every field of
// `OrgSlotContext` is accepted by `AttentionViewProps` — and "I compared the
// two interfaces by eye" is exactly the claim that was false once already:
// the host's `onOpenMail` is the canonical `MailLinkFn` while this view's took
// a `TypedRef`, so the spread would not have compiled and the mismatch was
// invisible until somebody tried it.
//
// This is a TYPE-LEVEL assertion. It costs nothing at runtime — the import is
// erased — and it fails at `tsc` the moment the host widens its context or this
// view narrows its props. The runtime body only exists so the file reports it.

/** structurally assignable, checked at compile time */
type SlotFits = OrgSlotContext extends Omit<AttentionViewProps, 'treeStatus'>
  ? true : never
const SLOT_FITS: SlotFits = true

test('§6 the host OrgSlotContext is accepted by AttentionViewProps', () => {
  // `treeStatus` is deliberately excluded above: it is NOT part of the slot
  // context, and supplying it is a composition obligation the host takes on
  // separately. Everything else the host hands over must fit as it stands.
  assert.equal(SLOT_FITS, true,
    'If this file no longer compiles, the host and this view have drifted: '
    + 'a field of OrgSlotContext is not accepted by AttentionViewProps. Fix '
    + 'THIS view to match the published contract, or route the difference to '
    + 'the host owner — do not widen the assertion.')
})
