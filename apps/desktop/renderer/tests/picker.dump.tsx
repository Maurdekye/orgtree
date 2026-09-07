// picker.dump.tsx — the markup half of `picker_probe.py` (2026-09-03): the
// OpenRouter model-selection modal with SIX favorites (so the selected list
// wraps, and one label is long enough to be clipped) over a scripted catalog
// whose search page reports those favorites as `selected` — the state of the
// user's deselect bug — rendered through the real `<ModelPicker/>` with the
// same generated stylesheet the app injects. The probe wraps this in
// styles.css and measures it in Edge.
//
//   node tests/picker_dump.mjs <out.html>

import '../tests/harness'
import { writeFileSync } from 'node:fs'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ModelPicker } from '../src/canvas/openrouter'
import { openrouterTierCss } from '../src/canvas/shared'
import type { OpenRouterDoc, OpenRouterModel, ProviderTier } from '../src/types'

const CATALOG: OpenRouterModel[] = [
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', label: 'claude-sonnet-5',
    vendor: 'anthropic', prompt: 2, completion: 10, cache_read: 0.2, context: 1000000,
    tools: true, free: false, letter: 'C', color: '#f9907f', accent: null },
  { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna', label: 'gpt-5.6-luna', vendor: 'openai',
    prompt: 0.2, completion: 1.2, cache_read: 0.02, context: 1050000,
    tools: true, free: false, letter: 'G', color: '#88e7ca', accent: null },
  { id: 'x-ai/grok-4.6', name: 'Grok 4.6', label: 'grok-4.6', vendor: 'x-ai',
    prompt: 2, completion: 6, cache_read: 0.2, context: 2000000,
    tools: true, free: false, letter: 'G', color: '#0d0d0d', accent: null },
  { id: 'minimax/minimax-m3', name: 'MiniMax M3', label: 'minimax-m3', vendor: 'minimax',
    prompt: 0.4, completion: 2.2, cache_read: 0.04, context: 200000,
    tools: true, free: false, letter: 'M', color: '#152537', accent: '#ff5530' },
  { id: 'meta-llama/llama-4-maverick-17b-128e-instruct:free', name: 'Llama 4 Maverick (free)',
    label: 'llama-4-maverick-17b-128e-instruct:free', vendor: 'meta-llama',
    prompt: 0, completion: 0, cache_read: 0, context: 1048576,
    tools: true, free: true, letter: 'L', color: '#a5d9fa', accent: null },
  { id: 'deepseek/deepseek-v4', name: 'DeepSeek V4', label: 'deepseek-v4', vendor: 'deepseek',
    prompt: 0.28, completion: 0.42, cache_read: 0.028, context: 163840,
    tools: true, free: false, letter: 'D', color: '#c6cdfe', accent: null },
  { id: 'qwen/qwen4-plus', name: 'Qwen4 Plus', label: 'qwen4-plus', vendor: 'qwen',
    prompt: 0.4, completion: 1.2, cache_read: 0.04, context: 1000000,
    tools: true, free: false, letter: 'Q', color: '#cecbfb', accent: null },
  { id: 'mistralai/mistral-large', name: 'Mistral Large', label: 'mistral-large',
    vendor: 'mistralai', prompt: 2, completion: 6, cache_read: 0.2, context: 262144,
    tools: true, free: false, letter: 'M', color: '#f1995e', accent: null },
]
const FAVS = CATALOG.slice(0, 6)
const tierOf = (m: OpenRouterModel): ProviderTier => ({
  tier: 'or-' + m.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  provider: 'openrouter', seat: Math.max(1, Math.floor(m.prompt)), model: m.id,
  letter: m.letter, color: m.color, accent: m.accent, name: m.name, label: m.label,
  vendor: m.vendor, prompt: m.prompt, completion: m.completion, context: m.context,
})
const DOC: OpenRouterDoc = {
  installed: true, connected: true, key_set: true, kind: 'api-key', label: 'sk-or-v1-abc…xyz',
  credits: { limit: null, limit_remaining: null, usage: 1.25, usage_daily: 0.5,
    usage_weekly: 1.25, usage_monthly: 1.25, is_free_tier: false,
    checked_at: '2026-09-03T09:00:00Z' },
  reason: null, favorites: FAVS.length, favorites_max: 0, tiers: FAVS.map(tierOf),
  user_enabled: true,
}

// the catalog endpoint, as the backend answers it: `selected` is TRUE for
// every favorite at fetch time
;(globalThis as { fetch?: unknown }).fetch = (url: string) => {
  const u = new URL(String(url), 'http://localhost')
  if (u.pathname !== '/api/openrouter/models') return Promise.reject(new Error(`unexpected ${u.pathname}`))
  const items = CATALOG.map((m) => ({ ...m, selected: FAVS.some((f) => f.id === m.id) }))
  return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve({ query: '', offset: 0, limit: 8, total: items.length, items }) })
}

const host = document.createElement('div')
document.body.appendChild(host)
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
const root = createRoot(host)
flushSync(() => root.render(
  <ModelPicker doc={DOC} busy={false} onToggle={() => {}} onClose={() => {}} />,
))
// the page arrives asynchronously (a 0 ms debounce, then the fetch): let the
// timers and the promise chain run before the markup is read
await new Promise((r) => setTimeout(r, 60))
const html = host.innerHTML

const dest = process.argv[2]
if (!dest) {
  console.error('usage: node tests/picker_dump.mjs <out.html>')
  process.exit(2)
}
writeFileSync(dest,
  `<style id="orgtree-openrouter-tiers">\n${openrouterTierCss(DOC.tiers)}\n</style>\n${html}\n`,
  'utf-8')
console.log(`wrote ${dest} (${host.querySelectorAll('.orr-row').length} rows, `
  + `${host.querySelectorAll('.orr-sel').length} selected chips)`)
