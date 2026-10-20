import { useEffect, useRef, useState } from 'react'
import { req } from '../api'
import type { CanvasNode } from './shared'

export interface RetiredPage { agents: CanvasNode[]; next_cursor: string | null }
export function getRetiredPage(org: string, parent: string, q = '', cursor = ''): Promise<RetiredPage> {
  const params = new URLSearchParams({ parent, q })
  if (cursor) params.set('cursor', cursor)
  return req(`/api/orgs/${encodeURIComponent(org)}/retired?${params}`)
}

/** Modal-local rows, never a tree selection. One request per scroll boundary;
 * changing the search/parent/org invalidates every older reply immediately. */
export function useRetiredPages(org: string | undefined, parent: string, enabled: boolean) {
  const [query, setQuery] = useState('')
  const scope = JSON.stringify([org, parent, query.trim(), enabled])
  const current = useRef(scope); current.current = scope
  const pending = useRef<{ scope: string } | null>(null)
  const [page, setPage] = useState({ scope: '', rows: [] as CanvasNode[], next: null as string | null, busy: false, error: '' })
  const load = (cursor = '') => {
    if (!org || !enabled || pending.current?.scope === scope) return
    const ticket = { scope }; pending.current = ticket
    setPage(p => ({ scope, rows: cursor && p.scope === scope ? p.rows : [], next: cursor || null, busy: true, error: '' }))
    getRetiredPage(org, parent, query.trim(), cursor).then(result => {
      if (current.current !== scope || pending.current !== ticket) return
      setPage(p => ({ scope, rows: cursor ? [...p.rows, ...result.agents.filter(a => !p.rows.some(old => old.id === a.id))] : result.agents,
        next: result.next_cursor, busy: false, error: '' }))
      pending.current = null
    }, e => {
      if (current.current !== scope || pending.current !== ticket) return
      pending.current = null
      setPage(p => ({ ...p, busy: false, error: e.message }))
    })
  }
  useEffect(() => {
    current.current = scope
    pending.current = null
    if (!org || !enabled) return
    setPage({ scope, rows: [], next: null, busy: true, error: '' })
    // Coalesce typing, but opening the list has no delay.
    const timer = query.trim() ? setTimeout(() => load(), 180) : undefined
    if (!query.trim()) load()
    return () => { clearTimeout(timer); pending.current = null; current.current = '' }
  }, [scope])
  const shown = page.scope === scope ? page : { rows: [], next: null, busy: true, error: '' }
  return { ...shown, query, setQuery, loadMore: () => { if (!shown.busy && shown.next) load(shown.next) }, retry: () => load(shown.next ?? '') }
}
