// setrows.dump.tsx — STEP 1 of the settings-layout probe (D-222).
//
// Renders the REAL <AccountsPanel/> and <SettingsPanel/> under the repo's
// jsdom harness and writes their outerHTML to a file. It asserts nothing
// about layout, deliberately: jsdom implements no CSS box model, so every
// getBoundingClientRect() it reports is zero, and a layout assertion here
// would abstain — which reads exactly like a pass. Step 2
// (`settings_layout_probe.py`) loads this markup plus the real
// `src/styles.css` into Edge and measures there.
//
// What this step guarantees is that the markup measured downstream is the
// components' OWN output — class names, nesting, hint placement and all —
// rather than a hand-copied approximation that could drift silently. The
// alignment claim is only worth something if the thing measured is the thing
// that ships.
//
//     node tests/setrows_dump.mjs <out.html> [--org]

import '../tests/harness'
import { writeFileSync } from 'node:fs'
import { createElement } from 'react'
import type {
  AccountsPayload, OpenRouterDoc, ProvidersPayload, ProviderTier, TreePayload,
} from '../src/types'

const PAYLOAD: AccountsPayload = {
  version: 2,
  primary: { signed_in: true, email: 'neoja.dev@gmail.com' },
  keys: [
    { id: 'k1', ordinal: 1,
      account_uuid: '2d37ed7a-ff4b-4fa5-93da-54b828225866' },
    { id: 'k2', ordinal: 2, account_uuid: null },
  ],
  assignments: {
    haiku: { account: 'primary', available: true, refresh_at: null },
    sonnet: { account: 'primary', available: true, refresh_at: null },
    opus: { account: 'k1', available: true, refresh_at: null },
    fable: { account: 'k1', available: false, refresh_at: null },
  },
} as unknown as AccountsPayload

// the OpenRouter favorites (see the OPENROUTER fixture below) — declared
// first because the providers payload carries them too
const ORR_TIERS: ProviderTier[] = [
  { tier: 'or-anthropic-claude-sonnet-5', provider: 'openrouter', seat: 2,
    model: 'anthropic/claude-sonnet-5', letter: 'C', color: '#f9907f',
    name: 'Claude Sonnet 5', label: 'claude-sonnet-5', vendor: 'anthropic',
    prompt: 2, completion: 10, context: 1000000 },
  { tier: 'or-openai-gpt-5-6-luna', provider: 'openrouter', seat: 1,
    model: 'openai/gpt-5.6-luna', letter: 'G', color: '#9fe3d1',
    name: 'GPT-5.6 Luna', label: 'gpt-5.6-luna', vendor: 'openai',
    prompt: 0.2, completion: 1.2, context: 1050000 },
]

// Codex is installed but NOT hire-enabled, so its head renders the PREVIEW
// tag beside the switch — the pair whose placement the probe checks.
const PROVIDERS: ProvidersPayload = { providers: [
  { id: 'claude', label: 'Claude', cli: 'Claude Code', tiers: [],
    status: { installed: true, connected: true, source: 'path',
      version: '2.1.4' },
    hire_enabled: true, user_enabled: true, reason: null },
  { id: 'openai', label: 'Codex', cli: 'Codex CLI',
    tiers: [{ tier: 'sonnet', letter: 'C', seat: 1, model: 'gpt-5.6' }],
    status: { installed: true, connected: true, source: 'path',
      version: '0.9.1', email: 'neoja.dev@gmail.com', kind: 'oauth' },
    hire_enabled: false, user_enabled: true,
    reason: 'hiring stays off until the provider adapter lands' },
  { id: 'google', label: 'Antigravity', cli: 'Antigravity CLI', tiers: [],
    status: { installed: true, connected: false, source: 'path',
      version: '0.4.0' },
    hire_enabled: false, user_enabled: false,
    reason: 'turned off in App settings → Providers' },
  { id: 'openrouter', label: 'OpenRouter', cli: 'REST API (via Claude Code)',
    tiers: orrTiers(), status: { installed: !orrEmpty(), connected: !orrEmpty(),
      key_set: !orrEmpty() },
    hire_enabled: orrTiers().length > 0, user_enabled: true,
    reason: orrEmpty() ? 'no API key — add one in App settings → Providers'
      : orrTiers().length ? null
        : 'no hireable models yet — pick favorites in App settings → Providers' },
] } as unknown as ProvidersPayload

