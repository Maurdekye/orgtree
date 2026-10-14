// Org settings › Accounts (docket per-org-account-allowlist-restrict-an-org-to-a-s,
// user 2026-10-10): one checkbox per signed-in account — the default sign-ins,
// registered logins, OpenRouter, each language server — and the org's agents
// only ever run on the ticked ones. Everything is ticked by default, and a
// newly signed-in account starts ticked (the org stores what it switched OFF).
// The engine enforces it everywhere it picks an account; this only edits the
// list. Saves at once, like Autonomy: a refusal is instant feedback.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getOrgAccounts, saveSettings } from './api'
import { useAppValue } from './appfeed'
import type { OrgAccountLane } from './types'
import { SetToggle } from './canvas/settingskit'

type ToastFn = (lines: string[]) => void

const PROVIDERS: [string, string][] = [
  ['claude', 'Claude'], ['openai', 'Codex'], ['google', 'Antigravity'],
  ['muse', 'Muse'],
  ['openrouter', 'OpenRouter'], ['langserver', 'Language servers'],
]

export function OrgAccountsTab({ slug, toast }: { slug: string; toast: ToastFn }) {
  const providers = useAppValue('providers')
  const [lanes, setLanes] = useState<OrgAccountLane[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const saving = useRef(false)
  const load = useCallback(() => {
    // The save's final refresh observes provider changes received while it ran.
    if (saving.current) return Promise.resolve()
    const request = ++generation.current
    return getOrgAccounts(slug)
      .then((r) => { if (request === generation.current) { setLanes(r.accounts); setError(null) } })
      .catch((e: Error) => { if (request === generation.current) setError(e.message) })
  }, [slug])
  useEffect(() => {
    setLanes(null); setError(null); setBusy(false)
    return () => { ++generation.current; saving.current = false }
  }, [slug])
  useEffect(() => { void load() }, [load, providers])

  const set = (id: string, allowed: boolean) => {
    if (!lanes || saving.current) return
    const lane = lanes.find(l => l.id === id)
    if (!lane || (allowed && lane.enabled === false)) return
    const next = lanes.map((l) => (l.id === id ? { ...l, allowed } : l))
    const request = ++generation.current // Retire every read started before this save.
    saving.current = true
    setBusy(true)
    saveSettings(slug, { disabled_accounts: next.filter((l) => !l.allowed).map((l) => l.id) })
      .then((r) => {
        if (request !== generation.current) return
        setLanes(next)
        toast(r.warnings?.length ? r.warnings : [`${id} ${allowed ? 'is used by this org again' : 'is no longer used by this org'}`])
      })
      .catch((e: Error) => { if (request === generation.current) toast([`error: ${e.message}`]) })
      .finally(() => {
        if (request !== generation.current) return
        saving.current = false; setBusy(false); void load()
      })
  }

  if (error) return <div className="uh-error">accounts unavailable: {error}</div>
  if (!lanes) return <div className="dim">loading…</div>
  return (
    <div className="org-accounts">
      <div className="dim hub-hint">
        This org's agents use only ticked accounts. Unticking takes effect after any running turn:
        agents move to another ticked account of the same provider when possible, or stop.
        New accounts start ticked.
      </div>
      {PROVIDERS.map(([p, name]) => {
        const group = lanes.filter((l) => l.provider === p)
        if (!group.length) return null
        return (
          <div key={p} className="org-accounts-group">
            <div className="field-label">{name}</div>
            {group.map((l) => (
              <SetToggle key={l.id} label={l.label} checked={l.allowed}
                disabled={busy || (!l.allowed && l.enabled === false)}
                hint={<>{l.label === l.id ? null : l.id}
                  {l.enabled === false && <>{l.label === l.id ? '' : ' · '}
                    {l.disabled_reason || 'turned off in App settings › Providers'}.
                    {' '}Enable it in Providers before allowing it here.</>}
                </>}
                onChange={(next) => set(l.id, next)} />
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** The Usage panels opened from an org window show only that org's allowed
 *  accounts: no toggle, no greyed rows (user ruling 2026-10-10 14:56Z). Home
 *  (no org) shows every account. Lanes are the board's names. */
export function useOrgLaneFilter(org: string | null | undefined) {
  const [off, setOff] = useState<Set<string> | null>(null)
  useEffect(() => {
    if (!org) { setOff(null); return }
    let live = true
    getOrgAccounts(org)
      .then((r) => { if (live) setOff(new Set(r.accounts.filter((l) => !l.allowed).map((l) => l.id))) })
      .catch(() => { if (live) setOff(null) })
    return () => { live = false }
  }, [org])
  return { used: (lane: string): boolean => !off?.has(lane) }
}
