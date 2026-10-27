// canvas/apprefs.ts — app and panel mentions: the names they show and what
// clicking one does (USER 2026-10-27 m449dc0a35cbe).
//
// The names are a `refnames` reader over the engine's bounded Apps `refs` read
// of the exact IDs on screen (an app and a panel share a read), read again
// whenever the org's apps change: a rename, a deletion, a copy starting or
// stopping. The hover text is the one each Apps menu row shows (links.ts).

import { customAppsRequest } from '../api'
import { onAppsInvalidated } from './apps/store'
import { openAppPanel } from './apps/ui'
import { appLinkTitle, panelLinkTitle } from './apps/links'
import { refKey, refNames } from './refnames'
import type { TypedRef } from './workrefs'

/** `asked` is the id the mention was written with: the slug, or the old
 *  generic id an app or panel had before slugs (engine migration 0075). `id` is
 *  its slug now. */
export interface AppRefRow { asked?: string; id: string; name: string; recent?: string | null }
export interface PanelRefRow { asked?: string; id: string; app: string; app_name: string; label: string; open: boolean; running?: boolean }

refNames.register({
  kinds: ['app', 'panel'],
  // the engine's wire::REFS_MAX
  batch: 64,
  async read(org, ids) {
    const apps = ids.filter(x => x.kind === 'app').map(x => x.id)
    const panels = ids.filter(x => x.kind === 'panel').map(x => x.id)
    const answer = await customAppsRequest<{ apps?: AppRefRow[]; panels?: PanelRefRow[] }>(org,
      { action: 'refs', ...(apps.length ? { apps } : {}), ...(panels.length ? { panels } : {}) })
    const found = new Map<string, unknown>()
    // keyed by the id each chip asked with, so an older mention keeps its name
    for (const row of answer.apps ?? []) found.set(refKey('app', row.asked ?? row.id), row)
    for (const row of answer.panels ?? []) found.set(refKey('panel', row.asked ?? row.id), row)
    return found
  },
  name(kind, row) {
    if (kind === 'app') {
      const app = row as AppRefRow
      return { label: app.name, title: appLinkTitle(app.name, app.recent) }
    }
    // a panel's own label is "Panel N" by default (user 2026-10-26), which
    // would not say which app it belongs to
    const panel = row as PanelRefRow
    return { label: `${panel.app_name} · ${panel.label}`, title: panelLinkTitle(panel) }
  },
})
onAppsInvalidated((org) => refNames.invalidate(org, ['app', 'panel']))

/** The current answer for a panel mention, for its menu. */
export function appRefRow(org: string, id: string): AppRefRow | null {
  return (refNames.row(org, 'app', id) as AppRefRow | undefined) ?? null
}
export function panelRefRow(org: string, id: string): PanelRefRow | null {
  return (refNames.row(org, 'panel', id) as PanelRefRow | undefined) ?? null
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
