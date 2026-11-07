// sparkbench.tsx — per-frame cost of in-flight sparks during a layout glide.
// Not part of the suite. Run: node tests/run.mjs sparkbench
// 50 sparks are held in flight (performance.now frozen) while 40 layout changes
// re-render the canvas; each change's wall time is sampled. Compare base vs tip.
declare const __SRC_DIR__: string
import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import { useState } from 'react'
import type { TreePayload } from '../src/types'

const noop = () => {}
const mk = (id: string) => ({ id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live', seat: 1, grant: 0, free: 0, ui_order: 0,
  cost_usd: 0, occupancy: null, context_window: null, charter: null, mail_pending: 0, limit_locked: false, last_status: null, prev_status: null,
  inflight_at: null, last_denials: [], turns: [], frozen: null, audiences_held: [], bearer_state: null, generation: 0, children: [], lineage: [],
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' } })
const tree = (ids: string[]) => ({ slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000, default_top_grant: 50, compact_at: 0,
  default_tools: null, default_visibility: 'team', default_effort: '', credit_requests: [], tiers: { haiku: 1 }, audiences: [], roots: ids.map(mk),
  cost_usd_total: 0, audit: { live_nodes: ids.length, top_level_holds: 0, no_overdraft: true, problems: [] }, user_inbox_count: 0, user_inbox_newest: null,
  fable_lock: null, auto_resume: false, fable_limit_policy: 'freeze', fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true,
  audience_requests: [], org_inbox: { entries: [], unread: 0, holders: ['n0'], visible: true }, net: null }) as unknown as TreePayload

// skipped unless ORGTREE_SPARKBENCH=1 (it prints timings; it asserts nothing)
test('spark bench', { skip: !process.env.ORGTREE_SPARKBENCH }, async () => {
  useFakeClock()
  try {
    const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
    const base = Array.from({ length: 20 }, (_, i) => 'n' + i)
    let set!: (n: number) => void
    function Scene() { const [n, s] = useState(0); set = s
      return <OrgCanvas tree={tree([...base, ...Array.from({ length: n }, (_, i) => 'x' + i)])} op={() => Promise.resolve({} as never)} slug="mine" toast={noop} /> }
    const v = await mountView(<Scene />, (h) => h)
    await flush()
    const real = performance.now.bind(performance); const t0 = real()
    performance.now = () => t0 // sparks never expire
    const fire = (globalThis as unknown as { window: { __spark: (a: string, b: string) => void } }).window.__spark
    await inAct(() => { for (let i = 0; i < 50; i++) fire(i % 3 ? 'n' + (i % 20) : 'org_inbox', 'n' + ((i * 7 + 3) % 20)) })
    const dts: number[] = []
    for (let i = 1; i <= 40; i++) {
      const a = real()
      await inAct(async () => { set(i % 6); await flush(2) })
      dts.push(real() - a)
    }
    performance.now = real
    const live = v.el.querySelectorAll('circle.spark').length
    dts.sort((x, y) => x - y)
    console.log(`SPARKBENCH sparks_live=${live} median_ms=${dts[20]!.toFixed(2)} p95_ms=${dts[37]!.toFixed(2)} min=${dts[0]!.toFixed(2)} max=${dts[39]!.toFixed(2)}`)
    await v.unmount()
  } finally { realClock() }
})
