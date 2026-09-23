// The long-charter popup is gone from the agent-settings save.
//
// Ticket `remove-the-long-charter-warning-popup-from-agent`. The settings
// panel re-sends the WHOLE charter on every save, so the backend's length note
// used to come back on every save of an agent that already had a long charter
// — a popup interrupting the user about text they had not touched. The note is
// now an ADVISORY (ledger.set_scope `advisories`), not a warning, and
// `savePopups` in modals.tsx is the choke point that pops `warnings` and
// deliberately not it.
//
// §2 IS THE NEGATIVE CONTROL, and it is the reason §1 means anything: it runs
// the SAME mount and the SAME save with a genuine warning in the response and
// proves the popup path is alive and does reach the user. Without it, §1 would
// pass just as well if the toast were broken, the save never ran, or the
// response had not been read at all.
//
// The other half of the contract is not observable from here — the renderer
// only sees what the response carries, so it cannot tell a backend that emits
// no advisory from one whose advisory it ignores. `tests/test_charter_uncapped.py`
// pins that half: the ledger stores the charter whole and reports its length in
// `advisories` with `warnings` empty.

import {
  FakeServer, flush, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import { USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpRequest, OpResult, ProviderInfo, TreePayload } from '../src/types'

const noop = () => {}

/** A charter past ledger.CHARTER_LONG (4000), the threshold above which the
 *  backend used to warn. Long enough to have triggered the popup, and built
 *  from a repeating sentence so a truncation would be visible in a diff. */
const LONG_CHARTER = 'rule: never end a charter mid-sentence. '.repeat(110)
assert.ok(LONG_CHARTER.length > 4000,
  `the fixture must be past the threshold: ${LONG_CHARTER.length}`)

/** The backend's length note, worded as ledger.note_charter_length writes it.
 *  Reproduced here rather than imported — the renderer never sees the ledger —
 *  and pinned on the other side by the backend test. */
const ADVISORY =
  `charter is ${LONG_CHARTER.length} chars `
  + `(${LONG_CHARTER.length} bytes). Stored WHOLE — charters are not capped. `
  + 'Worth knowing: a charter is re-sent in this agent\'s system prompt on '
  + 'every turn it takes, so text past roughly 4000 chars is a recurring '
  + 'per-turn cost, not a one-off one.'

/** A genuine, actionable warning from the same call — the kind the ticket
 *  says must still appear (a subtree grant clamped by the new capability set). */
const REAL_WARNING = 'subtree grants clamped to the new set (№30): bash'

/** Anything that reads like the charter-length note, however it is reworded.
 *  §1 asserts on this as well as on "nothing popped at all", so a future
 *  renderer that pops advisories with different wording still fails. */
const CHARTER_NOTE = /charter is \d+ chars|Stored WHOLE|recurring per-turn cost/i

function node(charter: string): CanvasNode {
  return {
    id: 'agent', title: 'agent', state: 'live', tier: 'haiku', model_id: 'haiku',
    parent: USER, children: [], seat: 1, grant: 10, free: 10,
    scope: {
      permission_mode: 'acceptEdits', add_dirs: [],
      tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
      org_visibility: 'team',
    },
    charter, team_charter: '', turns: [], audiences_held: [],
  }
}

function tree(): TreePayload {
  return {
    slug: 'org', dirs: [], tiers: {
      haiku: 1, sonnet: 2, opus: 5, fable: 10,
      'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, flash: 1, pro: 2,
    }, max_top_grant: 100, default_effort: '', effort_default: 'high',
    cascade_hire: true, sandboxed: false,
  } as TreePayload
}

function codexProvider(): ProviderInfo {
  return {
    id: 'openai', label: 'Codex', cli: 'Codex CLI', tiers: [],
    status: { installed: true, connected: true, kind: 'chatgpt' },
    hire_enabled: true, reason: null,
  }
}

/** What the scope POST answers, and what it was sent.
 *
 *  The harness stub answers every unmatched route `{ok: true}`, which carries
 *  neither `warnings` nor `advisories` — so a test about what a save POPS has
 *  to say what the save RETURNED. Everything that is not the scope POST is
 *  passed through to the harness stub untouched. */
function scopeAnswers(payload: Record<string, unknown> | { fail: number }) {
  const sent: Record<string, unknown>[] = []
  const real = globalThis.fetch as unknown as
    (url: string, init?: { body?: string }) => Promise<unknown>
  const headers = new Headers({ 'X-Orgtree-Instance': 'inst-0' })
  ;(globalThis as unknown as { fetch: unknown }).fetch =
    (url: string, init?: { body?: string }) => {
      if (!/\/scope$/.test(String(url))) return real(url, init)
      if (init?.body) sent.push(JSON.parse(init.body))
      if ('fail' in payload) {
        const status = payload.fail
        return Promise.resolve({
          ok: false, status, statusText: `HTTP ${status}`, headers,
          json: () => Promise.resolve({ detail: `boom ${status}` }),
        })
      }
      return Promise.resolve({
        ok: true, status: 200, headers, json: () => Promise.resolve(payload),
      })
    }
  return sent
}

type Mounted = {
  el: HTMLElement
  toasts: (string[] | null | undefined)[]
  ops: OpRequest[]
  closed: () => number
}

async function mount(
  n: CanvasNode,
  toast?: (lines: string[] | null | undefined) => void,
): Promise<Mounted> {
  const toasts: (string[] | null | undefined)[] = []
  const ops: OpRequest[] = []
  let closes = 0
  const view = await mountView(
    <NodeConfig node={n} map={new Map([[n.id, n]])} tree={tree()} slug="org"
      op={(x) => { ops.push(x); return Promise.resolve({} as OpResult) }}
      toast={(lines) => { toasts.push(lines); toast?.(lines) }}
      codexProvider={codexProvider()} close={() => { closes++ }} />,
    (el) => el,
  )
  return { el: view.el, toasts, ops, closed: () => closes }
}

const saveButton = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent?.trim() === 'save')!

