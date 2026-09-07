// D-197 — the lineage panel's rehire tier picker.
//
// The reported bug: "cant select non-claude models for knowledgebearer
// rehire." The picker was the literal `['haiku','sonnet','opus']`, written
// before fable, codex and antigravity existed. Two separate defects came out of
// that one line, and both are asserted here:
//
//   1. it UNDER-OFFERED its own provider — `fable` is a claude tier that
//      resumes a claude bearer perfectly and was simply missing;
//   2. it silently OMITTED the other providers, which reads as a quirk. The
//      omission turns out to be right — a transcript cannot cross providers —
//      but a gap explains nothing, so the rule is now shown and disabled with
//      a reason instead of hidden.
//
// Plus the seat table in the same panel, which was claude-only: a codex
// bearer rendered "as sol · seat undefined".

import { installFetch, FakeServer, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { LineagePanel } from '../src/canvas/desk'
import { USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { LineageEntry, OpRequest, OpResult } from '../src/types'

const noop = () => {}

/** A node carrying one archived generation at `tier` — the shape the panel
 *  draws a rehire row from. */
function withBearer(tier: string, extra: Partial<LineageEntry> = {}): CanvasNode {
  const gen: LineageEntry = {
    id: 'agent@1', generation: 1, state: 'archived',
    bearer_state: 'knowledge', tier, ...extra,
  }
  return {
    id: 'agent', title: 'agent', state: 'live', tier, model_id: tier,
    parent: USER, children: [], seat: 1, grant: 10, free: 10,
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: {
      bash: true, web: true, edit: true, subagents: true, mcp: [],
    }, org_visibility: 'team' },
    charter: '', team_charter: '', turns: [], audiences_held: [],
    lineage: [gen],
  } as unknown as CanvasNode
}

type Mounted = { el: HTMLElement; ops: OpRequest[] }

function panelTest(name: string,
                   body: (mount: (n: CanvasNode) => Promise<Mounted>)
                     => Promise<void> | void): void {
  test(name, async (t: TestContext) => {
    // ⚠ NO FAKE CLOCK, DELIBERATELY (D-177, and the user's 2026-08-29 warning
    // about parallel tests fighting over the virtual timer). `mock.timers` is
    // process-global, and enabling it is the known trigger for the runaway
    // that took the machine to 0.44 GB free and killed the editor. The
    // lineage panel reads no time at all — no `ago()`, no polling, no
    // interval — so borrowing the clock would buy nothing and put this file
    // in that failure mode for free. `installFetch` stays: the panel's
    // transcript reader must not reach a real socket.
    installFetch(new FakeServer())
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const v of open) await v.unmount()
    })
    await body(async (n) => {
      const ops: OpRequest[] = []
      const v = await mountView(
        <LineagePanel node={n} slug="org" close={noop}
          op={(x) => { ops.push(x); return Promise.resolve({} as OpResult) }} />,
        (el) => el,
      )
      open.push(v)
      return { el: v.el, ops }
    })
  })
}

const options = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLOptionElement>('.lin-row select option')]
const option = (el: HTMLElement, tier: string) =>
  options(el).find((o) => o.value === tier)!

// ---------------------------------------------------------------- §1 claude

panelTest('a claude bearer is offered every claude tier — fable included',
  async (mount) => {
    const { el } = await mount(withBearer('opus'))
    // the reported under-offer: fable belongs to the bearer's OWN provider and
    // was missing from the hard-coded three
    assert.equal(option(el, 'fable').disabled, false,
      'fable resumes a claude bearer and must be selectable')
    for (const t of ['haiku', 'sonnet', 'fable']) {
      assert.equal(option(el, t).disabled, false)
      assert.doesNotMatch(option(el, t).textContent ?? '', /cannot resume/)
    }
  })

panelTest('cross-provider tiers are SHOWN and disabled, each saying why',
  async (mount) => {
    const { el } = await mount(withBearer('opus'))
    for (const t of ['gpt-reserve', 'luna', 'terra', 'sol', 'flash', 'pro']) {
      const o = option(el, t)
      assert.ok(o, `${t} must be listed, not omitted — a gap explains nothing`)
      assert.equal(o.disabled, true, `${t} must be disabled`)
      assert.match(o.textContent ?? '',
        /transcript is a claude session — (codex|antigravity) cannot resume it/)
    }
  })

// ---------------------------------------------------------------- §2 codex

panelTest('a codex bearer is offered ITS family, and claude is the disabled one',
  async (mount) => {
    const { el } = await mount(withBearer('sol'))
    for (const t of ['gpt-reserve', 'luna', 'terra']) {
      assert.equal(option(el, t).disabled, false,
        `${t} shares sol's provider and must be selectable`)
    }
    for (const t of ['haiku', 'sonnet', 'opus', 'fable']) {
      assert.equal(option(el, t).disabled, true)
      assert.match(option(el, t).textContent ?? '',
        /transcript is a codex session — claude cannot resume it/)
    }
    // the direction that does not crash is the one worth naming: antigravity too
    for (const t of ['flash', 'pro']) {
      assert.equal(option(el, t).disabled, true)
    }
  })

panelTest('a antigravity bearer keeps flash and pro', async (mount) => {
  const { el } = await mount(withBearer('pro'))
  assert.equal(option(el, 'flash').disabled, false)
  assert.equal(option(el, 'opus').disabled, true)
  assert.match(option(el, 'opus').textContent ?? '',
    /transcript is a antigravity session — claude cannot resume it/)
})

// ------------------------------------------------------------- §3 the seats

panelTest('every provider\'s seats render as numbers, never "undefined"',
  async (mount) => {
    // SEAT was TIER_SEAT — the claude-only table — so a codex bearer's own
    // default row and its retire button both read "undefined" today
    const { el } = await mount(withBearer('sol', { state: 'archived' }))
    const dflt = options(el).find((o) => o.value === '')!
    assert.equal(dflt.textContent?.trim(), 'as sol · seat 5')
    assert.doesNotMatch(el.textContent ?? '', /undefined/,
      'no seat in the panel may render as undefined')
    // gpt-reserve/luna are 0.2 since the sub-$1 repricing (2026-09-03):
    // the panel prints the seat verbatim, so a fraction must survive the
    // round trip rather than being floored or rendered as `undefined`
    for (const [t, seat] of [['gpt-reserve', 0.2], ['luna', 0.2], ['terra', 2], ['flash', 1],
                             ['pro', 2], ['fable', 10]] as const) {
      assert.match(option(el, t).textContent ?? '',
        new RegExp(`as ${t} · seat ${seat}\\b`))
    }
  })

panelTest('a LIVE codex bearer\'s retire button names a real seat',
  async (mount) => {
    const { el } = await mount(
      withBearer('sol', { state: 'live', bearer_state: 'knowledge' }))
    const retire = [...el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('retire'))!
    assert.equal(retire.textContent?.trim(), 'retire · frees 5')
  })

// ------------------------------------------------------------- §4 it still works

panelTest('choosing a same-provider tier still sends the rehire op',
  async (mount) => {
    const { el, ops } = await mount(withBearer('sol'))
    const { act } = await import('react')
    const select = el.querySelector<HTMLSelectElement>('.lin-row select')!
    await act(async () => {
      select.value = 'luna'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const rehire = [...el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('rehire'))!
    await act(async () => { rehire.click() })
    assert.deepEqual(ops.find((o) => o.op === 'rehire'),
      { op: 'rehire', node: 'agent@1', grant: 0, tier: 'luna' })
  })
