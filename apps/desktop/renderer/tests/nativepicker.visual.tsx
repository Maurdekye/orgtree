// nativepicker.visual.tsx — Electron visual & IPC harness for nativepicker.capture.cjs
// (@item:orgtree/agent-settings-use-the-operating-system-s-native).
//
// Mounts the real NodeConfig (Agent settings > Scope > Folders), DraftScopeModal
// (Hire dialog > Scope > Folders), and FolderPickerHost in main.tsx's stylesheet
// cascade order against a synthetic app-feed WebSocket so local-org windows use
// the native Electron folder dialog IPC while remote-org windows ("Galaxy") open
// the custom in-app /api/fs picker. Browser-only synthetic fixture: no engine.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/App'
import '../src/styles.css'
import '../src/shell.css'
import { FolderPickerHost } from '../src/picker'
import { useRemoteHere } from '../src/remotehere'
import { DraftScopeModal, NodeConfig } from '../src/canvas/modals'
import type { CanvasNode, DraftScope } from '../src/canvas/shared'
import type { RemoteView } from '../src/remotes'
import type { TreePayload } from '../src/types'

type SceneKind = 'local-agent' | 'local-hire' | 'remote-agent'

class SyntheticSocket {
  static latest: SyntheticSocket | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    SyntheticSocket.latest = this
    queueMicrotask(() => {
      this.frame({
        type: 'app_snapshot',
        epoch: 'vis-1',
        seq: 1,
        registry: {
          type: 'registry_snapshot',
          epoch: 'vis-1',
          cursor: { app_uuid: 'app-vis', incarnation: 'vis-1', rev: 1 },
          records: [],
        },
        summaries: {},
        notices: {},
        runtime: { values: {}, orgs: {} },
      })
    })
  }
  close() {
    this.onclose?.()
  }
  frame(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) })
  }
}

;(window as unknown as { WebSocket: unknown }).WebSocket = SyntheticSocket

const fsRequests: string[] = []
let seq = 2

const galaxyRemote: RemoteView = {
  id: 'r-galaxy',
  name: 'Galaxy',
  tag: 'galaxy',
  url: 'http://100.64.0.7:7430',
  enabled: true,
  state: 'connected',
  since: '2026-11-13T20:00:00Z',
  next_attempt_at: null,
  version: '4.6.0',
  app_version: '4.6.0',
  version_differs: false,
  transport: 'tailscale',
  client_name: 'Orgtree desktop (TEST-PC)',
  own_token: true,
  last_error: null,
  error_code: null,
  refusal: null,
  last_connected_at: '2026-11-13T20:00:00Z',
  orgs: [{ alias: 'galaxy-org', remote_slug: 'galaxy-org', name: 'Galaxy Org', local_id: -1, gone: false }],
}

