// crossprovider.test.tsx — D-196's confirmation gate (user ruling 2026-08-29:
// "Ask me to confirm first").
//
// A cross-provider model switch cannot keep the agent's conversation: the
// session handle is provider-owned and no provider can resume another's, so
// switching resets it. The user chose to be asked before that happens.
//
// What this proves, at the DOM-event layer rather than by reading the source
// ("the confirmation is wired" and "the confirmation appears and BLOCKS the
// switch" are different claims):
//   §1  a crossing shows a dialog and sends NOTHING until it is confirmed
//   §2  the dialog names what is LOST and what SURVIVES
//   §3  cancel is total — no op, no scope write, nothing mutated
//   §4  a within-provider switch is untouched: one click, no dialog
//
// §4 is the load-bearing counterweight. A gate that simply asked on EVERY
// save would pass §1-§3 and turn an ordinary one-click model change into a
// confirmation chore — the user's ruling was explicit that only the crossing
// asks. Any mutant that broadens the gate must die here.
//
// Run:  cd frontend && node tests/run.mjs crossprovider

import {
  FakeServer, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import { USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpRequest, OpResult, ProviderInfo, TreePayload } from '../src/types'

const noop = () => {}

function node(tier = 'haiku'): CanvasNode {
  return {
    id: 'agent', title: 'agent', state: 'live', tier, model_id: tier,
    parent: USER, children: [], seat: 1, grant: 10, free: 10,
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: {
      bash: true, web: true, edit: true, subagents: true, mcp: [],
    }, org_visibility: 'team' },
    charter: '', team_charter: '', turns: [], audiences_held: [],
  }
}

/** shaped like the payload, not type-checked into it — the same fixture idiom
 *  as modelswitch/mailwire, trimmed to what NodeConfig actually dereferences */
function tree(): TreePayload {
  return {
    slug: 'org', dirs: [], tiers: {
      haiku: 1, sonnet: 2, opus: 5, fable: 10,
      'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, flash: 1, pro: 2,
    }, max_top_grant: 100, default_effort: '', effort_default: 'high',
    cascade_hire: true, sandboxed: false,
  } as unknown as TreePayload
}

const prov = (id: string, label: string): ProviderInfo => ({
  id, label, cli: `${label} CLI`, tiers: [],
  status: { installed: true, connected: true, kind: 'chatgpt' },
  hire_enabled: true, reason: null,
})

interface Mounted {
  el: HTMLElement
  ops: OpRequest[]
  /** requests the panel has made since it settled. A scope write is a real
   *  network call even when no `op` was recorded, so this is what makes
   *  "nothing was applied" a measurement rather than an assumption. */
  sinceMount: () => number
  pick: (tier: string) => Promise<void>
  save: () => Promise<void>
  dialog: () => HTMLElement | null
  /** scoped to the DIALOG: the config panel has its own `cancel` button and
   *  it appears FIRST in document order, so an unscoped search clicks the
   *  wrong one and proves nothing */
  dialogButton: (re: RegExp) => HTMLButtonElement | undefined
}

function gateTest(name: string,
  body: (mount: (from?: string, extra?: Partial<CanvasNode>) => Promise<Mounted>)
    => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const transport = installFetch(new FakeServer())
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const v of open) await v.unmount()
      realClock()
    })
    await body(async (from = 'haiku', extra: Partial<CanvasNode> = {}) => {
      const ops: OpRequest[] = []
      const nd = { ...node(from), ...extra }
      const v = await mountView(
        <NodeConfig node={nd} map={new Map([[nd.id, nd]])}
          tree={tree()} slug="org"
          op={(x) => { ops.push(x); return Promise.resolve({} as OpResult) }}
          toast={noop} codexProvider={prov('openai', 'Codex')}
          antigravityProvider={prov('google', 'Antigravity')}
          close={noop} />,
        (el) => el,
      )
      open.push(v)
      const { act } = await import('react')
      const settled = transport.requests   // the panel's own opening GETs
      return {
        el: v.el, ops,
        sinceMount: () => transport.requests - settled,
        pick: async (tier: string) => {
          const sel = v.el.querySelector<HTMLSelectElement>('.model-switch')!
          await act(async () => {
            sel.value = tier
            sel.dispatchEvent(new Event('change', { bubbles: true }))
          })
        },
        save: async () => {
          const b = [...v.el.querySelectorAll<HTMLButtonElement>('button')]
            .find((x) => x.textContent?.trim() === 'save')!
          await act(async () => { b.click() })
        },
        dialog: () => document.querySelector<HTMLElement>('.confirm-box'),
        dialogButton: (re: RegExp) =>
          [...document.querySelectorAll<HTMLButtonElement>(
            '.confirm-box button')]
            .find((b) => re.test(b.textContent?.trim() ?? '')),
      }
    })
  })
}

gateTest('☠ a crossing asks first and sends nothing until confirmed',
  async (mount) => {
    const m = await mount('haiku')          // Claude → Codex
    await m.pick('sol')
    await m.save()
    assert.ok(m.dialog(), 'no confirmation appeared for a provider crossing')
    assert.equal(m.ops.find((o) => o.op === 'switch_model'), undefined,
      'the switch fired before the user confirmed')
    assert.equal(m.sinceMount(), 0,
      'the scope was written before the user confirmed')
  })

