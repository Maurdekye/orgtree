// histident.dump.tsx — STEP 1 of the agent-history identity probe.
//
// Renders the REAL desk history tab under the repo's jsdom harness and writes
// its markup to a file. It asserts nothing about how any of it LOOKS: jsdom
// has no box model and no cascade, so "the model chip sits beside the name"
// is a question it answers by abstaining, and an abstention reads exactly
// like a pass. Step 2 (`histident_probe.py`) measures in a real engine.
//
// THE DEFECT (user screenshot 2026-09-11, uploads/image-73.png): in a LEGACY
// history row the provider letter sat on a line of its own ABOVE the agent
// name. `AgentName` is a FRAGMENT by contract — a chip box and a name box,
// side by side — and `.tier` is `display: grid`, which is BLOCK-level, so in
// an ordinary inline span the chip takes a whole line and strands the name
// under it. The projected event rows never showed it because `.event-actor`
// already wraps their actor in an inline-flex.
//
// The page therefore carries five rows that differ in exactly one thing each:
//   · a legacy row with a LONG detail    — the screenshot's own scene
//   · a legacy row with a SHORT detail   — the chip is block-level whatever
//                                          the width, so this must hold too
//   · a legacy row with a LONG NAME      — the price of an unbreakable
//                                          identity, kept under the probe
//   · a legacy row naming a sender this tree does NOT hold — no chip at all,
//     the control that stops "chip beside name" being vacuously true
//   · a projected EVENT row — already correct, and the positive control that
//     the measurement downstream can see a right answer as well as a wrong one

import '../tests/harness'
import { writeFileSync, readFileSync } from 'node:fs'
import { createElement } from 'react'
import path from 'node:path'

declare const __SRC_DIR__: string

const AT = '2026-09-11T09:08:41.000Z'
const CHARTER = 'Implement the narrowly assigned update-ready visual treatment.'
  + ' Work in your own branch/worktree from main under scratch; never edit the'
  + ' shared checkout source directly.'

const scope = JSON.parse(readFileSync(
  path.resolve(__SRC_DIR__, '../tests/fixtures/events/access.scope_changed.json'), 'utf8'))

const ITEMS = [
  // the screenshot's own row: a long `detail` that makes the row wrap
  { at: AT, kind: 'hire', actor: 'coordinator-astra',
    detail: { node: 'update-glow', parent: 'coordinator-astra', tier: 'flash',
      grant: 0, charter: CHARTER } },
  // the same identity with almost no detail beside it — the chip is
  // block-level regardless of how much room the row has, so the one-line
  // claim has to hold here too or it is a claim about width, not about layout
  { at: '2026-09-11T09:17:18.000Z', kind: 'mail', actor: 'retirement-opus',
    detail: { text: 'no reply needed.' } },
  // ⚠ THE TRADE THE FIX MAKES, put under the instrument. `white-space:
  // nowrap` means a name can no longer break mid-word, so a long one in a
  // narrow row would hang out of it instead of wrapping. This is the longest
  // agent id this org has produced, doubled: if the overflow check stays
  // quiet on THIS at 340px, the trade is paid for.
  { at: '2026-09-11T09:19:00.000Z', kind: 'mail',
    actor: 'account-fallback-review-coordinator-astra',
    detail: { text: 'the longest identity the row has to carry' } },
  // THE CONTROL: a sender this tree cannot vouch for draws a bare name and no
  // chip at all, so a probe that finds a chip beside every name is measuring
  // something real rather than answering about a page with no chips in it
  { at: '2026-09-11T09:18:00.000Z', kind: 'mail', actor: 'nobody-here',
    detail: { text: 'an actor this tree does not hold' } },
  // the PROJECTED row, which already keeps its identity together
  { at: '2026-09-11T09:20:55.000Z', kind: 'notice', actor: 'coordinator-astra',
    detail: { text: 'scope change fallback' },
    ev: { ...scope.private, actor: { kind: 'agent', id: 'coordinator-astra' },
      by: 'coordinator-astra' } },
]

