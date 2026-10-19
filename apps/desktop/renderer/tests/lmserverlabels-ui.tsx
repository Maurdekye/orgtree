import { createRoot } from 'react-dom/client'
import { LanguageServerSection } from '../src/canvas/langserver'
import '../src/styles.css'
import '../src/shell.css'

const doc = { servers: [{ id: 'llamacpp', label: 'llama.cpp', preset: 'llamacpp',
  address: 'http://127.0.0.1:9931', base_url: 'http://127.0.0.1:9931', base_path: '',
  harness: 'codex-cli', api: 'responses', max_agents: 1, seat: 1, enabled: true, key_set: false,
  models: { qwen: { id: 'qwen', tier: 'ls-llamacpp-qwen', label: 'Qwen', offered: true,
    context: 65536, context_in_use: 65536, too_small: false } } }],
  presets: [{ id: 'llamacpp', label: 'llama.cpp', address: 'http://127.0.0.1:9931',
    harnesses: [{ id: 'codex-cli', label: 'Codex', available: true, installed: true, why: '' }], note: '' }],
  default_seat: 1, max_seat: 100, min_context: 65536, default_context: 65536, user_enabled: true }
globalThis.fetch = async () => new Response(JSON.stringify(doc), { headers: { 'Content-Type': 'application/json' } })
document.documentElement.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<div className="settings" style={{ padding: 24, width: 930 }}>
  <h3>App settings</h3><div className="field-label">Providers</div>
  <LanguageServerSection provider={undefined} toast={() => {}} />
</div>)
