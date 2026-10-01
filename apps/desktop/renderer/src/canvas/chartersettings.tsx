// Recovery action for the onboarding charter population (coordinator ruling
// 2026-09-08): a create-path populate failure leaves ~/.orgtree/charters
// unseeded with nothing offering to fill it, because first-run setup only
// returns at zero organizations. This Settings action calls the same
// idempotent POST /api/charters/populate — existing files are never
// overwritten — with pending, success and error states, and a failure leaves
// the button ready to retry. It does not reopen setup or touch preferences.
import { useEffect, useState } from 'react'
import {
  getCharterTemplateDirs, openCharterFolder, populateCharters, setCharterTemplateDirs,
} from '../api'
import { CloseIcon, FolderIcon } from '../icons'
import { pickFolder } from '../picker'
import type { CharterTemplateDirState, CharterTemplateDirsPayload } from '../types'
import { SetBlock, SetGroup, SetRow } from './settingskit'

export function CharterDocumentsSetting() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ dir: string; created: string[]; existing: string[] } | null>(null)
  const [error, setError] = useState('')
  const [openBusy, setOpenBusy] = useState(false)
  const [openError, setOpenError] = useState('')
  const run = () => {
    setBusy(true)
    populateCharters()
      .then(r => { setResult(r); setError('') })
      .catch((e: Error) => { setResult(null); setError(e.message) })
      .finally(() => setBusy(false))
  }
  const openFolder = () => {
    setOpenBusy(true)
    setOpenError('')
    openCharterFolder()
      .then(res => {
        if (!res.ok) {
          setOpenError(res.error || 'Could not open charter folder')
        }
      })
      .catch((e: Error) => {
        setOpenError(e.message || 'Could not open charter folder')
      })
      .finally(() => setOpenBusy(false))
  }
  return <SetGroup title="Charter documents"
    note="editable presets for the hire form, in ~/.orgtree/charters">
    <SetRow label="populate missing documents"
      hint="Copies the bundled charter presets into your charter folder. Files you already have are never changed.">
      <button onClick={run} disabled={busy}>
        {busy ? 'populating…' : 'populate'}
      </button>
      <button onClick={openFolder} disabled={openBusy} aria-label="open charter folder" title="open charter folder">
        {openBusy ? 'opening…' : 'open folder'}
      </button>
    </SetRow>
    {error && <p role="alert">Charter documents were not populated: {error} — press again to retry.</p>}
    {openError && <p role="alert">Could not open charter folder: {openError}</p>}
    {result && !error && (
      <p className="dim">
        {result.created.length
          ? `created ${result.created.length} document${result.created.length === 1 ? '' : 's'}`
          : 'nothing to create'}
        {result.existing.length ? ` · ${result.existing.length} already present and untouched` : ''}
        {` · ${result.dir}`}
      </p>
    )}
  </SetGroup>
}

// External charter template folders (docket
// add-external-agent-charter-templates-folder, user ruling 2026-09-23): an
// app-wide ordered list of folders whose *.md files join the hire form's
// charter presets as read-only choices. Only the list is written; the folders
// are never created or changed, and each row shows its live scan state so a
// missing, unreadable, non-folder or linked path is visible rather than
// silently contributing nothing.
const DIR_STATUS: Record<CharterTemplateDirState['status'], string> = {
  ok: 'ok',
  missing: 'missing — the folder does not exist',
  not_directory: 'not a folder',
  link_refused: 'refused — the path goes through a link or junction',
  invalid_path: 'not a usable folder path',
  unreadable: 'unreadable',
}

function dirNotes(d: CharterTemplateDirState): string[] {
  const notes: string[] = []
  if (d.skipped_links?.length) notes.push(`linked files not read: ${d.skipped_links.join(', ')}`)
  if (d.not_files?.length) notes.push(`not regular files, skipped: ${d.not_files.join(', ')}`)
  if (d.oversize?.length) notes.push(`files too large to read: ${d.oversize.join(', ')}`)
  if (d.unreadable_files?.length) notes.push(`files that could not be read: ${d.unreadable_files.join(', ')}`)
  if (d.listing_truncated) notes.push('only the first .md files were examined; the folder holds more')
  return notes
}

