// orgstatus.ts — ONE poller for the cross-organization status list, and one
// honest answer about how old the numbers on screen are.
//
// THE BUG THIS EXISTS FOR (`show-current-organization-statuses-immediately`).
// The org list used to be polled like this:
//
//     useEffect(() => {
//       if (slug && !drawer) return
//       const t = setInterval(refreshOrgs, 3000)   // ← no leading call
//       return () => clearInterval(t)
//     }, [slug, drawer, refreshOrgs])
//
// Two faults, and together they are the whole of the reported 3-5 second
// correction. (1) While an organization window was open with the list closed
// the poll was OFF, so the rows in memory could be minutes old. (2) Opening
// the list started an interval whose FIRST call is one period away, so the
// stale rows were painted and only replaced 3 s later. Nothing anywhere said
// the numbers were old; they simply changed under the reader.
//
// ⚠ THE 3-5 SECONDS WERE NOT THE SERVER'S, and assuming they were would have
// bought a backend change for nothing. `GET /api/orgs` answers synchronously
// with one completed array, `supervisor.working_count(slug)` reads `_state`
// under its lock at request time, and nothing persists a status TTL.
//
// ⚠ BUT IT IS NOT AN ATOMIC CROSS-ORGANIZATION SNAPSHOT EITHER, and this
// module must not claim it is. Verified in source by data-arch-astra
// (2026-09-21, api.py/store.py/supervisor.py at 02c92ea, unchanged through
// 77eca5d): the organization documents are read serially FIRST and each
// `working_count` then takes and releases `_state_lock` SEPARATELY, so
// membership and live counts have a different sample time from the busy
// counts, and the runtime can move between the two. `_scan_orgs` silently
// skips database, value, OS and migration failures, and a successful response
// carries no completeness marker, so an absent organization is not evidence
// that it is gone. There is no collection revision, no as-of and no coverage
// token to ask for. So the honest claim is FRESH PER RETURNED OBSERVATION —
// never "complete", never "coherent" in the stronger sense — and a public or
// kiosk row deliberately omits `working`, whose absence must never be rendered
// as a zero.
//
// What the renderer can therefore fix, and does: ask AFTER the list opens;
// stamp every snapshot with the time its request was ISSUED; report loading
// until a snapshot issued at or after the open arrives — a request already in
// flight when the list opened is NOT good enough, because it describes the
// world before the reader asked; publish the whole response at once rather
// than row by row; reject an older completion that lands after a newer one;
// and keep the last rows marked stale on an error rather than blanking them.
// The names and ordering still render throughout — that is navigation, not
// status.
import { useCallback, useEffect, useRef, useState } from 'react'
import { listOrgs } from './api'
import type { OrgListEntry } from './types'

/** How often an OPEN list re-asks. The pre-existing cadence, kept: the point
 *  of this module is the leading call and the honesty, not a faster poll. */
export const ORG_POLL_MS = 3000

/** When an open list stops being able to refresh, how long before its numbers
 *  stop being offered as current. THREE POLLS, not an invented interval: one
 *  missed poll is an ordinary blip on a route that reparses every org
 *  document, and three in a row is a failure the reader should be told about
 *  rather than shown stale counts for. */
export const ORG_STALE_MS = ORG_POLL_MS * 3

export type OrgFreshness =
  /** no snapshot yet, or the only one we have predates this list being opened */
  | 'loading'
  /** we have rows, but the refresh behind them is failing or has fallen behind */
  | 'stale'
  /** taken at or after the open, and still inside the staleness window */
  | 'current'

export interface OrgSnapshot {
  orgs: OrgListEntry[]
  /** `Date.now()` when the request behind `orgs` was ISSUED — not when it
   *  returned. The issue time is what "is this newer than the open?" has to be
   *  asked against: a request sent before the list opened describes the world
   *  before the list opened, however fast it came back. */
  at: number
  /** the last refresh failure, cleared by any success */
  error: string | null
}

export const EMPTY_SNAPSHOT: OrgSnapshot = { orgs: [], at: 0, error: null }

/** The whole freshness rule, as a pure function so it can be tested without a
 *  clock, a server or a mounted tree.
 *
 *  `openedAt` is when the surface showing these rows became visible; 0 means
 *  "always visible" (the browser's welcome screen), which makes any snapshot
 *  eligible. */
export function orgFreshness(snapshot: OrgSnapshot, openedAt: number,
  now: number, staleAfterMs: number = ORG_STALE_MS): OrgFreshness {
  if (!snapshot.at) return 'loading'
  // ⚠ predating the open is LOADING, not stale. The reader has just asked to
  // see the current state of every organization; rows gathered before they
  // asked are not a degraded answer to that question, they are not an answer
  // to it at all, and showing their counts is the exact defect this module
  // exists for.
  if (snapshot.at < openedAt) return 'loading'
  if (snapshot.error) return 'stale'
  return now - snapshot.at > staleAfterMs ? 'stale' : 'current'
}

/** How long ago, in whole seconds, the visible numbers were gathered. Used in
 *  the stale label so "could not refresh" carries an age rather than a mood. */
