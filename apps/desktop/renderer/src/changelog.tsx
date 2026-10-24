// changelog.tsx — the Changelog panel (docket
// changelog-window-one-row-per-version-pinnable-po).
//
// USER 2026-10-24 22:13:55Z (m2f12a37391ca), verbatim: "changelog window.
// structured identically to the presentations panel, one row per version,
// latest at the top. pinnable / poppable, accessible via a new entry in the
// app menu below usage history. opens automatically after an update on first
// launch (not on fresh install). backfill from existing github release
// descriptions." Then 22:14:57Z: "and add an option to disable automatically
// opening it (and a link to that option on the changelog panel's header)";
// 22:15:56Z: "opens automatically to the latest version when opened (and when
// opening automatically on launch after update)"; 22:16:17Z: "each list entry
// has the version number and release date"; 22:17:14Z: "release date & time".
//
// THE PRESENTATIONS PANEL'S SHAPE (canvas/gallery.tsx DocGalleryModal): the
// same PinFrame, `.gallery-head`, and the mail idiom's `.mailpane` with the
// collapsible list on the left and the reading pane on the right, in the same
// row classes. Rows are versions: the version and its release date & time
// (fmtStamp, local, like other list rows), newest first. The pane repeats them
// in the full form (fmtFull, as the Presentations pane does) above the notes.
//
// EVERY OPENING SHOWS THE LATEST, whatever was read last time: from the menu,
// on the automatic opening after an update, and for a pinned panel restored at
// startup. `opening` is that request (a new number for each); the selection
// lives in this mount only.
//
// The rows and notes are the engine's (GET /api/changelog, crate::changelog),
// bundled at build time, so the panel works offline.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangelogEntry, ChangelogList, ChangelogRow } from './api'
import { getChangelog, getChangelogEntry } from './api'
import { ChangelogIcon } from './icons'
import { PinFrame } from './canvas/modalpin'
import { CollapsibleMailer, NARROW_DOCS_WIDTH } from './canvas/narrowlist'
import { usePanelSteps } from './canvas/panelsteps'
import { RefMdBody } from './canvas/refmd'
import { md } from './canvas/shared'
import { openAppSettings, SetToggle } from './canvas/settingskit'
import { fmtFull, fmtStamp } from './timefmt'

// ── THE SETTING ─────────────────────────────────────────────────────────────
// A view preference of this profile, like "Open desk after manual hire"
// (hirefocus.ts): read when native says this launch is the first after an
// update (App.tsx). Off keeps the panel shut; the menu still opens it.
export const CHANGELOG_AFTER_UPDATE_KEY = 'orgtree-changelog-after-update'
/** the Display › Startup row the panel header links to (`useSettingsTarget`) */
export const CHANGELOG_AFTER_UPDATE_FIELD = 'changelog_after_update'
export function changelogAfterUpdateOn(): boolean {
  try { return localStorage.getItem(CHANGELOG_AFTER_UPDATE_KEY) !== '0' } catch { return true }
}
const listeners = new Set<() => void>()
export function setChangelogAfterUpdateOn(on: boolean): void {
  try { localStorage.setItem(CHANGELOG_AFTER_UPDATE_KEY, on ? '1' : '0') } catch { /* private mode */ }
  for (const fn of [...listeners]) fn()
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  window.addEventListener('storage', fn)
  return () => { listeners.delete(fn); window.removeEventListener('storage', fn) }
}
export const useChangelogAfterUpdate = (): boolean => useSyncExternalStore(subscribe, changelogAfterUpdateOn)

export function ChangelogAfterUpdateSetting() {
  const on = useChangelogAfterUpdate()
  return <SetToggle label="Open changelog after updates" checked={on} onChange={setChangelogAfterUpdateOn}
    field={CHANGELOG_AFTER_UPDATE_FIELD}
    hint="The first time Orgtree starts after an update, the Changelog opens on the new version. A fresh install never opens it." />
}

// ── THE PANEL ───────────────────────────────────────────────────────────────
const UNPUBLISHED = 'Unpublished build'
/** `4.4.5` for `4.4.5-alpha.3`: the release an unpublished build leads to */
const releaseOf = (version: string): string => version.split(/[-+]/)[0] ?? version