;(globalThis as unknown as Record<string, unknown>).fetch = (url: string) => {
  const ok = (payload: unknown) => Promise.resolve({
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve(payload),
  })
  const u = String(url)
  if (u.includes('/history')) return ok({ items: ITEMS })
  if (u.includes('/audiences')) return ok({ audiences: [], requests: [] })
  if (u.includes('/chat')) return ok({
    messages: [], busy: false, responding: false, queued: 0, last_error: null,
    occupancy: 0, pending_mail: [], live: [], draft_epoch: 'boot0:0', instance: 'inst-0',
  })
  return ok({})
}

const agent = (id: string, tier: string) => ({
  id, generation: 1, state: 'live', tier, children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, model_id: tier,
})

const main = async () => {
  const { mountView, flush } = await import('../tests/harness')
  const { act } = await import('react')
  const { DeskChat } = await import('../src/canvas/desk')

  const worker = agent('update-glow', 'flash')
  const map = new Map<string, unknown>([
    [worker.id, worker],
    ['coordinator-astra', agent('coordinator-astra', 'sonnet')],
    ['retirement-opus', agent('retirement-opus', 'opus')],
    ['account-fallback-review-coordinator-astra', agent('account-fallback-review-coordinator-astra', 'haiku')],
  ])
  const view = await mountView(
    createElement(DeskChat, {
      node: worker, map, op: () => Promise.resolve({}), slug: 'org1',
      toast: () => {}, pub: false, bare: true, onJump: () => {},
    } as never),
    (el: HTMLElement) => el)
  await act(async () => { await flush(8) })

  // the tab is CLICKED, not set: `view` is DeskChat's own state and there is
  // no prop for it, so reaching this markup any other way would be reaching a
  // component the reader cannot get to
  const tab = [...view.el.querySelectorAll('.cc-tabs button')]
    .find((b) => (b.textContent ?? '').trim().startsWith('history'))
  if (!tab) throw new Error('the desk has no history tab to open — the fixture '
    + 'is wrong, and every measurement downstream would be of nothing')
  await act(async () => { (tab as HTMLElement).click(); await flush(8) })
  const html = view.el.innerHTML

  // ⚠ FAIL LOUD IF THE MARKUP IS NOT THE THING UNDER TEST. Without this the
  // dump could be a "loading…" placeholder, or the view could have stopped
  // drawing identities at all, and the probe downstream would measure nothing
  // and report no failures — the abstention that reads as a pass, one layer up.
  const want: [string, number][] = [
    ['hist-row', 4],
    ['hist-event', 1],
    ['tier t-sonnet', 1],
    ['tier t-opus', 1],
    ['cc-name', 4],
    ['nobody-here', 1],
  ]
  for (const [cls, n] of want) {
    const got = (html.match(new RegExp(cls, 'g')) ?? []).length
    if (got < n) {
      throw new Error(`the history dump has ${got} × "${cls}", want at least `
        + `${n} — the fixture is wrong, or the view stopped drawing it. `
        + `First 800 chars:\n${html.slice(0, 800)}`)
    }
  }
  // …and the CONTROL row must really be chipless, or "a row without an
  // identity looks different" downstream is a comparison between two rows
  // that are in fact the same
  const rows = [...view.el.querySelectorAll('.hist-row')]
  const plain = rows.find((r) => (r.textContent ?? '').includes('nobody-here'))
  if (!plain) throw new Error('no control row in the dump')
  if (plain.querySelector('.tier')) {
    throw new Error('the control row grew a model chip — it is no longer a '
      + 'control, and the chip checks downstream would prove nothing')
  }

  const dest = process.argv.slice(2).find((a) => !a.startsWith('--'))
  if (!dest) throw new Error('usage: histident.dump <out.html>')
  // `bare` DeskChat renders its own `.desk-body` wrapper, so nothing is added
  // around it here — the cascade the rows see is their own.
  writeFileSync(dest, `<div class="viewport">${html}</div>`)
  console.log(`dumped ${html.length} bytes`)
}

await main()
// jsdom's window and the panel's poll timers hold the event loop open; this is
// a one-shot dump, so leave rather than wait for them
process.exit(0)
