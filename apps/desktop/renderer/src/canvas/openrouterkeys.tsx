// Several OpenRouter keys at once (docket use-several-openrouter-keys-at-once,
// ruling 2026-10-11). The OpenRouter section (openrouter.tsx) keeps the
// ORIGINAL key's row as it always was; this file adds what several keys need:
//
//  - a row per ADDED key (`openrouter-N`): its name, verdict and spend line,
//    and the same three icon buttons as the original row (re-check · edit ·
//    remove);
//  - the shared name, harness and optional replacement form every key uses
//    in settings (each key has its own harness, user 2026-10-13).
// The section header owns its single add action for first and subsequent keys.
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
  getOpenRouter, removeOpenRouterKey, setOpenRouterKeyEnabled, updateOpenRouterKey,
} from '../api'
import { AutorenewIcon, DeleteIcon, EditIcon } from '../icons'
import type { OpenRouterDoc, OpenRouterHarness, OpenRouterHarnessOption, OpenRouterKey } from '../types'
import { ProviderDialog } from './providerdialog'
import { SetToggle } from './settingskit'
import { HarnessesLink } from './harnesses'

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

/** a key dialog's harness row: the CLIs that can drive OpenRouter agents
 *  here, the key's stored harness, the backend's sentence when there is no
 *  live choice, and (an edit) its agents pinned to their own harness */
export interface KeyHarnessField {
  value: string
  options: OpenRouterHarnessOption[]
  explain: string
  pinned: number
}

export function keyHarness(h: OpenRouterHarness, value: string, pinned = 0): KeyHarnessField {
  return { value, options: h.harnesses, explain: h.explain, pinned }
}

/** a harness id as people name it */
export function harnessName(options: OpenRouterHarnessOption[], id: string | undefined): string {
  return options.find((o) => o.id === id)?.label ?? id ?? ''
}

/** the name, the harness (an older backend sends none: no row) and, for an
 *  edit, an optional replacement key of one key. `save` gets the harness
 *  chosen, or undefined with no harness row. */
export function OpenRouterKeyDialog({ title, keyRequired, initialName, harness, busy, close, save }: {
  title: string
  keyRequired: boolean
  initialName: string
  harness?: KeyHarnessField
  busy: boolean
  close: () => void
  save: (name: string, key: string, harness?: string) => void
}) {
  const [name, setName] = useState(initialName)
  const [key, setKey] = useState('')
  const [picked, setPicked] = useState(harness?.value)
  const ready = !busy && (!keyRequired || !!key.trim())
  // a harness not installed is never sent: the key keeps what it has (an
  // add gets the default)
  const submit = () => { if (ready) save(name.trim(), key.trim(), missing ? undefined : picked) }
  // only installed harnesses are offered (user 2026-10-13); a saved one no
  // longer installed stays listed, saying so, until another is picked
  const offered = (harness?.options ?? []).filter((o) => o.available || o.id === harness?.value)
  const live = offered.filter((o) => o.available).length > 1
  const missing = !!harness && !harness.options.find((o) => o.id === picked)?.available
  const changed = !keyRequired && !!harness && picked !== harness.value
  return <ProviderDialog title={title} busy={busy} close={close}>
    <div className="provider-key-form">
      <label htmlFor="openrouter-key-name">Name (optional)</label>
      <input type="text" id="openrouter-key-name" maxLength={80} autoComplete="off"
        placeholder="e.g. team budget" aria-label="OpenRouter key name"
        value={name} disabled={busy} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
      {harness && <>
        <label htmlFor="openrouter-key-harness">Harness</label>
        <select id="openrouter-key-harness" aria-label="OpenRouter key harness" value={picked ?? ''}
          disabled={busy || !(live || (missing && offered.some((o) => o.available)))}
          onChange={(e) => setPicked(e.target.value)}>
          {offered.map((o) => (
            <option key={o.id} value={o.id} disabled={!o.available}>
              {o.available ? o.label : `${o.label} (not installed)`}
            </option>
          ))}
        </select>
        {missing && <div className="ask-warn-inline">
          {harnessName(harness.options, picked)} is not installed on this computer: agents on this key
          refuse to start until it is installed or another harness is chosen.</div>}
        <div className="dim account-note">
          {!live && harness.explain ? `${harness.explain} ` : ''}
          {keyRequired
            ? 'The CLI that runs agents on this key.'
            : changed
              ? `Its agents move to ${harnessName(harness.options, picked)} at their next turn, on a fresh session that starts with a summary.`
              : 'The CLI that runs agents on this key. A change reaches them at their next turn.'}
          {harness.pinned > 0 && ` ${harness.pinned} ${harness.pinned === 1 ? 'agent was' : 'agents were'} hired with a chosen harness and ${harness.pinned === 1 ? 'keeps it' : 'keep theirs'}.`}
        </div>
        <HarnessesLink />
      </>}
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

/** the added keys' rows and settings; the section header owns adding */
export function OpenRouterAddedKeys({ doc, busy, run }: { doc: OpenRouterDoc; busy: boolean; run: Run }) {
  const h = doc.harness
  const [editing, setEditing] = useState<OpenRouterKey | null>(null)
  const added = (doc.keys ?? []).filter((k) => !k.original)
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
            {h && k.harness && <span className={k.harness_installed === false ? 'ask-warn-inline' : 'dim'}>
              {' · '}{harnessName(h.harnesses, k.harness)}{k.harness_installed === false ? ' (not installed)' : ''}</span>}
          </span>
          <button className="acct-btn" title="re-check every key and its credit standing at openrouter.ai"
            disabled={busy} onClick={() => run(getOpenRouter(true), '')}>
            <AutorenewIcon fontSize="inherit" /></button>
          <button className="acct-btn" title="rename this key, choose its harness or replace it" disabled={busy}
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
    {editing && <OpenRouterKeyDialog title={`Edit ${editing.name}`} keyRequired={false} initialName={editing.label ?? ''}
      harness={h && editing.harness ? keyHarness(h, editing.harness, editing.pinned_seats) : undefined}
      busy={busy} close={() => setEditing(null)}
      save={(name, key, picked) => {
        const moved = picked && picked !== editing.harness ? { harness: picked } : {}
        run(updateOpenRouterKey(editing.id, key ? { label: name, key, ...moved } : { label: name, ...moved }),
          key ? `${editing.id} replaced` : moved.harness && h
            ? `${editing.id} now runs on ${harnessName(h.harnesses, moved.harness)}` : `${editing.id} renamed`)
        setEditing(null)
      }} />}
  </>
}
