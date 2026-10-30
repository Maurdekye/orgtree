// tests/hireharness.visual.tsx — what hireharness.capture.cjs draws for
// @item:orgtree/harness-everywhere-harness-row-in-the-hire-dialo: the hire
// dialog's (Draft settings) Model tab for a draft on an OpenRouter tier
// (following its key, and with a harness of its own staged), on a custom
// language model server, and on Claude (no row). No engine: the fixture
// answers GET /hire-harness itself, as harnesses::hire_row answers, and
// records every draft the panel stages. The same file draws the base (before)
// and the tip (after), so it imports only what both have.
import '../src/styles.css'
import '../src/shell.css'
import { createRoot } from 'react-dom/client'
import { DraftScopeModal } from '../src/canvas/modals'
import { setLangServerTiers, setOpenRouterTiers, USER } from '../src/canvas/shared'
import type { DraftScope, DraftState } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const SLUG = 'draft-harness'
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
const staged: DraftScope[] = []

const TREE = { slug: SLUG, dirs: [], tiers: { opus: 5, [OR_TIER]: 1, [LS_TIER]: 1 },
  default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] }, default_visibility: 'team',
  permission_mode: 'acceptEdits', max_top_grant: 100, default_effort: '', effort_default: 'high', cascade_hire: true,
} as unknown as TreePayload
const installed = (id: string, label: string) => ({ id, label, installed: true, available: true, why: 'installed' })
const OPENCODE_ABSENT = { id: 'opencode', label: 'OpenCode (ACP)', installed: false, available: false,
  why: 'OpenCode (ACP) is not installed on this computer' }
const custom = (h: string) => `this custom server's base path is set for Claude Code's API; ${h} needs its own server entry`
/** GET /api/orgs/{slug}/hire-harness?tier= as harnesses::hire_row answers */
const hireRow = (tier: string) => tier.startsWith('or-') ? {
  tier, lane: 'openrouter', pin: null, current: null, moves: false,
  follow: { id: 'codex-cli', label: 'Codex', installed: true, source: 'key', name: 'team budget' },
  options: [installed('claude-code', 'Claude Code'), installed('codex-cli', 'Codex'), OPENCODE_ABSENT],
} : tier.startsWith('ls-') ? {
  tier, lane: 'langserver', pin: null, current: null, moves: false,
  follow: { id: 'claude-code', label: 'Claude Code', installed: true, source: 'server', name: 'Gateway' },
  options: [installed('claude-code', 'Claude Code'),
    { id: 'codex-cli', label: 'Codex', installed: true, available: false, why: custom('Codex') }, { ...OPENCODE_ABSENT }],
} : { tier, lane: null, follow: null, pin: null, current: null, options: [], moves: false }
window.fetch = ((raw: RequestInfo | URL) => {
  const u = new URL(String(raw), 'http://local')
  reads.push(u.pathname + u.search)
  if (u.pathname === `/api/orgs/${SLUG}/hire-harness`) return Promise.resolve(json(hireRow(u.searchParams.get('tier') ?? '')))
  if (/\/api\/accounts$/.test(u.pathname)) return Promise.resolve(json({ accounts: [], host_identity: {} }))
  if (/\/mcp-servers$|\/mcp$/.test(u.pathname)) return Promise.resolve(json({ servers: [], details: [] }))
  return Promise.resolve(json({}))
}) as typeof fetch

type Scene = 'or-follow' | 'or-own' | 'server' | 'claude'
let seq = 0
Object.assign(window, { harnessFixture: {
  reads, staged,
  show: (scene: Scene) => {
    localStorage.setItem('orgtree-contrast-theme', 'charcoal')
    document.documentElement.classList.remove('contrast-light')
    staged.length = 0
    const tier = scene === 'server' ? LS_TIER : scene === 'claude' ? 'opus' : OR_TIER
    const draft: DraftState = { parent: USER, tier }
    // a harness of its own, staged for this model (the tip reads it; the base
    // has no such field and ignores it)
    const scope = scene === 'or-own' ? { add_dirs: [], tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
      org_visibility: 'team', harness: 'claude-code', harness_tier: OR_TIER } as DraftScope : null
    root.render(<DraftScopeModal key={scene + ++seq} draft={draft} map={new Map()} tree={TREE} scope={scope}
      onSave={(s) => { staged.push(s) }} close={noop} accounts={[]} name="proposed" onName={noop}
      tab="model" onTab={noop} />)
  },
} })
