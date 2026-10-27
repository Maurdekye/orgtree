// canvas/apprefs.ts — what an @app: or @panel: mention names right now, and
// what clicking one does.
//
// A mention shows the app's or the panel's CURRENT name and does what its Apps
// menu row does (USER 2026-10-27 m449dc0a35cbe). The apps store holds only the
// running copies and the pages the menu has loaded, so the names come from one
// bounded engine read (`refs`) of the exact IDs on screen, batched per org, and
// are read again whenever the org's apps change: a rename, a deletion, a copy
// starting or stopping.
//
// ⚠ ONLY AN ANSWERED READ MAKES A TARGET `absent`. An ID the engine leaves out
// of its answer is gone; an ID whose read failed is still `pending`, and keeps
// whatever answer it had before.

import { useMemo, useSyncExternalStore } from 'react'
import { customAppsRequest } from '../api'
import { onAppsInvalidated } from './apps/store'
import { openAppPanel } from './apps/ui'
import { appLinkTitle, panelLinkTitle } from './apps/links'
import type { RefOutcome } from './reflinks'
import type { TypedRef } from './workrefs'

export interface AppRefRow { id: string; name: string; recent?: string | null }
export interface PanelRefRow { id: string; app: string; app_name: string; label: string; open: boolean; running?: boolean }
type Known = { app: AppRefRow } | { panel: PanelRefRow } | { absent: true }
type Kind = 'app' | 'panel'

/** one read's bound (the engine's wire::REFS_MAX) */
const BATCH = 64
/** targets kept per org, oldest dropped first; a dropped one simply asks again */
const KEEP = 512
/** a failed read is not retried on every render */
const RETRY_MS = 10_000

const keyOf = (kind: Kind, id: string) => `${kind}:${id}`

class AppReferences {
  private known = new Map<string, Map<string, Known>>()
  private queued = new Map<string, Set<string>>()
  private asking = new Map<string, Set<string>>()
  private failed = new Map<string, number>()
  private reading = new Set<string>()
  private subs = new Set<() => void>()
  private version = 0
  subscribe = (fn: () => void) => { this.subs.add(fn); return () => { this.subs.delete(fn) } }
  snapshot = () => this.version

  /** the kept answer, asking for it when there is none */
  get(org: string, kind: Kind, id: string): Known | undefined {
    const key = keyOf(kind, id)
    const hit = this.known.get(org)?.get(key)
    if (hit === undefined && Date.now() - (this.failed.get(org + '\0' + key) ?? 0) > RETRY_MS) this.ask(org, [key])
    return hit
  }

  /** the org's apps changed: read every kept target again. The old answers stay
   *  on screen until the new ones arrive, so chips do not flicker to `pending`. */
  invalidate(org: string): void {
    const kept = this.known.get(org)
    if (kept?.size) this.ask(org, [...kept.keys()], true)
  }

  private ask(org: string, keys: string[], again = false): void {
    const queue = this.queued.get(org) ?? new Set<string>()
    const asking = this.asking.get(org)
    for (const key of keys) if (again || !asking?.has(key)) queue.add(key)
    if (!queue.size) return
    this.queued.set(org, queue)
    queueMicrotask(() => this.flush(org))
  }

  private flush(org: string): void {
    if (this.reading.has(org)) return          // the read in flight flushes again when it ends
    const keys = [...(this.queued.get(org) ?? [])]
    this.queued.delete(org)
    if (!keys.length) return
    this.reading.add(org)
    const asking = this.asking.get(org) ?? new Set<string>()
    this.asking.set(org, asking)
    for (const key of keys) asking.add(key)
    void (async () => {
      for (let i = 0; i < keys.length; i += BATCH) {
        const part = keys.slice(i, i + BATCH)
        const apps = part.filter(k => k.startsWith('app:')).map(k => k.slice(4))
        const panels = part.filter(k => k.startsWith('panel:')).map(k => k.slice(6))
        try {
          const answer = await customAppsRequest<{ apps?: AppRefRow[]; panels?: PanelRefRow[] }>(org,
            { action: 'refs', ...(apps.length ? { apps } : {}), ...(panels.length ? { panels } : {}) })
          const found = new Map<string, Known>()
          for (const row of answer.apps ?? []) found.set(keyOf('app', row.id), { app: row })
          for (const row of answer.panels ?? []) found.set(keyOf('panel', row.id), { panel: row })
          for (const key of part) this.keep(org, key, found.get(key) ?? { absent: true })
          for (const key of part) this.failed.delete(org + '\0' + key)
          this.version++
          for (const fn of this.subs) fn()
        } catch {
          for (const key of part) this.failed.set(org + '\0' + key, Date.now())
        } finally {
          for (const key of part) asking.delete(key)
        }
      }
      this.reading.delete(org)
      if (this.queued.get(org)?.size) this.flush(org)
    })()
  }

  private keep(org: string, key: string, value: Known): void {
    const kept = this.known.get(org) ?? new Map<string, Known>()
    this.known.set(org, kept)
    kept.delete(key)                              // re-inserted as the newest
    kept.set(key, value)
    while (kept.size > KEEP) kept.delete(kept.keys().next().value!)
  }
}

export const appReferences = new AppReferences()
onAppsInvalidated((org) => appReferences.invalidate(org))

/** One app or panel mention, decided: what the chip says and its hover text,
 *  which is the text its Apps menu row shows (one link, one behaviour). */
export interface AppRefAnswer {
  outcome: RefOutcome
  label?: string
  title?: string
}

export function describeAppRef(org: string, ref: TypedRef): AppRefAnswer {
  const known = appReferences.get(org, ref.kind === 'app' ? 'app' : 'panel', ref.id)
  if (!known) return { outcome: 'pending' }
  if ('absent' in known) return { outcome: 'absent' }
  if ('app' in known) return { outcome: 'ready', label: known.app.name, title: appLinkTitle(known.app.name, known.app.recent) }
  // a panel's own label is "Panel N" by default (user 2026-10-26), which would
  // not say which app it belongs to
  return { outcome: 'ready', label: `${known.panel.app_name} · ${known.panel.label}`, title: panelLinkTitle(known.panel) }
}

/** The current answer for a panel mention, for its menu. */
export function panelRefRow(org: string, id: string): PanelRefRow | null {
  const known = appReferences.get(org, 'panel', id)
  return known && 'panel' in known ? known.panel : null
}

/** A surface's resolver for app and panel mentions in `org`. It changes
 *  identity whenever an answer arrives, so a world built from it does too and
 *  the chips on screen are decided again. */
export function useAppRefs(org: string): (ref: TypedRef) => AppRefAnswer {
  const version = useSyncExternalStore(appReferences.subscribe, appReferences.snapshot)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (ref: TypedRef) => describeAppRef(org, ref), [org, version])
}

/** What clicking an app or panel mention does: exactly what its Apps menu row
 *  does, through the rows' own `openAppPanel`. An app opens its most recently
 *  used copy, or a new one; a panel opens (a stopped copy starts); a copy that
 *  is already visible comes to the front. A refusal shows in the apps error
 *  banner. */
export function openAppRef(org: string, ref: TypedRef): void {
  openAppPanel(org, ref.kind === 'app' ? { app: ref.id } : { panel: ref.id })
    // the window's own CustomEvent: not every host defines one globally (api.ts)
    .catch((error) => window.dispatchEvent(new window.CustomEvent('custom-app-error', { detail: { slug: org, error: String(error) } })))
}
