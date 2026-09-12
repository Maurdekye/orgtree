// Recovery action for the onboarding charter population (coordinator ruling
// 2026-09-08): a create-path populate failure leaves ~/.orgtree/charters
// unseeded with nothing offering to fill it, because first-run setup only
// returns at zero organizations. This Settings action calls the same
// idempotent POST /api/charters/populate — existing files are never
// overwritten — with pending, success and error states, and a failure leaves
// the button ready to retry. It does not reopen setup or touch preferences.
import { useState } from 'react'
import { openCharterFolder, populateCharters } from '../api'
import { SetGroup, SetRow } from './settingskit'

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
