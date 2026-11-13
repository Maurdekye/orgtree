// saveconflict.tsx — the save that would replace someone's newer change
// (docs/rust-engine/remote-org.md, "The save that would replace a newer change").
//
// A save says what it was based on (`expect`: for each field it changes, the
// value the edit started from). The engine that runs the organization refuses
// it when that is no longer what is stored, and says what is stored, who
// changed it and when. Nothing is ever forced: "Save mine anyway" is a new
// save based on what the refusal said is stored, so a third change in between
// is caught again. What the person typed is never thrown away.
//
// One module so that every form says it the same way.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { asVia, otherPerson, ownOrigin } from './people'
import type { Via } from './people'
import { fmtHm } from './timefmt'

/** One field of a refused save. `stored` is the value now. Who changed it is
 *  `actor` (`@user` or an agent's name) and, for a user's change, the computer
 *  it came through; null where the engine cannot tell. */
export interface ConflictField { field: string; stored: unknown; actor: string | null; changed_by: Via | null; changed_at: string | null }
/** A refused save: `target` is `agent:<name>`, `org`, `defaults`, `orgmd` or `instructions`. */
export interface SaveConflict { target: string; fields: ConflictField[] }

const text = (v: unknown): string | null => typeof v === 'string' && v ? v : null

/** The refusal of a save that would replace a newer change, off a failed request; null for any other failure. */
export function saveConflictOf(error: unknown): SaveConflict | null {
  const e = error as { code?: unknown; conflict?: { target?: unknown; fields?: unknown } } | null | undefined
  if (!e || e.code !== 'save_conflict' || !e.conflict || !Array.isArray(e.conflict.fields)) return null
  const fields = (e.conflict.fields as unknown[]).flatMap((raw): ConflictField[] => {
    const f = raw as { field?: unknown; stored?: unknown; actor?: unknown; changed_by?: unknown; changed_at?: unknown }
    return f && typeof f.field === 'string'
      ? [{ field: f.field, stored: f.stored ?? null, actor: text(f.actor), changed_by: asVia(f.changed_by), changed_at: text(f.changed_at) }] : []
  })
  return fields.length ? { target: text(e.conflict.target) ?? '', fields } : null
}

/** A request someone else settled first, off a failed answer; null for any other failure. */
export function settledOf(error: unknown): { status: string; answered_via: Via | null; resolved_at: string | null } | null {
  const e = error as { code?: unknown; settled?: { status?: unknown; answered_via?: unknown; resolved_at?: unknown } } | null | undefined
  if (!e || e.code !== 'request_settled' || !e.settled) return null
  return { status: text(e.settled.status) ?? 'settled', answered_via: asVia(e.settled.answered_via), resolved_at: text(e.settled.resolved_at) }
}

/** C4, for the person whose answer came second: who settled the request, and when. */
export function settledSentence(settled: NonNullable<ReturnType<typeof settledOf>>, own: string | null = ownOrigin()): string {
  const who = otherPerson(settled.answered_via, own)?.name
  const at = settled.resolved_at ? ` at ${fmtHm(settled.resolved_at)}` : ''
  const done = ['answered', 'dismissed', 'denied', 'granted'].includes(settled.status) ? settled.status : 'settled'
  return who ? `${who} ${done} this request${at}. Your answer was not sent.` : `This request was already ${done}${at}. Your answer was not sent.`
}

/** How a long text is named in `expect` instead of being sent back whole: the
 *  first 16 hex digits of the SHA-256 of its UTF-8 bytes (`domain/expect.rs`).
 *  Without a digest to compute it with, the text itself is the expectation. */
export async function textBase(value: string): Promise<{ rev: string } | string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return { rev: [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('') }
  } catch { return value }
}

/** Who changed it, for a sentence: someone else's name, "You" for this window's
 *  own origin (another window of this computer), an agent's name, else null. */
export function changedBy(field: ConflictField, own: string | null = ownOrigin()): string | null {
  if (field.changed_by) return otherPerson(field.changed_by, own)?.name ?? 'You'
  return field.actor && field.actor !== '@user' && field.actor !== 'user' ? field.actor : null
}

/** C1 and C2: the sentence of a refused save. `label` names a field as the form does ("the instructions"). */
export function conflictSentence(conflict: SaveConflict, label: (field: string) => string, own: string | null = ownOrigin()): string {
  const first = conflict.fields[0]!
  const what = label(first.field) + (conflict.fields.length > 1 ? ` and ${conflict.fields.length - 1} more` : '')
  const named = conflict.fields.find((f) => changedBy(f, own)) ?? first
  const who = changedBy(named, own)
  if (!who) return `${what.charAt(0).toUpperCase()}${what.slice(1)} changed since you opened it. Nothing was saved.`
  const at = named.changed_at ? ` at ${fmtHm(named.changed_at)}` : ''
  return `${who} changed ${what}${who === 'You' ? ' in another window' : ''}${at}. Nothing was saved.`
}

