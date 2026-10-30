// tests/serverharness.visual.tsx — what serverharness.capture.cjs draws for
// @item:orgtree/language-model-server-entries-harness-can-be-edi: the
// Language model servers section and its Configure dialog before and after a
// harness change (for an Ollama preset server and a custom server changing API
// family). No engine: the fixture answers GET/PATCH /api/langservers and
// POST /api/langservers/probe in memory. The same file draws base and tip.
import '../src/styles.css'
import '../src/shell.css'
import { createRoot } from 'react-dom/client'
import { LanguageServerSection } from '../src/canvas/langserver'
import type { LangServer, LangServerDoc, LangServerProbeModel, ProviderInfo } from '../src/types'

const LATEST = 'qwen3.6-35b-a3b:latest'
const V64 = 'qwen3.6-35b-a3b:latest-64k'

const OFFERED: LangServerProbeModel[] = [
  { id: LATEST, size: 13.2e9, max_context: 262144, family: 'qwen35moe', parameters: '34.7B', quantization: 'IQ3_XXS',
    tools: true, capabilities: ['completion', 'tools', 'thinking'], configured_context: 65536 },
  { id: V64, size: 13.2e9, max_context: 262144, family: 'qwen35moe', parameters: '34.7B', quantization: 'IQ3_XXS',
    tools: true, capabilities: ['completion', 'tools', 'thinking'], configured_context: 65536 },
]

const stored = (id: string) => ({ id, tier: `ls-ollama-${id}`, label: id, offered: true, context: 65536,
  context_in_use: 65536, too_small: false })

type Scene = 'ollama' | 'custom'
let currentScene: Scene = 'ollama'
let currentServer: LangServer
const patches: { path: string; body: Record<string, unknown> }[] = []
const toasts: string[][] = []

function makeServer(scene: Scene): LangServer {
  if (scene === 'custom') {
    return {
      id: 'custom', preset: 'custom', label: 'Custom gateway', address: 'https://models.example.net',
      harness: 'claude-code', api: 'anthropic', base_path: 'api/anthropic',
      base_url: 'https://models.example.net/api/anthropic', max_agents: 2, seat: 1, enabled: true,
      key_set: true, following_seats: 1, pinned_seats: 2, pinned_harnesses: { 'claude-code': 2 },
      created_at: '2026-10-10T08:00:00Z',
      models: Object.fromEntries([LATEST, V64].map((id) => [id, stored(id)])),
    }
  }
  return {
    id: 'ollama', preset: 'ollama', label: 'Ollama', address: 'http://127.0.0.1:11434',
    harness: 'claude-code', api: 'anthropic', base_path: '',
    base_url: 'http://127.0.0.1:11434', max_agents: 1, seat: 1, enabled: true,
    key_set: false, following_seats: 3, pinned_seats: 2, pinned_harnesses: { opencode: 2 },
    created_at: '2026-10-10T08:00:00Z',
    models: Object.fromEntries([LATEST, V64].map((id) => [id, stored(id)])),
  }
}

currentServer = makeServer('ollama')

function makeDoc(): LangServerDoc {
  const ollamaHarnesses = [
    { id: 'claude-code', label: 'Claude Code', available: true, installed: true, why: '' },
    { id: 'codex-cli', label: 'Codex', available: true, installed: true, why: '' },
    { id: 'opencode', label: 'OpenCode (ACP)', available: false, installed: false, why: 'OpenCode (ACP) is not installed on this machine' },
  ]
  const customHarnesses = [
    { id: 'claude-code', label: 'Claude Code', available: true, installed: true, why: '' },
    { id: 'codex-cli', label: 'Codex', available: true, installed: true, why: '' },
    { id: 'opencode', label: 'OpenCode (ACP)', available: true, installed: true, why: '' },
  ]
  return {
    servers: [currentServer],
    presets: [
      { id: 'ollama', label: 'Ollama', address: 'http://127.0.0.1:11434', claude: true, codex: true,
        harnesses: ollamaHarnesses, note: 'Ollama 0.14 or later serves both harnesses.' },
      { id: 'custom', label: 'Custom…', address: '', claude: true, codex: true,
        harnesses: customHarnesses, note: 'Any server with an Anthropic-compatible Messages API or OpenAI-compatible API.' },
    ] as unknown as LangServerDoc['presets'],
    default_seat: 1, max_seat: 100, min_context: 65536, default_context: 65536, user_enabled: true,
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

window.fetch = ((raw: RequestInfo | URL, init?: RequestInit) => {
  const u = new URL(String(raw), 'http://local')
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
  if (u.pathname === '/api/langservers' && method === 'GET') {
    return Promise.resolve(json(makeDoc()))
  }
  if (u.pathname === '/api/langservers/probe' && method === 'POST') {
    return Promise.resolve(json({ reachable: true, version: '0.40.2', listed: 2, models: OFFERED }))
  }
  if (u.pathname.startsWith('/api/langservers/') && method === 'PATCH' && body) {
    patches.push({ path: u.pathname, body })
    if (typeof body.harness === 'string') {
      currentServer = {
        ...currentServer,
        harness: body.harness as LangServer['harness'],
        api: body.harness === 'codex-cli' ? 'responses' : body.harness === 'opencode' ? 'chat_completions' : 'anthropic',
      }
    }
    if (typeof body.base_path === 'string') {
      currentServer = { ...currentServer, base_path: body.base_path }
    }
    currentServer = {
      ...currentServer,
      base_url: currentServer.preset === 'custom'
        ? (currentServer.base_path ? `${currentServer.address}/${currentServer.base_path}` : currentServer.address)
        : (currentServer.harness === 'claude-code' ? currentServer.address : `${currentServer.address}/v1`),
    }
    return Promise.resolve(json({ server: currentServer, doc: makeDoc(), repriced: [] }))
  }
  return Promise.resolve(json({}))
}) as typeof fetch

const PROVIDER: ProviderInfo = {
  id: 'langserver', label: 'Language model servers', cli: 'Local HTTP', tiers: [],
  status: { installed: true, connected: true }, hire_enabled: true, user_enabled: true, reason: null,
}

const root = createRoot(document.getElementById('root')!)
let seq = 0

Object.assign(window, { serverHarnessFixture: {
  patches,
  toasts,
  show: (scene: Scene) => {
    localStorage.setItem('orgtree-contrast-theme', 'charcoal')
    document.documentElement.classList.remove('contrast-light')
    currentScene = scene
    currentServer = makeServer(scene)
    patches.length = 0
    toasts.length = 0
    root.render(
      <div style={{ padding: 24, maxWidth: 820 }}>
        <LanguageServerSection key={`${currentScene}-${++seq}`} provider={PROVIDER} toast={(l) => toasts.push(l)} />
      </div>,
    )
  },
} })