// OpenRouter (2026-09-03). Default: a CONNECTED key with a credit standing
// and two favorites — the state in which the key row carries its standing
// text AND its buttons, which is the combination that overlapped on
// 2026-09-02 (the text buttons wore the 27px icon-button class). Two flags
// pick the other states the section renders:
//   --orr-nofavs   key set, no favorites yet (the user's 2026-09-02 screenshot)
//   --orr-empty    no key: the entry row
function orrEmpty(): boolean { return process.argv.includes('--orr-empty') }
function orrTiers(): ProviderTier[] {
  return orrEmpty() || process.argv.includes('--orr-nofavs') ? [] : ORR_TIERS
}
const OPENROUTER: OpenRouterDoc = {
  installed: !orrEmpty(), connected: !orrEmpty(), key_set: !orrEmpty(),
  kind: orrEmpty() ? null : 'api-key',
  // what openrouter.ai names a key that was never given a label: its own
  // masked form — the longest standing line the row has to hold
  label: orrEmpty() ? null : 'sk-or-v1-d3e…22c',
  credits: { limit: null, limit_remaining: null, usage: 0.16,
    usage_daily: 0.16, usage_weekly: 0.16, usage_monthly: 0.16,
    is_free_tier: true, checked_at: '2026-09-02T23:20:00Z' },
  reason: orrEmpty() ? 'no API key — add one in App settings → Providers' : null,
  favorites: orrTiers().length, favorites_max: 0, tiers: orrTiers(),
  user_enabled: true,
}

const ORG: TreePayload = {
  slug: 'acme', name: 'Acme Corporation', nodes: [], edges: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0.8,
  default_effort: '', cascade_hire: true, cascade_alloc: true,
  fable_limit_policy: 'halt', fable_filter_policy: 'halt',
  auto_cheap_compact: { enabled: true, occ: 0.5 },
  auto_resume_compact: false,
  kiosk: null, sandboxed: false, disk: null, net: { hubs: [] },
} as unknown as TreePayload

const g = globalThis as unknown as Record<string, unknown>
g.fetch = (url: string) => {
  const path = new URL(String(url), 'http://localhost').pathname
  const body = path === '/api/accounts' ? PAYLOAD
    : path === '/api/providers' ? PROVIDERS
    : path === '/api/openrouter' ? OPENROUTER
      : path === '/api/app-settings/runtime'
        ? { warming_enabled: true, working_checkups_enabled: true,
            wait_for_mcp_tools_enabled: false }
        : path.includes('/orgmd') ? { content: '# Acme\n\nHouse rules.\n' }
          : path.includes('/net') ? { hubs: [], identity: null } : {}
  return Promise.resolve({
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve(body),
  })
}

const main = async () => {
  const org = process.argv.includes('--org')
  const { mountView, flush } = await import('../tests/harness')
  const { act } = await import('react')
  const node = org
    ? createElement((await import('../src/App')).SettingsPanel,
      { tree: ORG, toast: () => {}, close: () => {} })
    : createElement((await import('../src/canvas/accounts')).AccountsPanel,
      { toast: () => {}, close: () => {} })
  const view = await mountView(node, (el: HTMLElement) => el.innerHTML)
  await act(async () => { await flush(10) })

  // VISIT EVERY TAB. The panels are `hidden`, not unmounted, so one dump
  // carries all of them — but a tab whose body is gated on `visited` renders
  // nothing until it has been shown once, and dumping that would hand the
  // probe an empty panel to declare aligned.
  const tabs = [...view.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  for (const t of tabs) await act(async () => { t.click(); await flush(6) })
  if (tabs[0]) await act(async () => { tabs[0]!.click(); await flush(6) })

  // `--orr-replacing`: press the OpenRouter key row's replace button first,
  // so the dump carries the entry row in its widest form (field · ✓ · ✕)
  if (process.argv.includes('--orr-replacing')) {
    const btn = view.el.querySelector<HTMLButtonElement>(
      '.orr-keyrow button[title^="replace the key"]')
    if (!btn) throw new Error('no OpenRouter replace button to press')
    await act(async () => { btn.click(); await flush(6) })
    if (!view.el.querySelector('button[title="keep the current key"]')) {
      throw new Error('the replacing row did not render — dump would be a lie')
    }
  }

  const html = view.last()

  // ⚠ FAIL LOUD IF THE PANEL NEVER GOT ITS DATA — otherwise the dump is a
  // "reading accounts…" placeholder with no rows in it, and the probe
  // downstream cheerfully reports "0 misaligned rows".
  const rows = (html.match(/class="set-row/g) ?? []).length
  const want = org ? 5 : 4
  if (rows < want) {
    throw new Error(`dump is not the loaded panel: ${rows} .set-row (want `
      + `>= ${want}). First 400 chars:\n${html.slice(0, 400)}`)
  }
  if (!org && !html.includes('acct-preview-tag')) {
    throw new Error('no preview tag in the dump — the head-cluster check '
      + 'downstream would prove nothing')
  }
  const dest = process.argv.slice(2).find((a) => !a.startsWith('--'))
  if (!dest) throw new Error('usage: setrows.dump <out.html> [--org]')
  writeFileSync(dest, html)
  console.log(`dumped ${html.length} bytes, ${rows} rows, ${tabs.length} tabs`)
}

await main()
// jsdom's window and the panels' timers hold the event loop open; this is a
// one-shot dump, so leave rather than wait for them
process.exit(0)