/** every line any toast carried, flattened */
const popped = (m: Mounted) => m.toasts.flatMap((lines) => lines ?? [])

async function clickSave(m: Mounted): Promise<void> {
  const { act } = await import('react')
  await act(async () => { saveButton(m.el).click() })
  await flush()
}

// ---------------------------------------------------------------------------
// §1 the requirement
// ---------------------------------------------------------------------------
test('§1 saving an agent with a long charter pops nothing, and the charter goes up whole',
  async (t: TestContext) => {
    useFakeClock(); installFetch(new FakeServer())
    const sent = scopeAnswers({
      scope: { charter: LONG_CHARTER }, warnings: [], advisories: [ADVISORY],
    })
    const m = await mount(node(LONG_CHARTER))
    t.after(async () => { realClock() })
    await flush()

    // the panel really is holding the long charter before we save
    const box = m.el.querySelector<HTMLTextAreaElement>('.charterbox')
    assert.ok(box, 'no charter textarea in the agent settings')
    assert.equal(box!.value, LONG_CHARTER, 'the panel must open on the stored charter')

    await clickSave(m)

    assert.equal(sent.length, 1, `the save must reach the backend: ${sent.length} posts`)
    // ACCEPTANCE 2: the charter is sent exactly as it was, not truncated,
    // rewritten or cleared on its way through the panel.
    assert.equal(sent[0]!.charter, LONG_CHARTER,
      'the saved charter must be byte-for-byte the stored text')
    // ACCEPTANCE 1: the save completed through the normal flow...
    assert.equal(m.closed(), 1, 'the save must close the panel rather than stop for a popup')
    // ...and raised no popup at all. The panel may still CALL toast with an
    // empty list — that is what the pre-ticket code did too (it passed
    // `r.warnings`, undefined on a clean save) and `ToastFn`'s contract is
    // that the implementation returns early on one, so the count of CALLS is
    // not the observable; the count of LINES is.
    assert.deepEqual(popped(m), [],
      `a long-charter save popped: ${JSON.stringify(popped(m))}`)
    assert.equal(popped(m).some((l) => CHARTER_NOTE.test(l)), false,
      'the long-charter advisory reached the user as a popup')
  })

