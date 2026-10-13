// Several OpenRouter keys at once (docket use-several-openrouter-keys-at-once,
// ruling 2026-10-11). The OpenRouter section (openrouter.tsx) keeps the
// ORIGINAL key's row as it always was; this file adds what several keys need:
//
//  - a row per ADDED key (`openrouter-N`): its name, verdict and spend line,
//    and the same three icon buttons as the original row (re-check · edit ·
//    remove);
//  - "Add another OpenRouter key", once one key is stored;
//  - the name dialog every key shares (the original's name button too).
//
// Each key is its own account: agents are placed on it, Org settings ›
// Accounts ticks it per org, and the usage window shows its own card. The
// prepaid balance is the OpenRouter ACCOUNT's, so every key of one account
// shows the same "account balance". A secret crosses the wire once, inward:
// the dialogs only ever send a key, never show one.
//
// The forms open in the shared ProviderDialog (providerdialog.tsx).

import { useState } from 'react'
import {
  addOpenRouterKey, getOpenRouter, removeOpenRouterKey, setOpenRouterKeyEnabled, updateOpenRouterKey,
} from '../api'
import { AutorenewIcon, DeleteIcon, EditIcon, LabelIcon } from '../icons'
import type { OpenRouterDoc, OpenRouterKey } from '../types'
import { ProviderDialog } from './providerdialog'
import { SetToggle } from './settingskit'

type Run = (p: Promise<OpenRouterDoc>, ok: string) => void

/** one key's app-wide switch (user 2026-10-11 22:50: every key is
 *  individually disableable from Providers; Org settings › Accounts narrows
 *  it per org but cannot turn on a key switched off here). Reversible:
 *  nothing is deleted. Compact like an account's (user 2026-10-12 20:22Z):
 *  "Active" beside the key, its full name kept as the switch's name. */
export function KeyActive({ k, busy, run }: { k: OpenRouterKey; busy: boolean; run: Run }) {
  return <>
    <SetToggle label={`${k.name} active`} labelContent="Active" checked={k.enabled} disabled={busy}
      title={k.enabled
        ? 'Active: serves turns. Clear it and this key serves no new turns.'
        : 'Inactive: serves no new turns. Check it to use this key again.'}
      onChange={(on) => run(setOpenRouterKeyEnabled(k.id, on), `${k.name} ${on ? 'active' : 'inactive'}`)} />
    {!k.enabled && <div className="dim account-note">
      Inactive: its agents wait until it is active again or they move to another key.</div>}
  </>
}

/** the original key's switch, for the section in openrouter.tsx */
export function OriginalKeyActive({ doc, busy, run }: { doc: OpenRouterDoc; busy: boolean; run: Run }) {
  const original = doc.keys?.find((k) => k.original)
  return original ? <KeyActive k={original} busy={busy} run={run} /> : null
}

/** what the original key is called on its row: its name once there are
 *  several keys (so the rows can be told apart), else what it always said */
export function originalKeyName(doc: OpenRouterDoc): string {
  const keys = doc.keys ?? []
  const original = keys.find((k) => k.original)
  if (original && (keys.length > 1 || original.label)) return original.name
  return doc.label ?? 'OpenRouter key'
}

/** a key's spend line: the reading's own row label (spend, cap, account
 *  balance), or why there is none */
function standingOf(k: OpenRouterKey): string {
  if (k.connected === false) return k.reason ?? 'refused at openrouter.ai'
  const label = k.limits.map((l) => l.label).filter(Boolean).join(' · ')
  if (label) return label
  return k.connected == null ? 'not read at openrouter.ai yet' : 'no spend reported'
}

/** the name (and, for an edit, an optional replacement key) of one key */
function KeyDialog({ title, keyRequired, initialName, busy, close, save }: {
  title: string
  keyRequired: boolean
  initialName: string
  busy: boolean
  close: () => void
  save: (name: string, key: string) => void
}) {
  const [name, setName] = useState(initialName)
  const [key, setKey] = useState('')
  const ready = !busy && (!keyRequired || !!key.trim())
  const submit = () => { if (ready) save(name.trim(), key.trim()) }
  return <ProviderDialog title={title} busy={busy} close={close}>
    <div className="provider-key-form">
      <label htmlFor="openrouter-key-name">Name (optional)</label>
      <input type="text" id="openrouter-key-name" maxLength={80} autoComplete="off"
        placeholder="e.g. team budget" aria-label="OpenRouter key name"
        value={name} disabled={busy} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
      <label htmlFor="openrouter-key-secret">{keyRequired ? 'API key' : 'Replace the API key (optional)'}</label>
      <input type="password" id="openrouter-key-secret" autoComplete="off" spellCheck={false}
        placeholder={keyRequired ? 'paste an OpenRouter API key (sk-or-…)' : 'leave empty to keep the current key'}
        aria-label="OpenRouter API key" value={key} disabled={busy}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
      <div className="ls-actions">
        <button type="button" className="acct-secondary-btn" disabled={!ready} onClick={submit}>Save</button>
        <button type="button" className="acct-secondary-btn" disabled={busy} onClick={close}>Cancel</button>
      </div>
    </div>
    <div className="acct-provenance">
      <span>a key is stored on this machine, never shown again</span>
      <span>with no name, a key is called by the label it has at openrouter.ai</span>
    </div>
  </ProviderDialog>
}

