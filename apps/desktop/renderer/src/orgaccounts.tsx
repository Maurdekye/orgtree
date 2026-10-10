// Org settings › Accounts (docket per-org-account-allowlist-restrict-an-org-to-a-s,
// user 2026-10-10): one checkbox per signed-in account — the default sign-ins,
// registered logins, OpenRouter, each language server — and the org's agents
// only ever run on the ticked ones. Everything is ticked by default, and a
// newly signed-in account starts ticked (the org stores what it switched OFF).
// The engine enforces it everywhere it picks an account; this only edits the
// list. Saves at once, like Autonomy: a refusal is instant feedback.
import { useCallback, useEffect, useState } from 'react'
import { getOrgAccounts, saveSettings } from './api'
import type { OrgAccountLane } from './types'
import { SetToggle } from './canvas/settingskit'

type ToastFn = (lines: string[]) => void

const PROVIDERS: [string, string][] = [
  ['claude', 'Claude'], ['openai', 'Codex'], ['google', 'Antigravity'],
  ['openrouter', 'OpenRouter'], ['langserver', 'Language servers'],
]

export function OrgAccountsTab({ slug, toast }: { slug: string; toast: ToastFn }) {
  const [lanes, setLanes] = useState<OrgAccountLane[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => getOrgAccounts(slug)
    .then((r) => { setLanes(r.accounts); setError(null) })
    .catch((e: Error) => setError(e.message)), [slug])
  useEffect(() => { void load() }, [load])

  const set = (id: string, allowed: boolean) => {
    if (!lanes) return
    const next = lanes.map((l) => (l.id === id ? { ...l, allowed } : l))
    setBusy(true)
    saveSettings(slug, { disabled_accounts: next.filter((l) => !l.allowed).map((l) => l.id) })
      .then((r) => {
        setLanes(next)
        toast(r.warnings?.length ? r.warnings : [`${id} ${allowed ? 'is used by this org again' : 'is no longer used by this org'}`])
      })
      .catch((e: Error) => toast([`error: ${e.message}`]))
      .finally(() => { setBusy(false); void load() })
  }

  if (error) return <div className="uh-error">accounts unavailable: {error}</div>
  if (!lanes) return <div className="dim">loading…</div>
  return (
    <div className="org-accounts">
      <div className="dim hub-hint">
        This org's agents only ever run on the ticked accounts: hires, account changes, the automatic account
        fallback and the balancing never pick an unticked one. An agent already on an account you untick finishes its
        turn, then moves to another ticked account of the same provider, or stops and says so when none is left. A
        newly signed-in account starts ticked.
      </div>
      {PROVIDERS.map(([p, name]) => {
        const group = lanes.filter((l) => l.provider === p)
        if (!group.length) return null
        return (
          <div key={p} className="org-accounts-group">
            <div className="field-label">{name}</div>
            {group.map((l) => (
              <SetToggle key={l.id} label={l.label} checked={l.allowed} disabled={busy}
                hint={l.label === l.id ? undefined : l.id}
                onChange={(next) => set(l.id, next)} />
            ))}
          </div>
        )
      })}
    </div>
  )
}
