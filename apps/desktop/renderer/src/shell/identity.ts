// shell/identity.ts — which window this is, answered without a frame of doubt.
//
// v2 had one main window held in a module-scoped `main`, so nothing ever had
// to ask. v3 has several at once — Homepage, Create, and one per organization
// — and the renderer's very first render already has to know which it is.
//
// ⚠ SYNCHRONOUS SEED, ASYNC TRUTH. `getWindowIdentity()` is a promise, and a
// shell that waited for it would paint the wrong view for a frame: a Homepage
// window flashing an organization canvas, or an org window flashing the org
// list. So the initial value comes from `orgtreeDesktop.windowIdentity`, a
// plain object the preload resolves over IPC BEFORE it exposes the bridge
// (native contract v2 §N1). The promise and the `window-identity` event are
// what keep it current afterwards — a Homepage that binds itself to an
// organization keeps its window id and changes only `kind`/`org`.
//
// In a plain browser, and in the shipped v2 shell, there is no identity at all
// and every hook here answers `null`. That is the signal to render exactly
// today's app, not a degraded v3 one.
import { useEffect, useState } from 'react'
import { desktop, windowIdentity } from '../desktop'
import type { OrgWindowIdentity } from '../desktop'

/** True when two identities describe the same window in the same state, so an
 *  event that repeats what we already hold re-renders nothing. */
export function sameIdentity(a: OrgWindowIdentity | null, b: OrgWindowIdentity | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  // ⚠ COMPARE WHAT THE FLAG MEANS, NOT WHETHER IT IS TRUTHY. Absent means
  // owner (see `ownsNotifications`) and only an explicit `false` demotes, so
  // `Boolean(undefined) === Boolean(false)` would call "owner" and "not
  // owner" the same identity — and a window handed the duty away would never
  // re-render, never stop polling, and go on reconciling alongside the real
  // owner. Measured: that is exactly what a `Boolean()` comparison did here.
  return a.windowId === b.windowId && a.kind === b.kind && a.org === b.org
    && (a.notificationOwner !== false) === (b.notificationOwner !== false)
}

/** Only accept something that is actually an identity. A malformed payload
 *  from an event is dropped rather than allowed to blank the view — an
 *  unparseable message is not evidence that this window stopped being an
 *  organization window. */
export function readIdentity(value: unknown): OrgWindowIdentity | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<OrgWindowIdentity>
  if (typeof v.windowId !== 'string' || !v.windowId) return null
  if (v.kind !== 'homepage' && v.kind !== 'create' && v.kind !== 'org') return null
  if (v.kind === 'org' && (typeof v.org !== 'string' || !v.org)) return null
  return {
    windowId: v.windowId, kind: v.kind,
    ...(v.kind === 'org' ? { org: v.org } : {}),
    ...(typeof v.notificationOwner === 'boolean'
      ? { notificationOwner: v.notificationOwner } : {}),
  }
}

/** This window's identity, live. `null` means "not a v3 native window". */
export function useWindowIdentity(): OrgWindowIdentity | null {
  // seeded synchronously — see the header note; there is no loading state here
  // on purpose, because a loading state is a frame of the wrong view
  const [identity, setIdentity] = useState<OrgWindowIdentity | null>(
    () => readIdentity(windowIdentity()))
  useEffect(() => {
    const bridge = desktop()
    if (!bridge?.getWindowIdentity) return
    let alive = true
    const adopt = (value: unknown) => {
      const next = readIdentity(value)
      if (!alive || !next) return
      setIdentity((prev) => (sameIdentity(prev, next) ? prev : next))
    }
    // the authoritative read, in case the synchronous seed was refused
    bridge.getWindowIdentity().then(adopt).catch(() => { /* the seed stands */ })
    const off = bridge.onEvent((event) => {
      // ⚠ ownership TRANSFER arrives this way too, not only binding. When the
      // notification-owning window closes the duty moves, and the window that
      // gains it learns here — which is the only thing that starts its poll.
      if ((event.type as string) === 'window-identity') adopt(event.data)
    })
    return () => { alive = false; off() }
  }, [])
  return identity
}

/** Which of the four views this window shows. `null` when there is no v3
 *  identity, i.e. render the pre-v3 app. */
export const identityView = (identity: OrgWindowIdentity | null):
  'homepage' | 'create' | 'org' | null => identity?.kind ?? null

/** The organization this window is BOUND to, if any.
 *
 *  ⚠ THIS IS THE ONLY SOURCE OF THE BOUND ORGANIZATION IN A v3 WINDOW, and it
 *  is deliberately not writable from the renderer. A bound window never
 *  changes organization: every route that used to call `setSlug(other)` asks
 *  native to open or focus another window instead. */
export const identityOrg = (identity: OrgWindowIdentity | null): string | null =>
  identity?.kind === 'org' ? identity.org ?? null : null

/** Whether this window carries the app-wide notification duties: the
 *  cross-organization projection read, the native cleanup reconciliation and
 *  the taskbar aggregate. Handling a notification CLICK is not part of it.
 *
 *  ⚠ ONLY AN EXPLICIT `false` DEMOTES A WINDOW. No identity at all is the
 *  single-window world, where the one window has always done this work; an
 *  identity that simply does not carry the flag is a shell that has not
 *  implemented ownership yet. Both answer yes, because the two failures here
 *  are not symmetric: several windows reconciling is a race the user sees as
 *  duplicate or vanishing alerts, but NO window reconciling is a user who is
 *  never told anything at all, and defaulting to silence is how that happens
 *  the first time a flag is missing. */
export const ownsNotifications = (identity: OrgWindowIdentity | null): boolean =>
  identity?.notificationOwner !== false
