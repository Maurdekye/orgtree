// shell/openorgs.ts — which organizations currently hold a main window.
//
// One use: marking a Homepage row "Already open" before it is clicked, so
// choosing it reads as "bring that window forward" rather than as an ordinary
// open that will silently do something else.
//
// ⚠ IT IS A LABEL, NOT THE BEHAVIOUR. The behaviour has never depended on this
// list and must not start to: `requestOrg` decides atomically inside the
// native registry, and it answers `focused` for an organization that is
// already open however stale this renderer's idea of the world happens to be.
// So a missing, late or wrong list costs a label and nothing else — which is
// the only reason it is safe to read an app-wide fact from a renderer at all.
//
// ⚠ AND IT NAMES ORGANIZATIONS, NEVER WINDOWS. Native deliberately hands out
// no window ids here, so knowing that something is open does not become a
// route into it.
import { useEffect, useState } from 'react'
import { desktop } from '../desktop'

const readList = (value: unknown): string[] | null => {
  const rows = Array.isArray(value) ? value
    : Array.isArray((value as { orgs?: unknown } | null)?.orgs)
      ? (value as { orgs: unknown[] }).orgs : null
  if (!rows) return null
  return rows.filter((o): o is string => typeof o === 'string' && !!o)
}

/** The set of organizations with a window, live. Empty in a browser and in a
 *  shell that does not publish it — and an empty set simply means no row is
 *  labelled, never that a row is known NOT to be open. */
export function useOpenOrgs(): ReadonlySet<string> {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    const bridge = desktop()
    if (!bridge?.openOrgs) return
    let alive = true
    const adopt = (value: unknown) => {
      const rows = readList(value)
      if (!alive || !rows) return
      setOpen((prev) => {
        // a repeated list re-renders nothing — this arrives on every bind,
        // open and close in the whole application
        if (prev.size === rows.length && rows.every((o) => prev.has(o))) return prev
        return new Set(rows)
      })
    }
    bridge.openOrgs().then(adopt).catch(() => { /* rows stay unlabelled */ })
    const off = bridge.onEvent((e) => {
      if ((e.type as string) === 'open-orgs') adopt(e.data)
    })
    return () => { alive = false; off() }
  }, [])
  return open
}