window.fetch = (async (input: RequestInfo | URL) => {
  const raw = String(input)
  const u = new URL(raw, 'http://127.0.0.1')
  if (u.pathname === '/api/app/records') {
    return new Response(
      JSON.stringify({
        type: 'app_snapshot',
        epoch: 'vis-1',
        seq: 1,
        registry: {
          type: 'registry_snapshot',
          epoch: 'vis-1',
          cursor: { app_uuid: 'app-vis', incarnation: 'vis-1', rev: 1 },
          records: [],
        },
        summaries: {},
        notices: {},
        runtime: { values: {}, orgs: {} },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  if (u.pathname === '/api/fs') {
    fsRequests.push(raw)
    return new Response(
      JSON.stringify({
        path: '/srv/galaxy/workspace',
        home: '/srv/galaxy',
        parent: '/srv/galaxy',
        dirs: [
          { name: 'apps', path: '/srv/galaxy/workspace/apps' },
          { name: 'engine', path: '/srv/galaxy/workspace/engine' },
          { name: 'shared', path: '/srv/galaxy/workspace/shared' },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  if (u.pathname === '/api/mcp-servers') {
    return new Response(JSON.stringify({ servers: [], details: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (u.pathname.includes('/accounts')) {
    return new Response(JSON.stringify({ accounts: [], host_identity: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Response(JSON.stringify({ ok: true, warnings: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}) as typeof fetch

const baseTools = { bash: true, edit: true, web: false, subagents: false, mcp: [] as string[] }
const treeFixture = {
  slug: 'orgtree-local',
  name: 'Local Org',
  workspace: 'S:\\orgtree\\workspace',
  dirs: [{ path: 'S:\\orgtree\\shared-docs', mode: 'ro' }],
  tiers: { sol: 1, opus: 5 },
  max_top_grant: 50,
  default_effort: 'high',
  effort_default: 'high',
  cascade_hire: true,
  default_tools: baseTools,
} as unknown as TreePayload

const agentFixture = {
  id: 'worker-sol',
  title: 'worker-sol',
  kind: 'agent',
  state: 'live',
  tier: 'sol',
  generation: 1,
  parent: 'user',
  children: [],
  charter: 'Implementer for desktop folder-picker checks.',
  grant: 4,
  seat: 1,
  committed: 1,
  free: 3,
  scope: {
    add_dirs: [{ path: 'S:\\orgtree\\existing-repo', mode: 'ro' }],
    tools: baseTools,
    org_visibility: 'team',
    permission_mode: 'acceptEdits',
  },
} as unknown as CanvasNode

let setSceneGlobal: ((next: SceneKind) => void) | null = null
let lastHireScope: DraftScope | null = null

function RemoteWatcher() {
  useRemoteHere()
  return null
}

function HarnessApp() {
  const [scene, setScene] = useState<SceneKind>('local-agent')
  setSceneGlobal = setScene
  return (
    <div
      className="shell-v3"
      style={{
        width: '100vw',
        height: '100vh',
        background: 'var(--bg, #11161d)',
        color: 'var(--fg, #e6edf3)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <RemoteWatcher />
      <FolderPickerHost />
      {scene === 'local-hire' ? (
        <DraftScopeModal
          key="hire"
          draft={{ parent: null, tier: 'sol' }}
          map={new Map()}
          tree={treeFixture}
          scope={null}
          accounts={[]}
          tab="scope"
          onSave={(s) => {
            lastHireScope = s
          }}
          close={() => {}}
        />
      ) : (
        <NodeConfig
          key={scene}
          node={agentFixture}
          map={new Map([[agentFixture.id, agentFixture]])}
          tree={treeFixture}
          slug={scene === 'remote-agent' ? 'galaxy-org' : 'orgtree-local'}
          target={{ tab: 'scope', field: '', seq: 1 }}
          op={async () => ({})}
          toast={() => {}}
          close={() => {}}
        />
      )}
    </div>
  )
}

;(window as unknown as Record<string, unknown>).__pickerVisual = {
  async setScene(next: SceneKind) {
    fsRequests.length = 0
    document.querySelector<HTMLElement>('.picker-overlay')?.click()
    setSceneGlobal?.(next)
    seq += 1
    SyntheticSocket.latest?.frame({
      type: 'app_runtime',
      epoch: 'vis-1',
      seq,
      values: {
        remotes: { epoch: 'vis-1', seq, value: [galaxyRemote] },
        remote_link: { epoch: 'vis-1', seq, value: next === 'remote-agent' ? galaxyRemote : null },
      },
    })
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 40))),
    )
    document.querySelector<HTMLElement>('button[title="Browse for a folder"]')?.scrollIntoView({
      block: 'center',
      behavior: 'instant',
    })
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  },
  async setInput(value: string) {
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Add a folder path"]')
    if (!input) throw new Error('Missing folder path input')
    input.scrollIntoView({ block: 'center', behavior: 'instant' })
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  },
  scrollBrowseIntoView() {
    document.querySelector<HTMLElement>('button[title="Browse for a folder"]')?.scrollIntoView({
      block: 'center',
      behavior: 'instant',
    })
  },
  state() {
    const browse = document.querySelector<HTMLButtonElement>('button[title="Browse for a folder"]')
    const rect = browse?.getBoundingClientRect() ?? null
    const cx = rect ? Math.round(rect.left + rect.width / 2) : 0
    const cy = rect ? Math.round(rect.top + rect.height / 2) : 0
    const topEl = rect ? document.elementFromPoint(cx, cy) : null
    const hitBrowse = Boolean(browse && topEl && (topEl === browse || browse.contains(topEl)))
    return {
      browseRect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height, cx, cy } : null,
      hitBrowse,
      chips: [...document.querySelectorAll('.dirlist .chip.mono')].map((el) => el.textContent?.trim() ?? ''),
      pickerHeading: document.querySelector('.picker h3')?.textContent?.trim() ?? null,
      pickerRows: [...document.querySelectorAll('.picker-row')].map((el) => el.textContent?.trim() ?? ''),
      hasCustomOverlay: Boolean(document.querySelector('.picker-overlay')),
      fsRequests: fsRequests.slice(),
      lastHireDirs: lastHireScope?.add_dirs ?? null,
    }
  },
}

createRoot(document.getElementById('root')!).render(<HarnessApp />)