/** C3: a single value someone set while this window was about to. */
export function valueSentence(field: ConflictField, label: string, shown: string, own: string | null = ownOrigin()): string {
  const who = changedBy(field, own)
  return who ? `${who} set ${label} to ${shown} just now. Your change was not saved.`
    : `${label.charAt(0).toUpperCase()}${label.slice(1)} is now ${shown}. Your change was not saved.`
}

/** An agent's settings, as a sentence names them (the wire names of `POST /nodes/{id}/scope`). */
const AGENT_FIELD_WORDS: Record<string, string> = {
  charter: 'the instructions', team_charter: 'the team instructions', peer_mail: 'whether subordinates may message each other',
  add_dirs: 'the folders', tools: 'the tools', org_visibility: 'the org visibility', permission_mode: 'the permission mode',
  session: 'the session', effort: 'the effort', fast_mode: 'fast mode', auto_cheap_compact: 'the cold-turn reset', model_version: 'the model version',
}
export const agentFieldWords = (field: string): string => AGENT_FIELD_WORDS[field] ?? field

/** An organization's settings, as a toast names them and shows their stored value (the wire names of
 *  `POST /api/orgs/{slug}/settings` and `/defaults`). */
export function orgSettingWords(field: string, stored: unknown): { label: string; shown: string } {
  const labels: Record<string, string> = { org_name: 'the name', max_top_grant: 'the largest top-level grant', default_top_grant: 'the default top-level grant',
    compact_at: 'the compaction threshold', default_effort: 'the default effort', permission_mode: 'the permission mode',
    default_visibility: 'the default visibility', default_account: 'the default account' }
  const shown = field === 'compact_at' && typeof stored === 'number' ? `${Math.round(stored > 1 ? stored : stored * 100)}%`
    : typeof stored === 'string' ? stored || 'none' : stored == null ? 'none' : JSON.stringify(stored)
  return { label: labels[field] ?? field.replace(/_/g, ' '), shown }
}

/** C5: under a field the person has edited, when its stored value changes underneath. */
export const CHANGED_WHILE_EDITING = 'This changed while you were editing.'

/** The line under an edited field whose stored value changed underneath, with a way to look at it. */
export function ChangedUnder({ value }: { value: string }) {
  const [open, setOpen] = useState(false)
  return <div className="save-conflict-under" role="status">
    <span>{CHANGED_WHILE_EDITING}</span>{' '}
    <button type="button" className="linklike" onClick={() => setOpen((o) => !o)}>{open ? 'Hide the new value' : 'See the new value'}</button>
    {open && <pre className="save-conflict-theirs" data-streamer-freeform>{value}</pre>}
  </div>
}

/** The notice a refused save shows in place of its Save row: the sentence and
 *  three choices. "See their version" shows what is stored beside what was
 *  typed (texts only), with "Use theirs"; "Save mine anyway" saves again, based
 *  on what is stored now; "Cancel" leaves the form as it is, unsaved. */
export function ConflictNotice({ sentence, theirs, busy, onUseTheirs, onSaveMine, onCancel }: {
  sentence: string
  /** the stored texts, when the refused fields are texts: what "See their version" shows */
  theirs?: { label: string; text: string }[]
  busy?: boolean
  onUseTheirs?: () => void
  onSaveMine: () => void
  onCancel: () => void
}): ReactNode {
  const [seeing, setSeeing] = useState(false)
  return <div className="save-conflict" role="alert">
    <p className="save-conflict-what">{sentence}</p>
    {seeing && theirs?.map((t) => <div className="save-conflict-version" key={t.label}>
      <div className="dim">{t.label}, as it is stored now:</div>
      <pre className="save-conflict-theirs" data-streamer-freeform>{t.text}</pre>
    </div>)}
    {seeing && onUseTheirs && <div className="row"><button type="button" disabled={busy} onClick={onUseTheirs}>Use theirs</button></div>}
    <div className="row">
      {theirs && theirs.length > 0 && <button type="button" disabled={busy} onClick={() => setSeeing((s) => !s)}>{seeing ? 'Hide their version' : 'See their version'}</button>}
      <button type="button" disabled={busy} onClick={onSaveMine}>{busy ? 'Saving...' : 'Save mine anyway'}</button>
      <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </div>
}
