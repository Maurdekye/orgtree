// wcc848de4, mobile half — the credit stepper's two dead ends.
//
// ⚠ SEPARATE FILE ON PURPOSE. `isMobile` is computed ONCE, at the moment
// `src/mobile.tsx`'s module body runs, so the flag cannot be toggled between
// tests inside one bundle. The stepper is mobile-only (a finger cannot
// resolve ~2px per credit on the drag bar), so this file sets the escape
// hatch before it imports anything that reaches mobile.tsx, and every test
// in it runs as a phone. Desktop sites live in whydisabled.test.tsx.
//
// ⚠ AND THIS IS THE FILE THAT PROVES THE HELPERS ARE WIRED UP. The pure
// checks in whydisabled.test.tsx pass whether or not a single button ever
// calls stepDownWhy/stepUpWhy. These read the title off the real rendered
// buttons of both credit cards — the standalone CreditAsk and the composed
// batch card — so deleting a `title=` from either one fails here.
//
// Run: cd frontend && node tests/run.mjs whydisabledstep

import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { AskInfo, ToastFn } from '../src/types'

localStorage.setItem('orgtree-mobile', '1')

// dynamic, so the flag above is set before mobile.tsx's body ever runs
const { AskCard } = await import('../src/canvas/asks')
const { isMobile } = await import('../src/mobile')

// ⚠ DECLARE INERT RATHER THAN PASS QUIETLY. If the escape hatch ever stops
// working, the stepper is not rendered at all, every `assert.ok(btn)` below
// would be the only thing failing, and a future reader would hunt the wrong
// bug. Say it once, here, in the terms that actually matter.
test('§0 the rig really is in mobile mode — without it there is no stepper',
  () => {
    assert.equal(isMobile, true,
      'localStorage escape hatch did not take: mobile.tsx must not be '
      + 'imported (directly or transitively) before it is set')
  })

const toast: ToastFn = (() => {}) as unknown as ToastFn

/** the dry-run preview CreditAsk fires on mount, answered with no warnings */
function stubFetch() {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    (() => Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve({ ok: true, warnings: [] }),
    })) as unknown as typeof fetch
}

const creditAsk = (old: number, asked: number): AskInfo => ({
  id: 'req1', node: 'agent', kind: 'credit', status: 'open',
  at: '2026-09-05T10:00:00Z', old, new: asked,
} as AskInfo)

/** the same credits question as the COMPOSED batch card (FR-14) */
const batchAsk = (old: number, asked: number): AskInfo => ({
  id: 'req2', node: 'agent', kind: 'batch', status: 'open',
  at: '2026-09-05T10:00:00Z',
  tabs: [{ kind: 'credits', old, new: asked }],
  revs: { credits: 1 },
} as unknown as AskInfo)

async function stepper(ask: AskInfo, committed: number, maxTop?: number) {
  stubFetch()
  const view = await mountView(
    <AskCard ask={ask} slug="org" toast={toast} seat={1}
      committed={committed} maxTop={maxTop} segments={[]} pxc={2} />,
    (el) => el,
  )
  await inAct(async () => { await Promise.resolve() })
  // re-queried on every read: the offer lives in component state, so the
  // buttons after a step are not necessarily the same DOM nodes
  const read = () => {
    const box = view.el.querySelector('.ask-step')
    assert.ok(box, 'no credit stepper rendered — is the rig still mobile?')
    const btns = [...box.querySelectorAll('button')] as HTMLButtonElement[]
    assert.equal(btns.length, 2, 'the stepper is not the expected − / ＋ pair')
    const [down, up] = btns
    assert.ok(down, 'no − button')
    assert.ok(up, 'no ＋ button')
    return { down, up }
  }
  /** press − / ＋ the way a thumb does, through the real handler */
  const press = async (which: 'down' | 'up', times = 1) => {
    for (let i = 0; i < times; i++) {
      await inAct(async () => {
        read()[which].dispatchEvent(
          new window.MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })
    }
  }
  return { read, press, view }
}

// ------------------------------------------------------------- the floor

test('§7 − at the committed floor names the credits held below', async () => {
  // the agent holds 6 and has handed all 6 down to its own reports; it asks
  // for 7. The user thumbs the offer back down — and the floor is where it
  // stops, because those 6 cannot be taken back from this card.
  const { read, press } = await stepper(creditAsk(6, 7), 6, 100)
  assert.equal(read().down.disabled, false, 'the first step down was refused')
  await press('down')
  const { down, up } = read()
  assert.equal(down.disabled, true, 'the offer could be pushed below the floor')
  assert.equal(down.getAttribute('title'),
    "6 credits are already committed to this agent's own reports "
    + '— take those back first to offer less')
  // and the OTHER end of the same stepper is live and silent — a hard-coded
  // title on the pair would fail right here
  assert.equal(up.disabled, false)
  assert.equal(up.getAttribute('title'), null)
})

test('§7b one step above the floor, − is live and says nothing', async () => {
  const { read } = await stepper(creditAsk(6, 7), 6, 100)
  assert.equal(read().down.disabled, false, 'a step of room was refused')
  assert.equal(read().down.getAttribute('title'), null,
    'a live − button explains a limit the user has not reached')
})

// ----------------------------------------------------------- the ceiling

test('§8 ＋ at the cap names the cap, by the org setting\'s own name',
  async () => {
    const { down, up } = (await stepper(creditAsk(10, 50), 0, 50)).read()
    assert.equal(up.disabled, true, 'the offer went past the org cap')
    assert.equal(up.getAttribute('title'),
      "the offer stops at this org's top-level grant cap of 50")
    assert.equal(down.disabled, false)
    assert.equal(down.getAttribute('title'), null)
  })

test('§8b with no cap set the ＋ never stops and never speaks', async () => {
  // maxTop undefined is the uncapped org (max_top_grant 0/unset). A helper
  // that formatted `undefined` would produce "...cap of undefined" here.
  const { up } = (await stepper(creditAsk(10, 999), 0, undefined)).read()
  assert.equal(up.disabled, false, 'an uncapped org still stopped the offer')
  assert.equal(up.getAttribute('title'), null)
})

// -------------------------------------------- the second card, same rules

test('§9 the composed batch card carries the same two explanations',
  async () => {
    // ⚠ THE CALLSITE TEST. CreditAsk and BatchAsk render their own copy of
    // the stepper; a fix applied to one and not the other reads as done.
    const floor = await stepper(batchAsk(6, 7), 6, 100)
    await floor.press('down')
    assert.equal(floor.read().down.disabled, true)
    assert.equal(floor.read().down.getAttribute('title'),
      "6 credits are already committed to this agent's own reports "
      + '— take those back first to offer less')

    const ceil = (await stepper(batchAsk(10, 50), 0, 50)).read()
    assert.equal(ceil.up.disabled, true)
    assert.equal(ceil.up.getAttribute('title'),
      "the offer stops at this org's top-level grant cap of 50")
  })

test('§9b …and stays quiet on the batch card when both ends are live',
  async () => {
    const { down, up } = (await stepper(batchAsk(4, 20), 2, 100)).read()
    assert.equal(down.disabled, false)
    assert.equal(down.getAttribute('title'), null)
    assert.equal(up.disabled, false)
    assert.equal(up.getAttribute('title'), null)
  })

test.after(() => { localStorage.removeItem('orgtree-mobile') })