function useChangelogList(): { list: ChangelogList | null; error: string | null; retry: () => void } {
  const [list, setList] = useState<ChangelogList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setError(null)
    getChangelog()
      .then((next) => { if (live) setList(next) })
      .catch((e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [attempt])
  return { list, error, retry: () => setAttempt((n) => n + 1) }
}

/** One version's notes, each read once per mount (they never change while
 *  the engine runs: they are part of its build). */
function useChangelogEntry(version: string | null): { entry: ChangelogEntry | null; error: string | null } {
  const cache = useRef(new Map<string, ChangelogEntry>())
  const [, setLoaded] = useState(0)
  const [error, setError] = useState<{ version: string; message: string } | null>(null)
  useEffect(() => {
    if (!version || cache.current.has(version)) return
    let live = true
    getChangelogEntry(version)
      .then((entry) => { cache.current.set(version, entry); if (live) setLoaded((n) => n + 1) })
      .catch((e: Error) => { if (live) setError({ version, message: e.message }) })
    return () => { live = false }
  }, [version])
  return {
    entry: version ? cache.current.get(version) ?? null : null,
    error: version && error?.version === version ? error.message : null,
  }
}

export function ChangelogModal({ close, opening = 0 }: {
  close: () => void
  /** a request to show the latest version (each opening is a new number) */
  opening?: number
}) {
  const { list, error, retry } = useChangelogList()
  const rows = list?.releases ?? null
  const [selected, setSelected] = useState<string | null>(null)
  // the latest on every opening, once the rows are here
  const shown = useRef<number | null>(null)
  useEffect(() => {
    if (!rows || shown.current === opening) return
    shown.current = opening
    setSelected(rows[0]?.version ?? null)
  }, [rows, opening])
  const ids = useMemo(() => (rows ?? []).map((r) => r.version), [rows])
  const steps = usePanelSteps(ids, selected, setSelected, '.changelog-row')
  const current = rows?.find((r) => r.version === selected) ?? null
  const autoOpen = useChangelogAfterUpdate()
  return (
    <PinFrame kind="changelog" title="Changelog" panel="settings wide gallery-modal changelog-modal" close={close}>
      <div className="gallery-head">
        <h3><ChangelogIcon fontSize="inherit" /> Changelog</h3>
        {/* the user's link to the setting (22:14:57Z), saying what it is now */}
        <button type="button" className="link-btn changelog-setting-link"
          title="Change this in App settings › Display › Startup"
          onClick={() => openAppSettings('display', CHANGELOG_AFTER_UPDATE_FIELD)}>
          Open after updates: {autoOpen ? 'On' : 'Off'}
        </button>
      </div>
      <div className="mailpane">
        {!rows || rows.length === 0
          ? error
            ? <div className="ask-warn pad" role="alert">
                could not load the changelog: {error}{' '}
                <button className="doc-list-retry" onClick={retry}>Retry</button>
              </div>
            : <div className="dim pad">{rows ? 'no releases' : 'loading…'}</div>
          : (
            <CollapsibleMailer collapsible threshold={NARROW_DOCS_WIDTH} listLabel="version list"
              tabIndex={-1} rootRef={steps.rootRef} onKeyDown={steps.onKeyDown}
              list={
                <div className="mailer-list" tabIndex={0} aria-label="Versions">
                  {rows.map((r) => <ChangelogRowView key={r.version} row={r} on={r.version === selected}
                    onSelect={() => setSelected(r.version)} />)}
                </div>
              }>
              <div className="mailer-read">
                {current
                  ? <ChangelogPane key={current.version} row={current} />
                  : <div className="dim pad mailer-none">select a version to read its notes</div>}
              </div>
            </CollapsibleMailer>
          )}
      </div>
    </PinFrame>
  )
}

function ChangelogRowView({ row, on, onSelect }: { row: ChangelogRow; on: boolean; onSelect: () => void }) {
  return (
    <div className={'mailrow doc-gallery-row changelog-row active' + (on ? ' on' : '')
      + (row.unpublished ? ' unpublished' : '')}
      data-version={row.version}
      title={row.released_at ? `${row.version} · ${fmtFull(row.released_at)}` : row.version}
      onClick={onSelect}>
      <div className="l1">
        <span className="mfrom">{row.version}</span>
        <span className="mtime">{row.released_at ? fmtStamp(row.released_at) : ''}</span>
      </div>
      {row.unpublished && <div className="l2"><span className="dim">{UNPUBLISHED}</span></div>}
    </div>
  )
}

function ChangelogPane({ row }: { row: ChangelogRow }) {
  const { entry, error } = useChangelogEntry(row.version)
  const draft = entry?.notes_version && entry.notes_version !== row.version ? entry.notes_version : null
  return (
    <>
      <div className="mailer-head doc-pane-head">
        <div className="doc-pane-meta-row">
          <b className="changelog-version">{row.version}</b>
          {row.unpublished && <span className="dim">{UNPUBLISHED}</span>}
          {row.released_at && <span className="dim">{fmtFull(row.released_at)}</span>}
        </div>
        {draft && <div className="dim changelog-draft">Draft notes for {draft}</div>}
      </div>
      {error && <div className="ask-warn">could not load the notes: {error}</div>}
      {!entry && !error && <div className="dim pad">loading…</div>}
      {entry && (entry.notes
        ? <RefMdBody className="mailer-body md changelog-notes" html={md(entry.notes)} />
        : <div className="dim pad">
            {row.unpublished
              ? `Release notes for ${releaseOf(row.version)} are written when it is released.`
              : 'No release notes.'}
          </div>)}
    </>
  )
}
