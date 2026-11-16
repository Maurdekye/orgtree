// shaderwarmup.tsx - the scene main/shader-warmup.ts draws once, offscreen, to compile the
// desk/node GPU shaders before the user's first desk switch (4.6.1, item
// hang-every-time-a-new-desk-loads-especially-whil, USER m67c841ee83a3 "Add a warm-up").
//
// The REAL canvas, nodes and desks over a SYNTHETIC org: no engine, no preload, no user data.
// This document's fetch and WebSocket are replaced before anything renders, and its window's
// session refuses every request except the UI's own files (main/shader-warmup.ts).
// It visits the far view (mini nodes), then glides to a few agents so their norm nodes and
// desks are drawn, and sets the title the main side waits for.
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { OrgCanvas } from './canvas/OrgCanvas'
import { CurrentOrg } from './popout'
import type { TreePayload } from './types'

export const WARMUP_DONE_TITLE = 'orgtree-shader-warmup:done'
const SLUG = 'shader-warmup'
const AGENTS = 16
const DESKS = ['a1', 'a6', 'a11']

const slugs = Array.from({ length: 8 }, (_, i) => `warmup-item-${i}`)
const message = (id: string, i: number) => ({
  role: i % 4 === 0 ? 'user' : 'assistant', seq: i, event_id: `${id}-e${i}`, row_id: `r${i}`,
  ts: new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString(),
  text: `Step ${i} on @item:${SLUG}/${slugs[i % 8]} with @${id === 'a1' ? 'a2' : 'a1'}.\n\n`
    + `- checked \`src/canvas/desk.tsx\`\n- **result**: _fine_ ${'words here '.repeat(8)}\n\n`
    + '> a quoted line\n\n```ts\nconst x = ' + i + '\nfunction f() { return x * 2 }\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
})

function stubNetwork(): void {
  window.WebSocket = class { close() {} addEventListener() {} removeEventListener() {} send() {} } as unknown as typeof WebSocket
  window.fetch = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input instanceof Request ? input.url : input), 'http://warmup.invalid')
    let body: unknown = { ok: true, rows: [], items: [], pending: [], delivered: [], sent: [], transfers: [], counts: {}, agents: [], history: [], next_cursor: null }
    const chat = /\/nodes\/([^/]+)\/chat$/.exec(u.pathname)
    if (chat) {
      const all = Array.from({ length: 12 }, (_, i) => message(chat[1], i))
      body = { busy: false, queued: 0, responding: false, last_error: null, messages: all, live: [], draft_epoch: 'warmup:0',
        mail_pending: 0, pending_mail: [], conversation_id: chat[1], has_older: false, before: null, after: `1:${all.length - 1}` }
    } else if (/work-item-references/.test(u.pathname)) {
      const names = (u.searchParams.get('names') || '').split(',').filter(Boolean)
      body = { references: names.map(slug => ({ slug, title: `The ${slug} title`, status: 'in_progress', archived: false })) }
    }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

const node = (id: string, parent: string | null, i: number, children: unknown[] = []): unknown => ({
  id, title: id, parent, kind: 'agent', tier: ['sol', 'opus', 'sonnet'][i % 3], model_id: 'sol', state: i % 5 === 4 ? 'asleep' : 'live',
  seat: 2, grant: 0, free: 0, ui_order: i, generation: 1, children, lineage: [], turns: [], audiences_held: [], cost_usd: 0,
  mail_pending: i % 4 === 1 ? 2 : 0, frozen: null, occupancy: null, context_window: null, busy: i % 3 === 0,
  last_status: { status: ['working', 'done', 'blocked', 'idle'][i % 4], summary: `on @item:${SLUG}/${slugs[i % 8]}` },
  scope: { tools: {}, add_dirs: [], org_visibility: 'team', permission_mode: 'default' }, configured_scope: {},
})
const tree = (): TreePayload => {
  const ids = Array.from({ length: AGENTS }, (_, i) => `a${i + 1}`)
  return { slug: SLUG, name: 'Warm-up', rev: 1,
    roots: [0, 1].map(m => node(`m${m}`, null, m, ids.slice(m * 8, m * 8 + 8).map((id, i) => node(id, `m${m}`, i + 1)))),
    dirs: [], tiers: { sol: 2, opus: 2, sonnet: 2 }, default_top_grant: 12, max_top_grant: 100, audiences: [], audience_requests: [],
    credit_requests: [], user_inbox_count: 0, default_visibility: 'team', default_tools: {},
  } as unknown as TreePayload
}

const frames = (n: number) => new Promise<void>(r => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f) })
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function Scene({ step }: { step: number }) {
  const [focus, setFocus] = useState<string | null>(null)
  const [data] = useState(tree)
  useEffect(() => {
    let live = true
    void (async () => {
      await frames(10)
      for (const id of DESKS) { if (!live) return; setFocus(id); await wait(step); await frames(2) }
      if (live) document.title = WARMUP_DONE_TITLE
    })()
    return () => { live = false }
  }, [step])
  return <CurrentOrg.Provider value={SLUG}>
    <div className="app"><main className="solo"><div className="canvas-stage">
      <OrgCanvas tree={data} slug={SLUG} mailEvt={null} toast={() => {}} op={async () => ({})}
        focusAgent={focus} focusAgentDesk onFocusAgentHandled={() => setFocus(null)} />
    </div></main></div>
  </CurrentOrg.Provider>
}

export function mountShaderWarmup(root: HTMLElement): void {
  stubNetwork()
  try { localStorage.clear() } catch { /* in-memory session: nothing kept */ }
  const step = Math.min(3000, Math.max(200, Number(new URLSearchParams(location.search).get('step')) || 1200))
  createRoot(root).render(<Scene step={step} />)
}
