// harnessrow.test.tsx — the agent settings Model tab's Harness row. USER
// 2026-10-29 14:25:54Z m1ff3b8c5b200 asked to change an OpenRouter agent's
// harness override after hire, and approved this row at 14:26:39Z
// (mce51de660ab4, "yes please"). Language model server seats get the same
// row (14:26:50Z mc9112ecf0b40).
//
// A seat follows its OpenRouter key's (or its server's) harness, or keeps
// one of its own. The row reuses the key dialog's harness list: installed
// harnesses first, the others greyed out and disabled.
//   §1 an unpinned OpenRouter seat shows "Follow key (<the key's harness>)"
//      and the key dialog's list
//   §2 a seat with its own harness shows it as the value
//   §3 choosing one says it moves at its next turn, on a fresh session with
//      a summary, and Save sends one harness op naming it
//   §4 choosing Follow sends the op with no harness: the pin is cleared
//   §5 a save that did not touch the row sends no harness op
//   §6 a server seat follows its server, and a harness that server cannot
//      carry is disabled
//   §7 another provider's seat has no row and reads nothing for one
//   §8 a draft model on another lane holds the row until the model is saved
//   §9 with undo history the change rides the same settings gesture
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs harnessrow

import { FakeServer, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import { setLangServerTiers, setOpenRouterTiers, USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpRequest, OpResult, ProviderInfo, TreePayload } from '../src/types'

const noop = () => {}
const OR_TIER = 'or-moonshotai-kimi-k3'
const LS_TIER = 'ls-ollama-qwen3'

setOpenRouterTiers([{ tier: OR_TIER, provider: 'openrouter', seat: 1, model: 'moonshotai/kimi-k3', letter: 'K',
  color: '#8f9bff', name: 'Kimi K3', label: 'kimi-k3', vendor: 'moonshotai' } as never])
setLangServerTiers([{ tier: LS_TIER, provider: 'langserver', seat: 1, model: 'qwen3', letter: 'Q',
  color: '#8fdf9b', name: 'qwen3', label: 'qwen3' } as never])

function node(tier: string): CanvasNode {
  return {
    id: 'agent', title: 'agent', state: 'live', tier, model_id: tier,
    parent: USER, children: [], seat: 1, grant: 10, free: 10,
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: {
      bash: true, web: true, edit: true, subagents: true, mcp: [],
    }, org_visibility: 'team' },
    charter: '', team_charter: '', turns: [], audiences_held: [],
  }
}

function tree(extra: Partial<TreePayload> = {}): TreePayload {
  return {
    slug: 'org', dirs: [], tiers: { haiku: 1, sonnet: 2, opus: 5, sol: 5, [OR_TIER]: 1, [LS_TIER]: 1 },
    max_top_grant: 100, default_effort: '', effort_default: 'high', cascade_hire: true, ...extra,
  } as unknown as TreePayload
}

const prov = (id: string, label: string): ProviderInfo => ({
  id, label, cli: `${label} CLI`, tiers: [],
  status: { installed: true, connected: true, kind: 'chatgpt' },
  hire_enabled: true, reason: null,
})

/** the engine's answer for a seat (`GET /nodes/{nid}/harness?tier=`) */
const OPTIONS = [
  { id: 'claude-code', label: 'Claude Code', installed: true, available: true, why: 'installed' },
  { id: 'codex-cli', label: 'Codex', installed: true, available: true, why: 'installed' },
  { id: 'opencode', label: 'OpenCode (ACP)', installed: false, available: false,
    why: 'OpenCode (ACP) is not installed on this computer' },
]
const openrouterSeat = (pin: string | null) => ({
  lane: 'openrouter', pin, current: pin ?? 'codex-cli', options: OPTIONS,
  follow: { id: 'codex-cli', label: 'Codex', installed: true, source: 'key', name: 'team budget' },
})
const serverSeat = () => ({
  lane: 'langserver', pin: null, current: 'claude-code',
  follow: { id: 'claude-code', label: 'Claude Code', installed: true, source: 'server', name: 'Ollama' },
  options: [
    OPTIONS[0],
    { id: 'codex-cli', label: 'Codex', installed: true, available: false,
      why: "this custom server's base path is set for Claude Code's API; Codex needs its own server entry" },
    OPTIONS[2],
  ],
})

