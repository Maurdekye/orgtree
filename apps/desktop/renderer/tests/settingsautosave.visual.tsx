import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsPanel, DefaultsPanel } from '../src/App'
import { AccountsPanel } from '../src/canvas/accounts'
import { ProjectDraftNode } from '../src/canvas/newproject'
import { CurrentOrg } from '../src/popout'
import type { TreePayload } from '../src/types'

// Real settings surfaces against an in-memory fixture. No engine/native bridge.
const writes: { path: string; method: string; body: Record<string, unknown> }[] = []
let defaults = { max_top_grant: 1000, default_top_grant: 50, compact_at: .8, auto_resume: true }
const tree = { slug: 'settings-capture', name: 'Synthetic settings', roots: [], nodes: [], edges: [], dirs: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: .8, default_visibility: 'team',
  default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
  auto_cheap_compact: { enabled: true, occ: .25 }, tiers: {}, net: null } as unknown as TreePayload
window.fetch = (async (url: string, init?: RequestInit) => {
  const path = new URL(String(url), 'http://fixture').pathname, method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  if (method !== 'GET') writes.push({ path, method, body })
  if (path === '/api/defaults' && method === 'POST') defaults = { ...defaults, ...body,
    ...('compact_at' in body ? { compact_at: body.compact_at / 100 } : {}) }
  const value = path.endsWith('/orgmd') ? { content: '# Synthetic charter', rev: 'fixture-r1' }
    : path === '/api/defaults' ? defaults
    : path.endsWith('/profile-picture') ? { owner: 1, picture: null }
    : { providers: [], accounts: [], servers: [], charters: [], templates: [], nodes: [], edges: [], roots: [],
      installed: [], harnesses: [], warnings: [], working_checkups_enabled: true }
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
function Fixture() {
  const [mode, setMode] = useState('org')
  Object.assign(window, { setSettingsCapture: (next: string) => { writes.length = 0; setMode(next) },
    settingsCaptureWrites: () => writes })
  const close = () => { throw new Error('Capture must keep its settings surface open') }
  return <CurrentOrg.Provider value={tree.slug}>
    {mode === 'org' ? <SettingsPanel tree={tree} close={close} toast={() => {}} />
      : mode === 'defaults' ? <DefaultsPanel close={close} toast={() => {}} />
        : mode === 'app-defaults' ? <AccountsPanel close={close} toast={() => {}} initialTab="defaults" />
          : <ProjectDraftNode pos={{ x: 100, y: 100 }} onCancel={() => {}}
            onConfirm={() => { throw new Error('Capture must not create a project') }} />}
  </CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
