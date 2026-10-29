// Visual capture entry for retained last-good usage bars across failed fetches
// (docket `usage-bars-keep-the-last-good-reading-when-a-usa`).
// Mounts the real `UsageModal` from `../src/App` inside a muted, off-screen
// Session 0 Electron window (`tools/rig/usage-retained-visual.mjs`), bundling
// renderer sources from `--base` (`before.png`) and worktree tip (`after.png`).
import '../src/styles.css'
import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { UsageModal } from '../src/App'
import { legacyAppBackend } from './appfeed-fixture'
import type {
  AccountRegistryPayload, AccountUsage, RegisteredAccountUsage, UsagePayload,
} from '../src/types'

declare global {
  interface Window {
    __usageRetainedSettled?: boolean
  }
}

const now = Date.now()
const min = 60_000
const hr = 3600_000
const day = 86400_000

const HOST_CLAUDE: UsagePayload = {
  available: false,
  plan: 'Max',
  email: 'claude@example.test',
  observed_at: new Date(now - 8 * min).toISOString(),
  error: 'usage updates paused; next retry in 120 s',
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 38,
      severity: 'normal',
      resets_at: new Date(now + 2 * hr).toISOString(),
      is_active: false,
      model: null,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 61,
      severity: 'normal',
      resets_at: new Date(now + 4 * day).toISOString(),
      is_active: false,
      model: null,
    },
  ],
}

const CLAUDE_5: RegisteredAccountUsage = {
  account: 'claude-5',
  provider: 'claude',
  label: 'claude-5',
  available: false,
  plan: 'Max',
  observed_at: new Date(now - 25 * min).toISOString(),
  error: 'usage updates paused; next retry in 180 s',
  standing: { auth: 'authenticated', state: 'ready', marks: {} },
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 84,
      severity: 'warning',
      resets_at: new Date(now - 10 * min).toISOString(),
      is_active: false,
      model: null,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 52,
      severity: 'normal',
      resets_at: new Date(now + 3 * day).toISOString(),
      is_active: false,
      model: null,
    },
  ],
}

const CODEX_GOOD: AccountUsage = {
  account: 'codex',
  provider: 'Codex',
  label: 'codex@example.test',
  available: true,
  plan: 'Pro',
  observed_at: new Date(now - 6 * min).toISOString(),
  credits: { balance: 12500, unit: 'credits', unlimited: false },
  limits: [
    {
      kind: 'weekly_all',
      group: 'codex',
      percent: 19,
      severity: 'normal',
      resets_at: new Date(now + 6 * day).toISOString(),
      is_active: false,
      model: null,
      label: '7 days',
    },
  ],
}

const CODEX_FAILED: AccountUsage = {
  account: 'codex',
  provider: 'Codex',
  label: 'codex@example.test',
  available: false,
  plan: 'Pro',
  error: 'HTTPS 503 Service Unavailable',
  limits: [],
}

const AGY_GOOD: AccountUsage = {
  account: 'antigravity',
  provider: 'Antigravity',
  label: 'agy@example.test',
  available: true,
  tier: 'Google AI Pro',
  observed_at: new Date(now - 12 * min).toISOString(),
  limits: [
    {
      kind: 'session',
      group: 'gemini-5h',
      percent: 41,
      severity: 'normal',
      resets_at: new Date(now + 3 * hr).toISOString(),
      is_active: false,
      model: 'Gemini Models',
      label: 'Gemini Models · Five Hour',
    },
    {
      kind: 'weekly_scoped',
      group: '3p-weekly',
      percent: 72,
      severity: 'normal',
      resets_at: new Date(now + 5 * day).toISOString(),
      is_active: false,
      model: 'Claude and GPT models',
      label: 'Claude and GPT models · Weekly',
    },
  ],
}

const AGY_FAILED: AccountUsage = {
  account: 'antigravity',
  provider: 'Antigravity',
  label: 'agy@example.test',
  available: false,
  tier: 'Google AI Pro',
  error: 'Antigravity usage is not available right now',
  limits: [],
}