/** the original key's name button, for its row in openrouter.tsx */
export function OriginalKeyNameButton({ doc, busy, run }: { doc: OpenRouterDoc; busy: boolean; run: Run }) {
  const [open, setOpen] = useState(false)
  const original = doc.keys?.find((k) => k.original)
  if (!original) return null
  return <>
    <button className="acct-btn" title="name this key" disabled={busy} aria-haspopup="dialog"
      onClick={() => setOpen(true)}><LabelIcon fontSize="inherit" /></button>
    {open && <KeyDialog title="Name the OpenRouter key" keyRequired={false} initialName={original.label ?? ''}
      busy={busy} close={() => setOpen(false)}
      save={(name) => { run(updateOpenRouterKey(original.id, { label: name }), 'OpenRouter key renamed'); setOpen(false) }} />}
  </>
}

/** the added keys' rows and "Add another OpenRouter key" */
export function OpenRouterAddedKeys({ doc, busy, run }: { doc: OpenRouterDoc; busy: boolean; run: Run }) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<OpenRouterKey | null>(null)
  const added = (doc.keys ?? []).filter((k) => !k.original)
  const anyKey = doc.any_key ?? doc.key_set
  return <>
    {added.map((k) => <div className="acct-line" key={k.id}>
      <span className="acct-gutter" />
      <div className="acct-row orr-keyrow">
        <div className="acct-main">
          <span className="acct-grip acct-ghost">⠿</span>
          <span className="acct-email orr-standing" title={`${k.name} (${k.lane}) · ${standingOf(k)}`}>
            {k.name}<span className="dim"> ({k.lane})</span>
            <span className={k.connected === false ? 'ask-warn-inline' : 'dim'}>
              {' · '}{k.connected ? 'connected' : k.connected === false ? 'not connected' : 'not checked yet'}
              {k.enabled ? '' : ' · inactive'}
            </span>
          </span>
          <button className="acct-btn" title="re-check every key and its credit standing at openrouter.ai"
            disabled={busy} onClick={() => run(getOpenRouter(true), '')}>
            <AutorenewIcon fontSize="inherit" /></button>
          <button className="acct-btn" title="rename this key or replace it" disabled={busy}
            aria-haspopup="dialog" onClick={() => setEditing(k)}><EditIcon fontSize="inherit" /></button>
          <button className="acct-btn acct-del"
            title="remove this key — agents on it move to the first OpenRouter key"
            disabled={busy} onClick={() => run(removeOpenRouterKey(k.id), `${k.name} removed`)}>
            <DeleteIcon fontSize="inherit" /></button>
        </div>
        <div className="acct-provenance">
          <span className={k.connected === false ? 'acct-dead' : ''}>{standingOf(k)}</span>
        </div>
        <KeyActive k={k} busy={busy} run={run} />
      </div>
    </div>)}
    {anyKey && <button type="button" className="acct-secondary-btn" disabled={busy} aria-haspopup="dialog"
      onClick={() => setAdding(true)}>Add another OpenRouter key</button>}
    {adding && <KeyDialog title="Add another OpenRouter key" keyRequired initialName="" busy={busy}
      close={() => setAdding(false)}
      save={(name, key) => { run(addOpenRouterKey(key, name), 'OpenRouter key added'); setAdding(false) }} />}
    {editing && <KeyDialog title={`Edit ${editing.name}`} keyRequired={false} initialName={editing.label ?? ''}
      busy={busy} close={() => setEditing(null)}
      save={(name, key) => {
        run(updateOpenRouterKey(editing.id, key ? { label: name, key } : { label: name }),
          key ? `${editing.id} replaced` : `${editing.id} renamed`)
        setEditing(null)
      }} />}
  </>
}
