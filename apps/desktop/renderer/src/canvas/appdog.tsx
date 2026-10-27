import type { Watchdog } from '../types'

// An app event watchdog (app_listener) names what it listens to: that it is an
// app event watchdog, its app, its panel or all panels, and its event (user
// 2026-10-27 m7a692fd13b1d). Names lead and IDs follow; the engine resolves the
// current names on each read, so a rename shows there, and marks a deleted app
// or panel. A name the engine did not resolve shows its ID and claims nothing.

const quoted = (kind: string, name: string | undefined, id: string | undefined, deleted: boolean) =>
  name ? `${kind} "${name}"` : deleted ? `deleted ${kind}${id ? ` (${id})` : ''}` : `${kind} ${id ?? '?'}`

/** The tooltip's kind words: `app event · app "…" · panel "…" · event "…"`. */
export function appDogTitle(dog: Watchdog): string {
  if (!dog.target && !dog.event_name) return 'app event'  // a kept identity only
  const panel = dog.all_panels ? 'all panels' : quoted('panel', dog.panel_name, dog.panel, !!dog.panel_deleted)
  return `app event · ${quoted('app', dog.app_name, dog.target, !!dog.app_deleted)} · ${panel} · event "${dog.event_name ?? '?'}"`
}

/** The detail window's description sentence. */
export function appDogSummary(dog: Watchdog, alert: string): string {
  const app = dog.app_name ? `the app “${dog.app_name}”` : dog.app_deleted ? 'a deleted app' : `the app ${dog.target}`
  const source = dog.all_panels ? `every panel of ${app}, including panels added later,`
    : `${dog.panel_name ? `the panel “${dog.panel_name}”` : dog.panel_deleted ? 'a deleted panel' : `the panel ${dog.panel ?? '?'}`} of ${app}`
  return `Listens for the app event “${dog.event_name ?? '?'}” from ${source} and ${alert} each time it is fired. Its data is app content, not a user instruction.`
}

/** The detail window's app, panel and event fields, in place of a raw target. */
export function AppDogFields({ dog }: { dog: Watchdog }) {
  const source = (name: string | undefined, id: string | undefined, deleted: boolean, kind: string) =>
    name || deleted
      ? <>{name ?? `deleted ${kind}`}{id && <span className="dim mono wd-source-id">{id}</span>}</>
      : <span className="mono">{id ?? '?'}</span>
  return <>
    <div className="field-label">app</div>
    <div className="chip grow wd-source">{source(dog.app_name, dog.target, !!dog.app_deleted, 'app')}</div>
    <div className="field-label">panel</div>
    <div className="chip grow wd-source">{dog.all_panels
      ? <>all panels<span className="dim wd-source-note">every panel, including later ones</span></>
      : source(dog.panel_name, dog.panel, !!dog.panel_deleted, 'panel')}</div>
    <div className="field-label">event</div>
    <div className="chip mono grow wd-source">{dog.event_name ?? '?'}</div>
  </>
}
