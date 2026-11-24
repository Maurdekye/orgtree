// The page dm-bench.mjs measures: the user's chats over a synthetic
// organization of a realistic size, with one long chat. A React Profiler
// around the panel records every commit and how long it took, and the page
// can be told to hand the panel a new tree, as the app does whenever anything
// in the organization changes (many times a minute in a busy or remote one).
// Every engine request goes to the driver's fake engine.
import { createRoot } from 'react-dom/client'
import { Profiler, useEffect, useState } from 'react'
import { UserMailbox } from '../src/App'
import { CurrentOrg } from '../src/popout'
import { syncFastModes } from '../src/canvas/fastmode'
import type { TreePayload } from '../src/types'

const cfg = (window as unknown as { __bench0: { agents: number } }).__bench0
const node = (id: string, tier: string, children: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  id, title: id, tier, model_id: tier, state: 'live', seat: 2, grant: 4, free: 2, ui_order: 0, cost_usd: 0,
  occupancy: 0.31, context_window: 200000, charter: `${id} keeps its part of the synthetic organization.`,
  mail_pending: 0, limit_locked: false, last_status: { status: 'idle', summary: `${id} is standing by`, at: new Date().toISOString() },
  prev_status: null, inflight_at: null, last_denials: [], turns: [], frozen: null, audiences_held: [], bearer_state: null,
  generation: 1, busy: false, children, lineage: [],
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team', effort: 'medium' },
  configured_scope: { tools: {}, add_dirs: [] }, ...extra,
})
const own = { audiences_held: ['@user'], audiences_explicit: ['@user'] }
/** `tick` changes one agent's status, as a live organization does all the time */
const tree = (tick: number): TreePayload => ({
  slug: 'mine', name: 'Synthetic', tiers: { opus: { name: 'Opus' }, sonnet: { name: 'Sonnet' }, haiku: { name: 'Haiku' } },
  roots: [node('lead', 'opus', [
    node('worker', 'sonnet', [], own),
    ...Array.from({ length: cfg.agents }, (_, i) => node(`agent-${String(i).padStart(3, '0')}`, i % 3 ? 'haiku' : 'sonnet', [],
      { ...(i % 4 === 0 ? own : {}), ...(i === tick % cfg.agents ? { busy: true, last_status: { status: 'working', summary: `step ${tick}`, at: new Date().toISOString() } } : {}) })),
  ])],
  asks: [], asks_open: 0, user_inbox_count: 0, urgent_unread: 0,
  default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
  default_visibility: 'full', max_top_grant: 100, compact_at: 0.8,
}) as unknown as TreePayload

declare global {
  interface Window {
    __bench: { commits: { at: number; ms: number }[]; tick(): void; closed: number; toasts: string[] }
  }
}

function Probe() {
  const [tick, setTick] = useState(0)
  useEffect(() => { window.__bench.tick = () => setTick(n => n + 1) }, [])
  return (
    <CurrentOrg.Provider value="mine">
      <Profiler id="inbox" onRender={(_id, _phase, actual) => { window.__bench.commits.push({ at: performance.now(), ms: actual }) }}>
        <UserMailbox slug="mine" tree={tree(tick)} toast={lines => { window.__bench.toasts.push(...lines) }}
          close={() => { window.__bench.closed++ }} jumpTo={null} jumpSeq={null} openChat={null} />
      </Profiler>
    </CurrentOrg.Provider>
  )
}

window.__bench = { commits: [], tick() {}, closed: 0, toasts: [] }
syncFastModes([{ tiers: [{ tier: 'opus', fast_mode: true }, { tier: 'sonnet', fast_mode: true }] }] as unknown as Parameters<typeof syncFastModes>[0])
createRoot(document.getElementById('root')!).render(<Probe />)
