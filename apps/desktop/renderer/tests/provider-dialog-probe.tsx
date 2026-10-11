// Isolated visual fixture: real provider components, synthetic responses only.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { OpenRouterSection } from '../src/canvas/openrouter'
import { LanguageServerSection } from '../src/canvas/langserver'
import { PinFrame } from '../src/canvas/modalpin'
import { applyTheme } from '../src/themes'

let keySet = false
const server = { id: 'fixture', preset: 'custom', label: 'Example models', address: 'http://models.example.test',
  harness: 'codex-cli', api: 'openai', base_path: '/v1', base_url: 'http://models.example.test/v1',
  max_agents: 2, seat: 1, enabled: true, key_set: true, created_at: '', models: {} }
const doc = { servers: [server], presets: [
  { id: 'ollama', label: 'Ollama', address: 'http://127.0.0.1:11434',
    harnesses: [{ id: 'codex-cli', label: 'Codex', available: true, why: '' }] },
  { id: 'custom', label: 'Custom', address: 'http://models.example.test',
    harnesses: [{ id: 'codex-cli', label: 'Codex', available: true, why: '' }] },
], default_seat: 1, max_seat: 100, min_context: 65536, default_context: 65536, user_enabled: true }
window.fetch = async (url, init) => {
  const path = new URL(String(url), location.href).pathname
  if (path === '/api/openrouter/key' && init?.method === 'PUT') keySet = true
  const body = path.startsWith('/api/openrouter')
    ? { key_set: keySet, connected: keySet, label: 'Example key', tiers: [], favorites: 0, favorites_max: 0, user_enabled: true }
    : path === '/api/langservers/probe'
      ? { reachable: true, models: [{ id: 'example-model', max_context: 65536, tools: true }] }
      : doc
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}
applyTheme('orgtree')
function Probe() {
  const [pickerOpen, setPickerOpen] = useState(false)
  return <PinFrame kind="app-settings" title="App settings" panel="settings acct-panel" pinnable={false} close={() => {}}>
    <h3>App settings</h3><h4>Providers</h4>
    <OpenRouterSection provider={undefined} toast={() => {}} pickerOpen={pickerOpen} setPickerOpen={setPickerOpen} />
    <LanguageServerSection provider={undefined} toast={() => {}} />
  </PinFrame>
}
createRoot(document.getElementById('root')!).render(<Probe />)
