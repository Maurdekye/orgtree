// Synthetic availability fixture; no engine, credentials or provider access.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LanguageServerSection } from '../src/canvas/langserver'
import { OrgAccountsTab } from '../src/orgaccounts'
import { PinFrame } from '../src/canvas/modalpin'
import { applyTheme } from '../src/themes'

const servers = ['First server', 'Second server'].map((label, i) => ({
  id: `server-${i}`, preset: 'custom', label, address: 'http://models.example.test',
  harness: 'codex-cli', api: 'openai', base_path: '/v1', base_url: 'http://models.example.test/v1',
  max_agents: 2, seat: 1, enabled: i === 0, key_set: true, created_at: '', models: {},
}))
let denied = ['langserver:server-1']
const doc = () => ({ servers, presets: [], default_seat: 1, max_seat: 100,
  min_context: 65536, default_context: 65536, user_enabled: true })
window.fetch = async (url, init) => {
  const path = new URL(String(url), location.href).pathname
  let body: unknown
  if (path === '/api/app/records') body = { records: [], cursor: '0' }
  else if (path.endsWith('/accounts-allowed')) body = { accounts: servers.map(s => ({
    id: `langserver:${s.id}`, label: s.label, provider: 'langserver', enabled: s.enabled,
    allowed: !denied.includes(`langserver:${s.id}`),
    disabled_reason: s.enabled ? null : 'turned off in App settings > Providers',
  })) }
  else if (path.endsWith('/settings') && init?.method === 'POST') {
    denied = JSON.parse(String(init.body)).disabled_accounts
    body = { warnings: [] }
  } else {
    const server = servers.find(s => path === `/api/langservers/${s.id}`)
    if (server && init?.method === 'PATCH') server.enabled = JSON.parse(String(init.body)).enabled
    body = server && init?.method === 'PATCH' ? { server, doc: doc() } : doc()
  }
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}
applyTheme('orgtree')
function Probe() {
  const [org, setOrg] = useState(false)
  return <PinFrame kind="app-settings" title="Settings" panel="settings acct-panel" pinnable={false} close={() => {}}>
    <h3>{org ? 'Org Settings' : 'Providers'}</h3>
    <button onClick={() => setOrg(!org)}>{org ? 'Show Providers' : 'Show Org Settings'}</button>
    {org ? <OrgAccountsTab slug="fixture" toast={() => {}} />
      : <LanguageServerSection provider={undefined} toast={() => {}} />}
  </PinFrame>
}
createRoot(document.getElementById('root')!).render(<Probe />)