// ---------------------------------------------------------------------------
// §2 NEGATIVE CONTROL — the popup path is alive and does reach the user
// ---------------------------------------------------------------------------
test('§2 CONTROL: the same save still pops a genuine warning, and only that',
  async (t: TestContext) => {
    useFakeClock(); installFetch(new FakeServer())
    // The same response, with the advisory AND a real warning on it — which is
    // what a clamped save of a long charter actually returns.
    const sent = scopeAnswers({
      scope: { charter: LONG_CHARTER },
      warnings: [REAL_WARNING], advisories: [ADVISORY],
    })
    const m = await mount(node(LONG_CHARTER))
    t.after(async () => { realClock() })
    await flush()

    await clickSave(m)

    assert.equal(sent.length, 1, 'the save must reach the backend')
    // ACCEPTANCE 4/5: a real warning still interrupts. If this fails, §1 is
    // vacuous — it would pass on a panel whose toasts never fire at all.
    assert.deepEqual(popped(m), [REAL_WARNING],
      `a genuine warning must still pop, and the advisory must not: `
      + `${JSON.stringify(popped(m))}`)
    assert.equal(popped(m).some((l) => CHARTER_NOTE.test(l)), false,
      'the advisory rode along with the warning')
  })

// ---------------------------------------------------------------------------
// §3 a hard failure is still a failure (acceptance 4)
// ---------------------------------------------------------------------------
test('§3 CONTROL: a refused save still reports its error', async (t: TestContext) => {
  useFakeClock(); installFetch(new FakeServer())
  scopeAnswers({ fail: 400 })
  const m = await mount(node(LONG_CHARTER))
  t.after(async () => { realClock() })
  await flush()

  await clickSave(m)

  assert.equal(m.toasts.length, 1, 'a failed save must say so')
  assert.match(popped(m)[0] ?? '', /^error: /,
    `a hard failure must still surface: ${JSON.stringify(popped(m))}`)
  assert.equal(m.closed(), 0, 'a save that failed must not close the panel')
})

// ---------------------------------------------------------------------------
// §4 the unrelated confirmation is untouched (acceptance 5)
// ---------------------------------------------------------------------------
test('§4 CONTROL: a provider-crossing save still asks first, and sends nothing until it is confirmed',
  async (t: TestContext) => {
    useFakeClock(); installFetch(new FakeServer())
    const sent = scopeAnswers({ scope: {}, warnings: [], advisories: [ADVISORY] })
    const m = await mount(node(LONG_CHARTER))
    t.after(async () => { realClock() })
    await flush()

    // haiku (Claude) -> sol (Codex): the cross-provider gate (D-182)
    const { act } = await import('react')
    const select = m.el.querySelector<HTMLSelectElement>('.model-switch')!
    await act(async () => {
      select.value = 'sol'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await clickSave(m)

    assert.equal(sent.length, 0,
      'the save must not reach the backend before the user confirms')
    const confirm = [...document.querySelectorAll<HTMLButtonElement>(
      '.confirm-box button')].find((b) => /^switch to sol/.test(
      b.textContent?.trim() ?? ''))
    assert.ok(confirm, 'the cross-provider confirmation did not appear')

    await act(async () => { confirm!.click() })
    await flush()
    assert.deepEqual(m.ops.find((o) => o.op === 'switch_model'),
      { op: 'switch_model', node: 'agent', tier: 'sol' },
      'the confirmed switch must be the same op it always was')
    assert.equal(sent.length, 1, 'the confirmed save must then reach the backend')
  })