interface Mounted {
  el: HTMLElement
  ops: OpRequest[]
  /** the tiers the panel asked the harness of, in order */
  asked: string[]
  /** each settings gesture's steps */
  gestures: Record<string, unknown>[][]
  row: () => HTMLSelectElement | null
  hint: () => string
  pickModel: (tier: string) => Promise<void>
  pickHarness: (id: string) => Promise<void>
  save: () => Promise<void>
}

function rowTest(name: string, body: (mount: (o: { tier: string; pin?: string | null; tree?: TreePayload }) => Promise<Mounted>) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    installFetch(new FakeServer())
    const inner = globalThis.fetch
    const asked: string[] = []
    const gestures: Record<string, unknown>[][] = []
    let pin: string | null = null
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const u = new URL(String(url), 'http://localhost')
      if (/\/api\/orgs\/org\/nodes\/agent\/harness$/.test(u.pathname)) {
        const tier = u.searchParams.get('tier') ?? ''
        asked.push(tier)
        const body = tier.startsWith('ls-') ? serverSeat() : tier.startsWith('or-') ? openrouterSeat(pin)
          : { lane: null, follow: null, pin: null, current: null, options: [] }
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      if (/\/gesture$/.test(u.pathname)) {
        gestures.push(JSON.parse(String(init?.body ?? '{}')).steps ?? [])
        return Promise.resolve(new Response(JSON.stringify({ results: [{}, {}, {}] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return inner(url, init)
    }) as typeof fetch
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const v of open) await v.unmount()
      globalThis.fetch = inner
      realClock()
    })
    await body(async (o) => {
      pin = o.pin ?? null
      const ops: OpRequest[] = []
      const nd = node(o.tier)
      const v = await mountView(
        <NodeConfig node={nd} map={new Map([[nd.id, nd]])} tree={o.tree ?? tree()} slug="org"
          op={(x) => { ops.push(x); return Promise.resolve({} as OpResult) }}
          toast={noop} codexProvider={prov('openai', 'Codex')}
          antigravityProvider={prov('google', 'Antigravity')} close={noop} />,
        (el) => el,
      )
      open.push(v)
      const { act } = await import('react')
      const settle = async () => { await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }) }
      await settle()
      const choose = async (sel: HTMLSelectElement | null, value: string) => {
        assert.ok(sel, 'no select to choose from')
        await act(async () => {
          sel!.value = value
          sel!.dispatchEvent(new Event('change', { bubbles: true }))
        })
        await settle()
      }
      const row = () => v.el.querySelector<HTMLSelectElement>('select[aria-label="Agent harness"]')
      return {
        el: v.el, ops, asked, gestures, row,
        hint: () => row()?.closest('.set-row')?.textContent ?? '',
        pickModel: (tier) => choose(v.el.querySelector<HTMLSelectElement>('.model-switch'), tier),
        pickHarness: (id) => choose(row(), id),
        save: async () => {
          const b = [...v.el.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === 'Save')!
          await act(async () => { b.click() })
          await settle()
        },
      }
    })
  })
}

const optionTexts = (sel: HTMLSelectElement) => [...sel.options].map((o) => o.textContent?.trim() ?? '')

rowTest('§1 an unpinned OpenRouter seat follows its key, offering the key dialog list', async (mount) => {
  const m = await mount({ tier: OR_TIER })
  const sel = m.row()
  assert.ok(sel, 'the Model tab has no Harness row for an OpenRouter seat')
  assert.deepEqual(m.asked, [OR_TIER], 'the row reads the seat\'s harness for its tier')
  assert.equal(sel!.value, '', 'an unpinned seat shows Follow key')
  assert.equal(optionTexts(sel!)[0], 'Follow key (Codex)', 'Follow names the key\'s current harness')
  const opt = (id: string) => [...sel!.options].find((o) => o.value === id)
  assert.equal(opt('claude-code')?.disabled, false)
  assert.equal(opt('codex-cli')?.disabled, false)
  assert.equal(opt('opencode')?.disabled, true, 'an uninstalled harness is disabled')
  assert.match(opt('opencode')?.textContent ?? '', /not installed/)
  assert.match(m.hint(), /key/i, 'the row says the seat follows its key')
})

