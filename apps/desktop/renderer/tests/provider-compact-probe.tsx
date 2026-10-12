// Render the actual Providers panel against synthetic data only.
import { createRoot } from 'react-dom/client'
import { AccountsPanel } from '../src/canvas/accounts'
import { applyTheme } from '../src/themes'

const native = [
  { id: 'claude', label: 'Claude', cli: 'Claude Code', status: { installed: true, connected: true, version: 'fixture-1', email: 'primary@example.test', kind: 'subscription' }, tiers: [
    { tier: 'opus', name: 'Opus', letter: 'O', model: 'claude-opus-fixture', seat: 4 },
    { tier: 'sonnet', name: 'Sonnet', letter: 'S', model: 'claude-sonnet-fixture', seat: 2 },
  ] },
  { id: 'openai', label: 'Codex', cli: 'Codex', status: { installed: true, connected: false, version: 'fixture-2' }, tiers: [
    { tier: 'sol', name: 'Sol', letter: 'S', model: 'codex-fixture', seat: 2 },
  ], reason: 'Sign in to use this harness.' },
  { id: 'google', label: 'Antigravity', cli: 'Antigravity', status: { installed: false, connected: null }, tiers: [] },
]
const providers = () => ({ providers: [...native.map(p => ({ ...p, user_enabled: true, hire_enabled: p.id === 'claude' })),
  { id: 'openrouter', label: 'OpenRouter', cli: 'REST API', user_enabled: true, hire_enabled: true, status: { installed: true }, tiers: [] },
  { id: 'langserver', label: 'Language servers', cli: 'local API', user_enabled: true, hire_enabled: true, status: { installed: true }, tiers: [] },
], subscription_inference: { claude: true, openai: false }, apikey_fallback: { claude: false } })
const accounts = [
  { id: 'claude-secondary', provider: 'claude', label: 'Research account with a long descriptive name', name: 'research', identity: { email: 'research-long-identity@example.test' },
    mode: 'subscription', enabled: false, credential: { kind: 'managed', path: 'D:/synthetic/profile' }, tint_ordinal: 1,
    standing: { auth: 'authenticated', state: 'limited' }, bound: [{ org: 'fixture', node: 'researcher', state: 'live' }] },
  { id: 'claude-key', provider: 'claude', label: 'Synthetic API key', name: 'api', identity: {}, mode: 'apikey', enabled: true,
    credential: { kind: 'token' }, tint_ordinal: 2, standing: { auth: 'unauthenticated' }, bound: [], origin_org: 'fixture' },
]
const servers = [true, false].map((enabled, i) => ({ id: `fixture-${i}`, preset: 'custom', label: i ? 'Disabled backup server' : 'Local models',
  address: 'http://models.example.test', base_path: '/v1', base_url: 'http://models.example.test/v1', harness: 'codex-cli', api: 'openai',
  max_agents: 2, seat: 1, enabled, key_set: true, created_at: '', models: {} }))
const serverDoc = () => ({ servers, presets: [], default_seat: 1, max_seat: 100, min_context: 65536, default_context: 65536, user_enabled: true })
window.fetch = async (url, init) => {
  const pathname = new URL(String(url), location.href).pathname
  let body: unknown = {}
  if (pathname === '/api/providers') body = providers()
  else if (pathname === '/api/accounts') body = { accounts }
  else if (pathname.includes('/marks')) body = { marks: [] }
  else if (pathname.startsWith('/api/openrouter')) body = { key_set: true, connected: true, label: 'Original key', tiers: [], favorites: 0, favorites_max: 0,
    credits: { total_credits: 25, total_usage: 3, remaining: 22 }, user_enabled: true,
    harness: { selected: 'codex-cli', harnesses: [{ id: 'codex-cli', label: 'Codex', available: true }] } }
  else if (pathname === '/api/langservers/probe') body = { reachable: false, error: 'Synthetic server unavailable', models: [] }
  else if (pathname.startsWith('/api/langservers')) body = serverDoc()
  else if (pathname === '/api/app/records') body = { records: [], cursor: '0' }
  if (init?.method && init.method !== 'GET') throw new Error('Visual fixture forbids writes')
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}
applyTheme('orgtree')
createRoot(document.getElementById('root')!).render(<AccountsPanel close={() => {}} toast={() => {}} />)