const REGISTRY: AccountRegistryPayload = {
  primary: 'claude-1',
  accounts: [
    {
      id: 'claude-1',
      provider: 'claude',
      harness: 'claude-code',
      label: 'claude (machine login)',
      credential: { kind: 'imported', path: 'C:/Users/x/.claude', default_config: true },
      identity: { email: 'claude@example.test' },
      auth: 'authenticated',
      tint_ordinal: 1,
      ambient: true,
      standing: { auth: 'authenticated', state: 'ready', marks: {} },
      bound: [],
    },
    {
      id: 'claude-5',
      provider: 'claude',
      harness: 'claude-code',
      label: 'claude-5',
      credential: { kind: 'managed', path: 'C:/data/profiles/claude-5' },
      identity: { email: 'secondary@example.test' },
      auth: 'authenticated',
      tint_ordinal: 2,
      ambient: false,
      standing: { auth: 'authenticated', state: 'ready', marks: {} },
      bound: [],
    },
  ],
}

const PROVIDERS = {
  providers: [
    { id: 'claude', hire_enabled: true, status: { installed: true } },
    { id: 'openai', hire_enabled: true, status: { installed: true } },
    { id: 'google', hire_enabled: true, status: { installed: true } },
  ],
}

let codexCalls = 0
let agyCalls = 0

globalThis.fetch = legacyAppBackend(((input: RequestInfo | URL) => {
  const url = new URL(String(input), 'http://localhost')
  const pathname = url.pathname
  let body: unknown = {}
  if (pathname === '/api/usage') body = HOST_CLAUDE
  else if (pathname === '/api/accounts/claude-5/usage') body = CLAUDE_5
  else if (pathname === '/api/codex/usage') {
    codexCalls += 1
    body = codexCalls === 1 ? CODEX_GOOD : CODEX_FAILED
  } else if (pathname === '/api/antigravity/usage') {
    agyCalls += 1
    body = agyCalls === 1 ? AGY_GOOD : AGY_FAILED
  } else if (pathname === '/api/providers') body = PROVIDERS
  else if (pathname === '/api/accounts') body = REGISTRY
  else if (pathname === '/api/openrouter/keys/usage') body = {}
  else if (pathname === '/api/langservers') body = { servers: [] }
  else if (pathname === '/api/muse/usage') body = { available: false, limits: [] }
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}) as typeof fetch)

function UsageRetainedCapture() {
  useEffect(() => {
    let cancelled = false
    const poll = () => {
      if (cancelled) return
      const cards = document.querySelectorAll('.usage-acct')
      const codexBtn = document.querySelector<HTMLButtonElement>('[aria-label="refresh Codex usage"]')
      const agyBtn = document.querySelector<HTMLButtonElement>('[aria-label="refresh Antigravity usage"]')
      if (cards.length === 4 && codexBtn && agyBtn && codexCalls === 1 && agyCalls === 1) {
        codexBtn.click()
        agyBtn.click()
        setTimeout(() => {
          if (!cancelled) window.__usageRetainedSettled = true
        }, 120)
        return
      }
      setTimeout(poll, 40)
    }
    setTimeout(poll, 40)
    return () => { cancelled = true }
  }, [])

  return (
    <div style={{ width: '1000px', minHeight: '720px', background: 'var(--bg, #0d1017)', padding: '8px' }}>
      <style>{`
        .overlay { position: static !important; inset: auto !important; background: transparent !important; padding: 0 !important; display: block !important; }
        .settings.usage-modal { max-height: none !important; width: 960px !important; max-width: 960px !important; margin: 0 auto !important; }
      `}</style>
      <UsageModal close={() => {}} toast={() => {}} />
    </div>
  )
}

const host = document.getElementById('root')!
createRoot(host).render(<UsageRetainedCapture />)
