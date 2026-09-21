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
