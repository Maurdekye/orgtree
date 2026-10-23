// USER 2026-10-23: opening preference is local navigation, per org/collection.
// Store identities only. Reading by an agent never changes this user preference.
import { useCallback, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { readModalOpen } from './modalpin'
import { restoredWindows } from '../windowlayout'

const PREFIX = 'orgtree.reader.last.v1:'
export const readerScope = (kind: 'work' | 'presented', org: string, node = '', team = false) =>
  JSON.stringify([kind, org, node, team])
export function lastReaderItem(scope: string): string | null {
  try { const id = localStorage.getItem(PREFIX + scope); return id && id.length <= 512 ? id : null }
  catch { return null }
}
export function rememberReaderItem(scope: string, id: string): void {
  if (!id || id.length > 512) return
  try { localStorage.setItem(PREFIX + scope, id) } catch { /* navigation works in private mode */ }
}
/** A continued pinned/window reader is not a new generic opening. Empty is a
 * deliberate deselection; undefined means there is no saved reader to resume. */
export function resumedReaderItem(org: string, kind: string): string | undefined {
  const restore = readModalOpen(org).find(row => row.kind === kind)?.restore
    ?? restoredWindows(org).find(row => row.kind === kind)?.restore
  return restore?.selection ?? restore?.document
}
export function useReaderResume(org: string, kind: string): string | undefined {
  const key=JSON.stringify([org,kind])
  const held=useRef<{key:string;id:string | undefined} | null>(null)
  if(held.current?.key!==key) held.current={key,id:resumedReaderItem(org,kind)}
  return held.current.id
}
export function useReaderSelection(scope: string, initial: string | null = null): [string | null, Dispatch<SetStateAction<string | null>>] {
  const [state, setState] = useState({scope, id: initial})
  const id = state.scope === scope ? state.id : null
  const choose = useCallback<Dispatch<SetStateAction<string | null>>>(next => {
    setState(old => ({scope, id: typeof next === 'function' ? next(old.scope === scope ? old.id : null) : next}))
  }, [scope])
  return [id, choose]
}
export function openingWork<T extends {slug: string; status: string; archived?: boolean}>(
  rows: T[], last: string | null, attention: (row: T) => boolean): string | null {
  return rows.find(attention)?.slug
    ?? rows.find(row => row.slug === last && !row.archived && !['done','dropped','superseded'].includes(row.status))?.slug
    ?? rows[0]?.slug ?? null
}
