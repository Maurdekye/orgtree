// tests/harnessrow.visual.tsx — what harnessrow.capture.cjs draws for
// @item:orgtree/harness-setting-in-an-agent-s-model-tab-change-a: the agent
// settings Model tab of an OpenRouter seat (following its key, and with a
// harness of its own) and of a language model server seat on a custom
// server. No engine: the fixture answers the panel's reads itself, as
// GET /nodes/{nid}/harness answers (harnesses::seat_row), and records each op
// the panel sends. The same file draws the base (before) and the tip (after),
// so it imports only what both have.
import '../src/styles.css'
import '../src/shell.css'
import { createRoot } from 'react-dom/client'
import { NodeConfig } from '../src/canvas/modals'
import { setLangServerTiers, setOpenRouterTiers, USER } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpRequest, OpResult, ProviderInfo, TreePayload } from '../src/types'

const SLUG = 'harness-fixture'
const OR_TIER = 'or-moonshotai-kimi-k3'
const LS_TIER = 'ls-gateway-qwen3'
setOpenRouterTiers([{ tier: OR_TIER, provider: 'openrouter', seat: 1, model: 'moonshotai/kimi-k3', letter: 'K',
  color: '#8f9bff', name: 'Kimi K3', label: 'kimi-k3', vendor: 'moonshotai' } as never])
setLangServerTiers([{ tier: LS_TIER, provider: 'langserver', seat: 1, model: 'qwen3', letter: 'Q',
  color: '#8fdf9b', name: 'qwen3', label: 'qwen3' } as never])
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const noop = () => {}
const root = createRoot(document.getElementById('root')!)
const reads: string[] = []
const ops: OpRequest[] = []

const node = (tier: string): CanvasNode => ({
  id: 'worker', title: 'worker', state: 'live', tier, model_id: tier, generation: 1,
  parent: USER, children: [], seat: 1, grant: 4, free: 4,
  scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
    org_visibility: 'team' },
  charter: 'Writes the release notes.', team_charter: '', turns: [], audiences_held: [],
} as unknown as CanvasNode)
const TREE = { slug: SLUG, dirs: [], tiers: { opus: 5, sonnet: 2, sol: 5, [OR_TIER]: 1, [LS_TIER]: 1 },
  max_top_grant: 100, default_effort: '', effort_default: 'high', cascade_hire: true } as unknown as TreePayload
const prov = (id: string, label: string): ProviderInfo => ({ id, label, cli: `${label} CLI`, tiers: [],
  status: { installed: true, connected: true, kind: 'chatgpt' }, hire_enabled: true, reason: null })

const installed = (id: string, label: string) => ({ id, label, installed: true, available: true, why: 'installed' })
const OPENCODE_ABSENT = { id: 'opencode', label: 'OpenCode (ACP)', installed: false, available: false,
  why: 'OpenCode (ACP) is not installed on this computer' }
let seatTier = OR_TIER
let pin: string | null = null
const laneOf = (t: string) => t.startsWith('ls-') ? 'langserver' : t.startsWith('or-') ? 'openrouter' : 'other'
const custom = (h: string) => `this custom server's base path is set for Claude Code's API; ${h} needs its own server entry`
const harnessAnswer = (tier: string) => {
  const moves = tier !== seatTier && laneOf(tier) !== laneOf(seatTier)
  if (laneOf(tier) === 'openrouter') {
    return { tier, lane: 'openrouter', pin: moves ? null : pin, current: moves ? null : pin ?? 'codex-cli', moves,
      follow: { id: 'codex-cli', label: 'Codex', installed: true, source: 'key', name: 'team budget' },
      options: [installed('claude-code', 'Claude Code'), installed('codex-cli', 'Codex'), OPENCODE_ABSENT] }
  }
  if (laneOf(tier) === 'langserver') {
    return { tier, lane: 'langserver', pin: null, current: moves ? null : 'claude-code', moves,
      follow: { id: 'claude-code', label: 'Claude Code', installed: true, source: 'server', name: 'Gateway' },
      options: [installed('claude-code', 'Claude Code'),
        { id: 'codex-cli', label: 'Codex', installed: true, available: false, why: custom('Codex') },
        { ...OPENCODE_ABSENT }] }
  }
  return { tier, lane: null, follow: null, pin: null, current: null, options: [], moves }
}
window.fetch = ((raw: RequestInfo | URL) => {
  const u = new URL(String(raw), 'http://local')
  reads.push(u.pathname + u.search)
  if (/\/nodes\/worker\/harness$/.test(u.pathname)) return Promise.resolve(json(harnessAnswer(u.searchParams.get('tier') ?? '')))
  if (/\/chat$/.test(u.pathname)) return Promise.resolve(json({ messages: [], live: [], busy: false, queued: 0, responding: false }))
  if (/\/api\/accounts$/.test(u.pathname)) return Promise.resolve(json({ accounts: [], host_identity: {} }))
  if (/\/mcp-servers$|\/mcp$/.test(u.pathname)) return Promise.resolve(json({ servers: [], details: [] }))
  if (/\/history$/.test(u.pathname)) return Promise.resolve(json({ items: [] }))
  return Promise.resolve(json({}))
}) as typeof fetch

type Scene = 'or-follow' | 'or-pinned' | 'server'
let seq = 0
Object.assign(window, { harnessFixture: {
  reads, ops,
  show: (scene: Scene) => {
    localStorage.setItem('orgtree-contrast-theme', 'charcoal')
    document.documentElement.classList.remove('contrast-light')
    ops.length = 0
    seatTier = scene === 'server' ? LS_TIER : OR_TIER
    pin = scene === 'or-pinned' ? 'claude-code' : null
    const nd = node(seatTier)
    root.render(<NodeConfig key={scene + ++seq} node={nd} map={new Map([[nd.id, nd]])} tree={TREE} slug={SLUG}
      op={(x) => { ops.push(x); return Promise.resolve({} as OpResult) }} toast={noop}
      codexProvider={prov('openai', 'Codex')} antigravityProvider={prov('google', 'Antigravity')}
      target={{ id: nd.id, tab: 'model', seq } as never} close={noop} />)
  },
} })