// an older engine (or a partial reply) may omit any of the lists
const normalized = (p: Partial<CharterTemplateDirsPayload> | null | undefined):
  CharterTemplateDirsPayload => ({
  ...p,
  dirs: Array.isArray(p?.dirs) ? p.dirs : [],
  directories: Array.isArray(p?.directories) ? p.directories : [],
  duplicates: Array.isArray(p?.duplicates) ? p.duplicates : [],
})

export function CharterTemplateDirsSetting() {
  const [data, setDataRaw] = useState<CharterTemplateDirsPayload | null>(null)
  const setData = (p: Partial<CharterTemplateDirsPayload>) => setDataRaw(normalized(p))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [newPath, setNewPath] = useState('')
  useEffect(() => {
    let live = true
    getCharterTemplateDirs()
      .then(p => { if (live) { setData(p); setError('') } })
      .catch((e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [])
  const save = (dirs: string[], after?: () => void) => {
    setBusy(true)
    setCharterTemplateDirs(dirs)
      .then(p => { setData(p); setError(''); after?.() })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }
  const dirs = data?.dirs ?? []
  const add = (path: string) => {
    const p = path.trim()
    if (p) save([...dirs, p], () => setNewPath(''))
  }
  const state = (path: string) => data?.directories.find(d => d.path === path)
  return <SetGroup title="Charter template folders"
    note="read-only folders of .md templates for the hire form">
    <SetBlock hint={'Every .md file directly inside a listed folder is offered in the '
      + 'hire form’s charter presets. Orgtree only reads these folders: it never '
      + 'creates, changes or copies anything in them, and templates with the same '
      + 'name in different places are all offered, labelled by folder. Links, junctions '
      + 'and cloud-sync placeholder files (such as OneDrive files not kept on this '
      + 'device) are treated as links and not read.'}>
      <div className="dirlist" aria-label="charter template folders">
        {data === null && !error && <p className="dim">loading…</p>}
        {data !== null && dirs.length === 0 && <p className="dim">no folders listed</p>}
        {dirs.map(path => {
          const d = state(path)
          const notes = d ? dirNotes(d) : []
          return <div key={path}>
            <div className="dirrow">
              <span className="chip mono grow" title={path}>{path}</span>
              <span className={d?.status === 'ok' ? 'dim' : 'ask-warn'}>
                {d ? (d.status === 'ok'
                  ? `${d.count} template${d.count === 1 ? '' : 's'}`
                  : DIR_STATUS[d.status]) : ''}
              </span>
              <button type="button" className="iconbtn" disabled={busy}
                aria-label={`remove ${path}`} title="remove from the list (the folder itself is untouched)"
                onClick={() => save(dirs.filter(x => x !== path))}><CloseIcon fontSize="inherit" /></button>
            </div>
            {d?.error && d.status !== 'ok' && <p className="dim mono">{d.error}</p>}
            {notes.map(n => <p key={n} className="dim">{n}</p>)}
          </div>
        })}
        <div className="dirrow">
          <input placeholder="add an absolute folder path" aria-label="add a charter template folder"
            value={newPath} disabled={busy || data === null}
            onChange={e => setNewPath(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') add(newPath) }} />
          <button type="button" className="iconbtn" title="browse for a folder"
            aria-label="browse for a charter template folder" disabled={busy || data === null}
            onClick={() => { void pickFolder().then(r => { if (r.path) add(r.path) }).catch(() => {}) }}>
            <FolderIcon fontSize="inherit" /></button>
          <button type="button" className="addrow" disabled={busy || data === null || !newPath.trim()}
            onClick={() => add(newPath)}>add</button>
        </div>
      </div>
      {data && data.duplicates.length > 0 && (
        <p className="dim">
          {'same name in more than one place (all are offered): '
            + data.duplicates.map(d => `${d.name} ×${d.locations.length}`).join(', ')}
        </p>
      )}
      {error && <p role="alert">Charter template folders: {error}</p>}
    </SetBlock>
  </SetGroup>
}