export const snapshotAgeMs = (snapshot: OrgSnapshot, now: number): number =>
  snapshot.at ? Math.max(0, now - snapshot.at) : 0

export interface OrgStatusOptions {
  /** whether the list is on screen right now. false stops the poll; a
   *  false→true edge is what re-asks immediately and re-arms the freshness
   *  comparison. */
  active: boolean
  /** injected in tests; the app passes nothing and gets `listOrgs` */
  load?: () => Promise<OrgListEntry[]>
  pollMs?: number
  staleAfterMs?: number
  /** the app's existing connectivity-banner hooks, so this poller keeps
   *  feeding them exactly as the old one did */
  onOk?: () => void
  onError?: (e: Error) => void
}

export interface OrgStatus {
  orgs: OrgListEntry[]
  /** true once a first listing has succeeded. The first-run onboarding gate
   *  reads this: an empty list that has never loaded must not be mistaken for
   *  an installation with no organizations. */
  known: boolean
  freshness: OrgFreshness
  /** age of the visible numbers in ms; 0 before the first snapshot */
  ageMs: number
  /** the last refresh failure, so the note can say WHY nothing is current */
  error: string | null
  /** force a refresh now — after a create, a delete, or an import */
  refresh: () => Promise<void>
}

/** The one org-list poller. Everything that shows cross-organization status —
 *  the Homepage list, the compact menu's organization submenu, the browser
 *  drawer — reads this, so they cannot disagree about how fresh the numbers
 *  are or ask the server four times for one answer. */
export function useOrgStatus(opts: OrgStatusOptions): OrgStatus {
  const { active, load, pollMs = ORG_POLL_MS, staleAfterMs = ORG_STALE_MS,
    onOk, onError } = opts
  const [snapshot, setSnapshot] = useState<OrgSnapshot>(EMPTY_SNAPSHOT)
  const [known, setKnown] = useState(false)
  // the moment the surface became visible. 0 while it is not.
  const [openedAt, setOpenedAt] = useState(0)
  // re-rendered on every poll tick so 'current' can decay into 'stale'
  // without a second timer of its own
  const [now, setNow] = useState(() => Date.now())
  // refs so `refresh` never changes identity — a changing callback here would
  // restart the interval on every snapshot, which is how the leading call got
  // lost the first time.
  const cbs = useRef({ load, onOk, onError })
  cbs.current = { load, onOk, onError }
  // the newest ISSUE time we have applied. An out-of-order response must not
  // pull the visible snapshot backwards in time.
  const applied = useRef(0)

  const refresh = useCallback(async () => {
    const issued = Date.now()
    setNow(issued)
    try {
      const rows = await (cbs.current.load ?? listOrgs)()
      if (issued < applied.current) return
      applied.current = issued
      setSnapshot({ orgs: rows, at: issued, error: null })
      setKnown(true)
      cbs.current.onOk?.()
    } catch (e) {
      const err = e as Error
      setNow(Date.now())
      setSnapshot((s) => ({ ...s, error: err.message || 'unavailable' }))
      cbs.current.onError?.(err)
    }
  }, [])

  // the false→true edge: re-arm the comparison and ask AT ONCE. Both halves
  // matter — arming without asking leaves the list loading forever, asking
  // without arming lets a snapshot from before the open count as current.
  //
  // It refreshes on the true→false edge and at mount too, deliberately. The
  // rows outlive the list: the organization header's activity tooltip reads
  // the same snapshot while the list is shut, and a poller that only ever ran
  // while something was open would hand that surface an empty list on a
  // desktop launch that restores straight into an organization.
  useEffect(() => {
    setOpenedAt(active ? Date.now() : 0)
    void refresh()
  }, [active, refresh])

  useEffect(() => {
    if (!active) return
    const t = setInterval(() => { setNow(Date.now()); void refresh() }, pollMs)
    return () => clearInterval(t)
  }, [active, pollMs, refresh])

  return {
    orgs: snapshot.orgs,
    known,
    freshness: orgFreshness(snapshot, openedAt, now, staleAfterMs),
    ageMs: snapshotAgeMs(snapshot, now),
    error: snapshot.error,
    refresh,
  }
}

/** The one sentence a list puts above its rows about its own numbers. `null`
 *  when the numbers are current — a list that is working says nothing.
 *
 *  A failure is named in BOTH unfresh states. While loading it is the reason
 *  the reader is still waiting; while stale it is the reason the numbers on
 *  screen stopped moving. Saying only "checking…" through a dead backend is
 *  the same silence this module was written to remove. */
export function orgFreshnessNote(freshness: OrgFreshness, ageMs: number,
  error: string | null): string | null {
  if (freshness === 'current') return null
  if (freshness === 'loading') {
    return 'checking organization status…'
      + (error ? ` (last attempt failed: ${error})` : '')
  }
  const secs = Math.round(ageMs / 1000)
  return `status from ${secs}s ago — could not refresh${error ? `: ${error}` : ''}`
}
