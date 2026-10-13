// Render the real hire sheet and the OpenRouter favourites row against synthetic data only
// (tierlisting-visual.mjs bundles this and tierlisting-visual.cjs photographs it).
//   ?view=hire        the Hire sheet with every provider on
//   ?view=openrouter  App settings > Providers > OpenRouter with five chosen models, served unsorted
import { createRoot } from 'react-dom/client'
import { HireSheet } from '../src/canvas/OrgCanvas'
import { OpenRouterSection } from '../src/canvas/openrouter'
import { applyTheme } from '../src/themes'
import { byOpenrouterPriceDesc, setMuseProvider, setOpenRouterTiers, USER } from '../src/canvas/shared'
import type { CanvasNode, HireState } from '../src/canvas/shared'
import type { ProviderInfo, ProviderTier } from '../src/types'

const SEATS = { haiku: 0.5, sonnet: 2, opus: 4, fable: 10, 'gpt-reserve': 0.2, luna: 0.1, terra: 2, sol: 2, astra: 10,
  flash: 1, pro: 2, 'agy-sonnet': 2, 'agy-opus': 4, wonder: 4, 'wonder-full': 10, spark: 2 }
const ON: HireState = { enabled: true, installed: true, reason: null }
const MUSE_ROWS = ['wonder', 'wonder-full', 'spark']

// five chosen OpenRouter models, in the (unsorted) order the user picked them
const orTier = (slug: string, name: string, prompt: number, completion: number, color: string, unknown?: string[]): ProviderTier => ({
  tier: 'or-' + slug.replace(/[^a-z0-9]+/g, '-'), provider: 'openrouter', seat: Math.max(1, Math.floor(prompt)), model: slug,
  letter: name[0]!.toUpperCase(), color, name, label: slug.split('/')[1]!, vendor: slug.split('/')[0], prompt, completion,
  ...(unknown ? { price_unknown: unknown } : {}),
})
const PICKED: ProviderTier[] = [
  orTier('openai/gpt-5.6-luna', 'GPT-5.6 Luna', 0.2, 1.2, '#9fe3d1'),
  orTier('z-ai/glm-5.2:free', 'GLM 5.2 (free)', 0, 0, '#8fc9e8'),
  orTier('anthropic/claude-sonnet-5', 'Claude Sonnet 5', 2, 10, '#f9907f'),
  orTier('openrouter/auto', 'Auto Router', 0, 0, '#c9b8ff', ['prompt', 'completion']),
  orTier('moonshotai/kimi-k3', 'Kimi K3', 3, 15, '#ffd479'),
]

const view = new URLSearchParams(location.search).get('view') ?? 'hire'
const root = createRoot(document.getElementById('root')!)
applyTheme('orgtree')

if (view === 'hire') {
  // the engine serves them dearest first; the registry keeps that order
  setOpenRouterTiers([...PICKED].sort(byOpenrouterPriceDesc))
  setMuseProvider({ id: 'muse', label: 'Muse', cli: 'muse', hire_enabled: true, reason: null, status: { installed: true, connected: true },
    tiers: MUSE_ROWS.map((tier) => ({ tier, provider: 'muse', seat: SEATS[tier as keyof typeof SEATS], model: tier, letter: tier[0]!.toUpperCase() })),
    muse: { logins: [] } } as unknown as ProviderInfo)
  const anchor = { id: 'overseer', title: 'overseer', state: 'live', tier: 'opus', model_id: 'opus', parent: USER, children: [],
    seat: 4, grant: 20, free: 20, scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
    charter: '', team_charter: '', turns: [], audiences_held: [], lineage: [] } as unknown as CanvasNode
  root.render(<HireSheet anchor={anchor} seats={SEATS} defaultGrant={0}
    claudeHire={ON} codexHire={ON} antigravityHire={{ ...ON, offeredTiers: ['flash', 'pro', 'agy-sonnet', 'agy-opus'] }}
    museHire={{ ...ON, offeredTiers: MUSE_ROWS }} openrouterHire={ON} onHire={() => {}} onClose={() => {}} />)
} else {
  const PROVIDER: ProviderInfo = { id: 'openrouter', label: 'OpenRouter', cli: 'REST API (via Claude Code)', tiers: [],
    status: { installed: true, connected: true, key_set: true }, hire_enabled: true, user_enabled: true, reason: null } as unknown as ProviderInfo
  const doc = {
    installed: true, connected: true, key_set: true, kind: 'api-key', label: 'sk-or-v1-abc…xyz',
    credits: { limit: 25, limit_remaining: 22, usage: 3, usage_daily: null, usage_weekly: null, usage_monthly: null, is_free_tier: false, checked_at: '2026-10-13T00:00:00Z' },
    reason: null, favorites: PICKED.length, favorites_max: 0, tiers: PICKED, user_enabled: true, any_key: true, keys: [],
  }
  window.fetch = async (url) => {
    const pathname = new URL(String(url), location.href).pathname
    const body = pathname.startsWith('/api/openrouter') ? doc : {}
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  }
  root.render(<div className="settings" style={{ maxWidth: 760, margin: '24px auto' }}>
    <OpenRouterSection provider={PROVIDER} toast={() => {}} pickerOpen={false} setPickerOpen={() => {}} /></div>)
}
