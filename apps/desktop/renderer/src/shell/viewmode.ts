// shell/viewmode.ts — Canvas or Attention, per organization.
//
// The two org-specific views are MODES OF ONE BOUND WINDOW, not two windows
// and not two destinations: the toggle changes what the window shows about the
// organization it already belongs to. The mode is remembered per organization
// so reopening one comes back the way it was left.
//
// ⚠ THE STORAGE KEY IS AGREED WITH THE ATTENTION OWNER (`orgtree-org-view`),
// and only one module may write it. v3-attention-opus publishes an equivalent
// `useOrgViewMode` from `attention/mode.ts`; when that module lands, THIS FILE
// GOES and the header imports theirs. It exists now only so the compact header
// is not blocked on a module in another worktree, and it is deliberately the
// same key and the same contract so the swap is an import change and nothing
// else. Do not let both survive.
import { useCallback, useEffect, useState } from 'react'

export type OrgViewMode = 'canvas' | 'attention'

const KEY = 'orgtree-org-view'

const readAll = (): Record<string, OrgViewMode> => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, OrgViewMode> = {}
    for (const [k, mode] of Object.entries(v as Record<string, unknown>)) {
      if (mode === 'canvas' || mode === 'attention') out[k] = mode
    }
    return out
  } catch { return {} }
}

export const readOrgViewMode = (org: string | null): OrgViewMode =>
  (org && readAll()[org]) || 'canvas'

export function writeOrgViewMode(org: string, mode: OrgViewMode): void {
  try {
    const all = readAll()
    if (all[org] === mode) return
    all[org] = mode
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch { /* the mode still works for this session */ }
}

/** The mode for one organization. Canvas is the default and the answer for a
 *  window bound to nothing — Homepage and Create have no modes at all. */
export function useOrgViewMode(org: string | null): [OrgViewMode, (m: OrgViewMode) => void] {
  const [mode, setMode] = useState<OrgViewMode>(() => readOrgViewMode(org))
  // an organization change re-reads rather than carrying the last one's mode
  // across: the setting belongs to the organization, not to the window
  useEffect(() => { setMode(readOrgViewMode(org)) }, [org])
  const set = useCallback((next: OrgViewMode) => {
    setMode(next)
    if (org) writeOrgViewMode(org, next)
  }, [org])
  return [mode, set]
}