gateTest('the dialog names the loss AND what survives', async (mount) => {
  const m = await mount('sol')              // Codex → Claude, the live incident
  await m.pick('opus')
  await m.save()
  const txt = (m.dialog()?.textContent ?? '').toLowerCase()
  // the providers are named by their PRODUCT names, not 'openai'/'claude'
  assert.match(txt, /codex/, 'the dialog does not say which provider it leaves')
  assert.match(txt, /claude/, 'the dialog does not say which provider it joins')
  // what is spent…
  assert.match(txt, /conversation/,
    'the dialog does not say the conversation is what is lost')
  assert.match(txt, /reset|not remember/,
    'the dialog does not say the conversation is reset')
  // …and what is not. Naming only the loss reads as more destructive than it
  // is, and someone would avoid a switch they should make.
  assert.match(txt, /scratch/, 'the dialog does not say scratch files survive')
  assert.match(txt, /breadcrumbs/, 'the dialog does not say breadcrumbs survive')
  assert.match(txt, /mail/, 'the dialog does not say mail survives')
  assert.ok(!/are you sure/.test(txt),
    'a generic "are you sure" is exactly what this ruling rejected')
})

gateTest('☠ cancel is total — nothing is applied', async (mount) => {
  const m = await mount('sol')
  await m.pick('opus')
  await m.save()
  assert.ok(m.dialog(), 'fixture never opened the dialog')
  const cancel = m.dialogButton(/^cancel$/)!
  const { act } = await import('react')
  await act(async () => { cancel.click() })
  assert.equal(m.dialog(), null, 'the dialog stayed open after cancel')
  assert.equal(m.ops.find((o) => o.op === 'switch_model'), undefined,
    'cancel still switched the model')
  assert.equal(m.sinceMount(), 0, 'cancel still wrote the scope')
})

gateTest('☠ a within-provider switch is one click, no dialog',
  async (mount) => {
    const m = await mount('haiku')          // Claude → Claude
    await m.pick('opus')
    await m.save()
    assert.equal(m.dialog(), null,
      'an ordinary model change must not become a confirmation chore')
    assert.deepEqual(m.ops.find((o) => o.op === 'switch_model'),
      { op: 'switch_model', node: 'agent', tier: 'opus' },
      'the within-provider switch did not go through')
  })

gateTest('a codex→codex switch is also one click', async (mount) => {
  const m = await mount('luna')             // Codex → Codex
  await m.pick('sol')
  await m.save()
  assert.equal(m.dialog(), null, 'same-provider switches must not ask')
  assert.deepEqual(m.ops.find((o) => o.op === 'switch_model'),
    { op: 'switch_model', node: 'agent', tier: 'sol' })
})

gateTest('codex→antigravity asks: a crossing between two NON-claude providers',
  async (mount) => {
    const m = await mount('sol')
    await m.pick('pro')
    await m.save()
    const txt = (m.dialog()?.textContent ?? '').toLowerCase()
    assert.ok(m.dialog(), 'codex→antigravity is a crossing and must ask')
    assert.match(txt, /antigravity/, 'the dialog does not name Antigravity')
    assert.equal(m.ops.find((o) => o.op === 'switch_model'), undefined)
  })

// §7 D-234 (user ruling 2026-09-03): a switch asked for while the agent is
// MID-TURN is a QUEUE, not a switch — and the dialog must say so at the moment
// of the action, name the interrupt as the way to make it immediate, and its
// confirm button must not read "switch". §7c is the counterweight: the busy
// flag alone, with no model change, must not conjure a dialog.

gateTest('☠ §7 a MID-TURN switch asks, says QUEUED, and names the interrupt',
  async (mount) => {
    const m = await mount('haiku', { busy: true })   // Claude → Claude, busy
    await m.pick('opus')
    await m.save()
    assert.ok(m.dialog(), 'a mid-turn switch must ask — it is a queue, not a switch')
    const txt = (m.dialog()?.textContent ?? '').toLowerCase()
    assert.match(txt, /queued/, 'the dialog does not say the switch is queued')
    assert.match(txt, /interrupt/,
      'the dialog does not name the interrupt as the immediate path')
    assert.equal(m.ops.find((o) => o.op === 'switch_model'), undefined,
      'the switch fired before the user confirmed')
    const go = m.dialogButton(/^queue the switch/)
    assert.ok(go, 'the confirm button must say "queue", never "switch"')
    const { act } = await import('react')
    await act(async () => { go!.click() })
    assert.deepEqual(m.ops.find((o) => o.op === 'switch_model'),
      { op: 'switch_model', node: 'agent', tier: 'opus' },
      'confirming the queue did not send the switch')
  })

gateTest('§7b a mid-turn CROSSING says both: queued now, reset when it applies',
  async (mount) => {
    const m = await mount('sol', { busy: true })      // Codex → Claude, busy
    await m.pick('opus')
    await m.save()
    const txt = (m.dialog()?.textContent ?? '').toLowerCase()
    assert.match(txt, /queued/)
    assert.match(txt, /conversation/, 'the crossing paragraph is missing')
    assert.match(txt, /scratch/, 'the crossing paragraph is missing its survivors')
    assert.ok(m.dialogButton(/^queue the switch/),
      'a busy crossing must still confirm as a queue')
  })

gateTest('☠ §7c busy alone, with no model change, asks nothing', async (mount) => {
  const m = await mount('haiku', { busy: true })
  await m.save()
  assert.equal(m.dialog(), null,
    'a save that changes no model must not ask about queueing')
  assert.equal(m.ops.find((o) => o.op === 'switch_model'), undefined)
})
