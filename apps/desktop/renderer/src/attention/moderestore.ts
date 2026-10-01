// attention/moderestore.ts — RESTORE THE CANVAS/ATTENTION VIEW AT STARTUP.
//
// The view lives in this origin's localStorage, which a relaunch can lose
// (a moved engine port or a new profile). The native preferences document
// survives that, so the view is mirrored there as `attentionOrgs` (the orgs
// last left in Attention) and read back at startup.
//
// Each org has its own native record, changed one org at a time by the main
// process (a window never sends whole lists, so it cannot erase another's): listed in `attentionOrgs` (Attention)
// or in `canvasOrgs` (Canvas). An org in neither has not been recorded yet.
//
// Precedence at an org's first preferences read, startup mode 'restore':
//   org recorded natively  -> the native record wins, for BOTH views
//   org not recorded       -> older document: keep the local view and record it
// One org's record never stands in for another's (upgrade with many windows).
// Startup mode 'homepage' never restores; the live view is only recorded.
// After that first decision the live view is only mirrored, never overridden.

import { useEffect, useRef } from 'react'
import { startupMode } from '../desktop'
import type { NativePreferences } from '../desktop'
import { setOrgView } from './mode'
import type { OrgView } from './mode'

export type ModeRestorePlan =
  | { kind: 'apply'; view: OrgView }
  | { kind: 'mirror'; view: OrgView }
  | { kind: 'none' }

export function planModeRestore(
  slug: string, view: OrgView, prefs: NativePreferences, first: boolean,
): ModeRestorePlan {
  const att = prefs.attentionOrgs ?? [], can = prefs.canvasOrgs ?? []
  const saved: OrgView | null = att.includes(slug) ? 'attention' : can.includes(slug) ? 'canvas' : null
  if (first && saved && startupMode(prefs) === 'restore') {
    return saved === view ? { kind: 'none' } : { kind: 'apply', view: saved }
  }
  if (saved === view) return { kind: 'none' }
  return { kind: 'mirror', view }
}

export function useModeRestore(
  slug: string | null, view: OrgView, prefs: NativePreferences | null,
  persist: (slug: string, view: OrgView) => void,
): void {
  const first = useRef(true)
  useEffect(() => {
    if (!slug || !prefs) return
    const plan = planModeRestore(slug, view, prefs, first.current)
    first.current = false
    if (plan.kind === 'apply') setOrgView(slug, plan.view)
    else if (plan.kind === 'mirror') persist(slug, plan.view)
  }, [slug, view, prefs, persist])
}
