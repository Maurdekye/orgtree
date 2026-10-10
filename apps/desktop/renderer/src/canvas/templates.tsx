// Organization templates outside the create window (docket
// create-organizations-from-agent-layout-templates, user ruling 2026-10-09
// 22:51Z): App settings gets "generate default templates" and "open
// templates folder" beside the charter controls, and Org settings gets "Save
// as template" — a modal with a name and checkboxes for what to copy, which
// writes the file into ~/.orgtree/templates and offers it as a download.
import { useState } from 'react'
import { openTemplatesFolder, populateTemplates, saveOrgTemplate } from '../api'
import type { SavedTemplate, TemplateInclude } from '../api'
import { ModalOverPins } from './modalpin'
import { SetGroup, SetRow } from './settingskit'
import { useEsc } from './shared'
import '../shell/templatepicker.css'

export function TemplateDocumentsSetting() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ dir: string; created: string[]; existing: string[] } | null>(null)
  const [error, setError] = useState('')
  const [openBusy, setOpenBusy] = useState(false)
  const [openError, setOpenError] = useState('')
  const run = () => {
    setBusy(true)
    populateTemplates()
      .then(r => { setResult(r); setError('') })
      .catch((e: Error) => { setResult(null); setError(e.message) })
      .finally(() => setBusy(false))
  }
  const openFolder = () => {
    setOpenBusy(true)
    setOpenError('')
    openTemplatesFolder()
      .then(res => { if (!res.ok) setOpenError(res.error || 'Could not open the templates folder') })
      .catch((e: Error) => setOpenError(e.message || 'Could not open the templates folder'))
      .finally(() => setOpenBusy(false))
  }
  return <SetGroup title="Organization templates"
    note="starting layouts for a new organization, in ~/.orgtree/templates">
    <SetRow label="generate default templates"
      hint="Copies the bundled templates (devteam (claude), devteam (codex)) into your templates folder. Files you already have are never changed.">
      <button onClick={run} disabled={busy}>
        {busy ? 'generating…' : 'generate'}
      </button>
      <button onClick={openFolder} disabled={openBusy} aria-label="open templates folder" title="open templates folder">
        {openBusy ? 'opening…' : 'open folder'}
      </button>
    </SetRow>
    {error && <p role="alert">Templates were not generated: {error} — press again to retry.</p>}
    {openError && <p role="alert">Could not open the templates folder: {openError}</p>}
    {result && !error && (
      <p className="dim">
        {result.created.length
          ? `created ${result.created.length} template${result.created.length === 1 ? '' : 's'}`
          : 'nothing to create'}
        {result.existing.length ? ` · ${result.existing.length} already present and untouched` : ''}
        {` · ${result.dir}`}
      </p>
    )}
  </SetGroup>
}

/** The groups "Save as template" offers. The tree, names and tiers are
 *  always saved; accounts and folders belong to this computer and start off. */
const GROUPS: { key: keyof TemplateInclude; label: string; hint?: string }[] = [
  { key: 'charters', label: 'Charters and team charters' },
  { key: 'credits', label: 'Credits', hint: "each agent's spare credits" },
  { key: 'effort', label: 'Effort' },
  { key: 'tools', label: 'Tool switches, visibility and permission mode' },
  { key: 'org_md', label: 'org.md' },
  { key: 'accounts', label: 'Account binding', hint: 'this computer only; used where it can run, otherwise picked automatically' },
  { key: 'folders', label: 'Folder scopes', hint: "this computer only; trimmed to the new organization's folders" },
]
export const DEFAULT_INCLUDE: TemplateInclude = {
  charters: true, credits: true, effort: true, tools: true, org_md: true, accounts: false, folders: false,
}

/** Hand the saved file to the browser's download, as documents are. */
export function downloadTemplate(owner: Document, saved: SavedTemplate) {
  const url = window.URL.createObjectURL(new Blob([saved.content], { type: 'application/json' }))
  const anchor = owner.createElement('a')
  anchor.href = url
  anchor.download = saved.file
  owner.body.appendChild(anchor)
  try { anchor.click() } finally {
    anchor.remove()
    window.setTimeout(() => window.URL.revokeObjectURL(url), 30_000)
  }
}