rowTest('§2 a seat with its own harness shows it', async (mount) => {
  const m = await mount({ tier: OR_TIER, pin: 'claude-code' })
  assert.equal(m.row()?.value, 'claude-code', 'a pinned seat shows its own harness, not Follow')
})

rowTest('§3 choosing a harness says it moves at the next turn, then saves one harness op', async (mount) => {
  const m = await mount({ tier: OR_TIER })
  await m.pickHarness('claude-code')
  assert.match(m.hint(), /Claude Code/)
  assert.match(m.hint(), /next turn/i, 'the row says the change waits for the next turn')
  assert.match(m.hint(), /fresh session/i, 'the row says a fresh session starts')
  assert.match(m.hint(), /summary/i, 'the row says the fresh session starts with a summary')
  await m.save()
  assert.deepEqual(m.ops.filter((o) => o.op === 'harness'), [{ op: 'harness', node: 'agent', harness: 'claude-code' }])
  assert.equal(document.querySelector('.confirm-box'), null, 'a harness change asks nothing more: the key dialog does not either')
})

rowTest('§4 choosing Follow clears the seat\'s own harness', async (mount) => {
  const m = await mount({ tier: OR_TIER, pin: 'claude-code' })
  await m.pickHarness('')
  assert.match(m.hint(), /Codex/, 'the row names the key harness it moves to')
  await m.save()
  assert.deepEqual(m.ops.filter((o) => o.op === 'harness'), [{ op: 'harness', node: 'agent', harness: null }])
})

rowTest('§5 a save that did not touch the row sends no harness op', async (mount) => {
  const m = await mount({ tier: OR_TIER, pin: 'claude-code' })
  await m.save()
  assert.equal(m.ops.find((o) => o.op === 'harness'), undefined)
})

rowTest('§6 a server seat follows its server; a harness it cannot carry is disabled', async (mount) => {
  const m = await mount({ tier: LS_TIER })
  const sel = m.row()
  assert.ok(sel, 'the Model tab has no Harness row for a language model server seat')
  assert.equal(optionTexts(sel!)[0], 'Follow server (Claude Code)')
  const codex = [...sel!.options].find((o) => o.value === 'codex-cli')
  assert.equal(codex?.disabled, true, 'a harness the server cannot carry is disabled')
  assert.match(codex?.title ?? '', /base path/, 'and says why')
  assert.match(m.hint(), /server/i, 'the row says the seat follows its server')
})

rowTest('§7 another provider\'s seat has no Harness row', async (mount) => {
  const m = await mount({ tier: 'opus' })
  assert.equal(m.row(), null)
  assert.deepEqual(m.asked, [], 'nothing is read for a row it does not show')
})

rowTest('§8 a draft model on another lane holds the row until the model change is saved', async (mount) => {
  const m = await mount({ tier: OR_TIER })
  await m.pickModel(LS_TIER)
  assert.equal(m.row()?.disabled, true, 'the row waits for the model change')
  assert.match(m.hint(), /model/i, 'and says why')
  await m.pickModel('opus')
  assert.equal(m.row(), null, 'a Claude model has no harness to choose')
})

rowTest('§9 with undo history the harness change rides the settings gesture', async (mount) => {
  const m = await mount({ tier: OR_TIER, tree: tree({ undo_history: { rev: 1, undo: null, redo: null } }) })
  await m.pickHarness('claude-code')
  await m.save()
  assert.equal(m.gestures.length, 1, 'one gesture')
  const steps = m.gestures[0]
  assert.deepEqual(steps.find((s) => s.op === 'harness'), { op: 'harness', node: 'agent', harness: 'claude-code' })
  assert.equal(steps.at(-1)?.op, 'scope', 'the scope step stays last')
})
