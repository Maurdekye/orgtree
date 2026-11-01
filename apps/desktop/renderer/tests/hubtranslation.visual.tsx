// tests/hubtranslation.visual.tsx — what hubtranslation.capture.cjs draws:
// App settings → Mail hub → Hosting's Translation group (Mail hub 2.4.0;
// docket mail-hub-hubchat-automatic-translation-between-u) over a synthetic
// hub, in three states: off (as a fresh install has it), on with a key and
// this month at 84% of its limit, and on with the key refused. No engine:
// every read is answered here from synthetic data.
import '../src/styles.css'
import '../src/shell.css'
import { createRoot } from 'react-dom/client'
import { AccountsPanel } from '../src/canvas/accounts'

type Scene = 'off' | 'on' | 'refused'
const base = {
  version: 2, port: 7370, bind: '127.0.0.1', name: 'synthetic-hub', retention_days: null, org_retention_days: 45,
  public_listener: false, public_listener_port: 7371, max_attachment_bytes: 1024 ** 3,
}
const status = { running: true, healthy: true, address: 'http://127.0.0.1:7370', exposed: false, hub_name: 'synthetic-hub',
  hub_version: '2.4.0', orgs: 3, queued: 0 }
const HUB: Record<Scene, unknown> = {
  off: { ...base, translation: { enabled: false, default_language: 'en', model: 'claude-haiku-5-5', monthly_limit_usd: 5 },
    translation_key_set: false,
    status: { ...status, translation: { enabled: false, state: 'off', month: '2026-11', spent_usd: 0, messages: 0, limit_usd: 5 } } },
  on: { ...base, translation: { enabled: true, default_language: 'en', model: 'claude-haiku-5-5', monthly_limit_usd: 5 },
    translation_key_set: true,
    status: { ...status, translation: { enabled: true, state: 'ok', month: '2026-11', spent_usd: 4.2, messages: 7012, limit_usd: 5 } } },
  refused: { ...base, translation: { enabled: true, default_language: 'he', model: 'claude-haiku-5-5', monthly_limit_usd: 5 },
    translation_key_set: true,
    status: { ...status, translation: { enabled: true, state: 'key_refused', month: '2026-11', spent_usd: 0.31, messages: 240, limit_usd: 5 } } },
}
let scene: Scene = 'off'
const answer = (url: string): unknown => {
  const path = url.split('?')[0]!
  if (path === '/api/desktop/hub') return HUB[scene]
  if (path === '/api/desktop/hub/connections') return { running: true, connections: [], recent: {} }
  if (path === '/api/desktop/phone/card') return { card: { show: false, dismissed: true, org: 'fixture' } }
  if (path === '/api/desktop/phone') return { hubchat_pc: false, card: { show: false, dismissed: true, org: 'fixture' } }
  if (path.startsWith('/api/accounts')) return { version: 2, primary: { id: 'primary', signed_in: true, email: 'me@example.test' }, keys: [], assignments: {} }
  if (path.startsWith('/api/providers')) return { providers: [] }
  if (path.startsWith('/api/runtime-settings')) return { warming_enabled: true }
  return {}
}
const reads: string[] = []
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  reads.push(url)
  // the capture never saves: a write would be a bug in the fixture
  if (init?.method && init.method !== 'GET') throw Error(`no writes in the fixture: ${init.method} ${url}`)
  return new Response(JSON.stringify(answer(url)), { headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch
window.open = (() => null) as typeof window.open
const root = createRoot(document.getElementById('root')!)
Object.assign(window, { trFixture: {
  reads,
  show: (next: Scene, theme: 'dark' | 'light') => {
    scene = next
    localStorage.setItem('orgtree-contrast-theme', theme === 'light' ? 'light' : 'charcoal')
    document.documentElement.classList.toggle('contrast-light', theme === 'light')
    root.render(<AccountsPanel key={next + theme} toast={() => {}} close={() => {}} initialTab="mailhub" />)
  },
} })