export function SaveTemplateModal({ slug, orgName, close }: { slug: string; orgName: string; close: () => void }) {
  useEsc(close)
  const [name, setName] = useState(`${orgName} layout`)
  const [include, setInclude] = useState<TemplateInclude>(DEFAULT_INCLUDE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [exists, setExists] = useState(false)
  const [saved, setSaved] = useState<SavedTemplate | null>(null)
  const save = (replace: boolean) => {
    if (busy || !name.trim()) return
    setBusy(true); setError(''); setExists(false)
    saveOrgTemplate(slug, name.trim(), include, replace)
      .then(setSaved)
      .catch((e: Error) => {
        setError(e.message)
        setExists(/already exists/.test(e.message))
      })
      .finally(() => setBusy(false))
  }
  return (
    <ModalOverPins><div className="overlay" onClick={close} onPointerDown={(e) => e.stopPropagation()}>
      <div className="settings content-height save-template" role="dialog" aria-modal="true"
        aria-label="Save as template" onClick={(e) => e.stopPropagation()}>
        <h3>Save “{orgName}” as a template</h3>
        {!saved ? (<>
          <label className="field-label" htmlFor="save-template-name">Template name</label>
          <input id="save-template-name" autoFocus value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(false) }} />
          <div className="field-label">Include</div>
          <div className="save-template-groups">
            <label className="row org-check"><input type="checkbox" checked disabled /> Tree, names and tiers
              <span className="dim"> · always</span></label>
            {GROUPS.map((g) => (
              <label className="row org-check" key={g.key}>
                <input type="checkbox" checked={include[g.key]}
                  onChange={(e) => setInclude((i) => ({ ...i, [g.key]: e.target.checked }))} />
                {g.label}{g.hint && <span className="dim"> · {g.hint}</span>}
              </label>
            ))}
          </div>
          <p className="dim">Never saved: mail, docket items, transcripts, watchdogs and audiences.
            Anything unticked takes the normal hire defaults when the template is used.</p>
          {error && <div className="ask-warn" role="alert">{error}</div>}
          <div className="row">
            {exists
              ? <button className="primary" disabled={busy} onClick={() => save(true)}>Replace it</button>
              : <button className="primary" disabled={busy || !name.trim()} onClick={() => save(false)}>
                {busy ? 'Saving…' : 'Save template'}</button>}
            <button onClick={close}>cancel</button>
          </div>
        </>) : (<>
          <p>Saved <b>{saved.file}</b> with {saved.agents} agent{saved.agents === 1 ? '' : 's'} to your templates
            folder. It is offered under Starting layout when you create an organization.</p>
          <p className="dim save-template-path">{saved.path}</p>
          {saved.problems.length > 0 && (
            <div className="ask-warn" role="alert">This template cannot be used as saved: {saved.problems.join('; ')}</div>)}
          <div className="row">
            <button className="primary" onClick={(e) => downloadTemplate(e.currentTarget.ownerDocument, saved)}>
              Download {saved.file}</button>
            <button onClick={() => { void openTemplatesFolder() }}>open templates folder</button>
            <button onClick={close}>close</button>
          </div>
        </>)}
      </div>
    </div></ModalOverPins>
  )
}

export function SaveTemplateSetting({ slug, orgName }: { slug: string; orgName: string }) {
  const [open, setOpen] = useState(false)
  return <SetGroup title="Templates" note="~/.orgtree/templates">
    <SetRow label="save as template"
      hint="Saves this organization's agents (tree, names and tiers, plus what you choose) as a starting layout for new organizations.">
      <button onClick={() => setOpen(true)}>save as template…</button>
    </SetRow>
    {open && <SaveTemplateModal slug={slug} orgName={orgName} close={() => setOpen(false)} />}
  </SetGroup>
}
