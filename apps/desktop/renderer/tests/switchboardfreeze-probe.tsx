import { createRoot } from 'react-dom/client'
import { Profiler } from 'react'
import '../src/App'
import '../src/styles.css'
import '../src/shell.css'
import { EyeDesk } from '../src/canvas/cards'
import { DeskHosts } from '../src/canvas/deskhosts'
import { AttentionView } from '../src/attention/AttentionView'
import { setAttentionLayout, setOrgView } from '../src/attention/mode'
import { PinFrame, pinModal } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { loadOlder } from '../src/convo'
import { USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload, OpResult } from '../src/types'

const noop = () => {}
// EyeDesk normally counter-scales a zoomed canvas card. This native-window
// fixture supplies an unscaled viewport, while retaining the real desk DOM.
const style = document.createElement('style')
style.textContent = '.switchboard-fixture{position:relative;width:1100px;height:760px}' + (location.hash === '#canvas' ? '' : '.switchboard-fixture .eye-desk{position:relative;inset:auto;height:680px}.switchboard-fixture .eye-inner{transform:none!important;width:100%!important;height:100%!important}')
document.head.appendChild(style)
const op = () => Promise.resolve({} as OpResult)
const agents = ['coordinator-opus', 'peer-a', 'peer-b'].map(id => ({
  id, tier: 'opus', state: 'live', generation: 0, parent: USER, children: [],
  seat: 4, grant: 0, free: 0, scope: { tools: { mcp: [] }, add_dirs: [] },
} as unknown as CanvasNode))
const map = new Map(agents.map(n => [n.id, n]))
const tree = { slug: 'probe', name: 'probe', epoch: 1, rev: 1,
  roots: agents, asks: [], asks_open: 0, tiers: { opus: 4 }, audiences: [],
  audience_requests: [], credit_requests: [], workspace: null, dirs: [],
  audit: { live_nodes: 3, top_level_holds: 12, no_overdraft: true, problems: [] },
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0, cost_usd_total: 0,
  work_items_summary: { attention: 0, active: 0 }, user_inbox_count: 0 } as unknown as TreePayload
const count = Number(new URLSearchParams(location.search).get('rows') || 3000)
const messages = Array.from({ length: count }, (_, seq) => ({
  seq, event_id: `event-${seq}`, native_event_id: `event-${seq}`,
  role: seq % 7 === 0 ? 'user' : seq % 31 === 0 ? 'system' : 'assistant',
  text: `Transcript row ${seq}\n\n` + 'Measured renderer work with **markdown**, `code` and tool output. '.repeat(8),
  ...(seq % 31 === 0 ? { summary: 'Earlier session compacted. '.repeat(20) } : {}),
  ...(seq % 7 !== 0 ? { tools: [{ id: `tool-${seq}`, name: 'Read', input: { path: `file-${seq}.ts` }, result: 'tool output\n'.repeat(100) }] } : {}),
}))
const probe = { commits: 0, heartbeat: 0, requests: 0,
  load: () => loadOlder('probe', agents[0]!.id, count),
  historyRows: () => document.querySelectorAll('[data-native-event]').length }
Object.assign(window, { probe })
window.fetch = ((url: string) => {
  probe.requests++
  const parsed = new URL(String(url), location.href)
  const path = parsed.pathname
  const end = Number(parsed.searchParams.get('before') || count)
  const start = Math.max(0, end - Number(parsed.searchParams.get('last') || 8))
  const body = /\/chat$/.test(path) ? { busy: false, queued: 0,
    conversation_id: 'synthetic-long-session', order_epoch: 1,
    messages: messages.slice(start, end), pending_mail: [], has_older: start > 0,
    ...(start > 0 ? { before: String(start) } : {}) }
    : /\/work-items/.test(path) ? { items: [], archived: [], backlogged: [], counts: {} }
    : /\/inbox$/.test(path) ? { pending: [], delivered: [], sent: [] }
    : /\/providers$/.test(path) ? { providers: [] } : { ok: true }
  return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }))
}) as typeof fetch
localStorage.clear()
localStorage.setItem('orgtree-eyemin-probe', JSON.stringify(agents.map(n => n.id)))
localStorage.setItem('orgtree-start-view', 'switchboard')
setAttentionLayout('probe', { agent: agents[0]!.id })
setOrgView('probe', 'canvas')
pinModal('attention-desk', { x: 970, y: 90, w: 410, h: 720 }, 'probe')
createRoot(document.getElementById('root')!).render(location.hash === '#long-main' ?
  <Profiler id="long-main" onRender={() => { if (++probe.commits > 500) throw new Error('Switchboard render loop') }}>
    <CurrentOrg.Provider value="probe">
      <button data-heartbeat style={{position: 'fixed', bottom: 10, left: 10, zIndex: 500}} onClick={() => probe.heartbeat++}>Check interaction</button>
      <div className="canvas-stage" style={{height:'100vh',width:'100vw'}}>
        <OrgCanvas tree={tree} slug="probe" mailEvt={null} op={op} toast={noop}
          focusAgent={USER} onFocusAgentHandled={noop}
          renderOrgSlot={ctx => <AttentionView slug={ctx.slug} tree={ctx.tree} op={ctx.op}
            toast={ctx.toast} map={ctx.map} posOf={ctx.posOf} deskExtras={ctx.deskExtras} />} />
      </div>
    </CurrentOrg.Provider>
  </Profiler> : location.hash === '#canvas' ?
  <Profiler id="canvas" onRender={() => { if (++probe.commits > 500) throw new Error('Switchboard render loop') }}>
    <CurrentOrg.Provider value="probe">
      <PinFrame inline kind="switchboard-fixture" title="Switchboard" panel="switchboard-fixture" close={noop}>
        <button data-heartbeat onClick={() => probe.heartbeat++}>Check interaction</button>
        <div style={{ height: 700, display: 'flex' }}><OrgCanvas tree={tree} slug="probe" mailEvt={null}
          op={op} toast={noop} focusAgent={USER} onFocusAgentHandled={noop}
          renderOrgSlot={ctx => <AttentionView slug={ctx.slug} tree={ctx.tree} op={ctx.op}
            toast={ctx.toast} map={ctx.map} posOf={ctx.posOf} deskExtras={ctx.deskExtras} />} /></div>
      </PinFrame>
    </CurrentOrg.Provider>
  </Profiler> :
  <Profiler id="switchboard" onRender={() => {
    if (++probe.commits > 150) throw new Error('Switchboard render loop')
  }}><CurrentOrg.Provider value="probe"><DeskHosts map={map} slug="probe">
    <AttentionView slug="probe" tree={tree} map={map} op={op} toast={noop} />
    <PinFrame inline kind="switchboard-fixture" title="Switchboard" panel="switchboard-fixture" close={noop}>
      <button data-heartbeat onClick={() => probe.heartbeat++}>Check interaction</button>
      <EyeDesk slug="probe" map={map} op={op} toast={noop} pub={false} eyeW={1100}
        posX={() => 0} onMailLink={noop} onWorkLink={noop} />
    </PinFrame>
  </DeskHosts></CurrentOrg.Provider></Profiler>)
