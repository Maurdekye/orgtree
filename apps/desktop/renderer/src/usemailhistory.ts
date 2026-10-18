import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getMailHistory } from './api'
import type { InboxPayload, MailEntry, SentMailEntry } from './types'

const empty = (): InboxPayload => ({ pending: [], delivered: [], sent: [] })
/** Latest source wins both content and read state; a row occurs in one folder. */
function merge(a: InboxPayload, b: InboxPayload): InboxPayload {
  const incoming = new Map<string, { mail: MailEntry; pending: boolean }>()
  for (const box of [a, b]) {
    for (const mail of box.pending) incoming.set(mail.id, { mail, pending: true })
    for (const mail of box.delivered) incoming.set(mail.id, { mail, pending: false })
  }
  const sent = new Map<string, SentMailEntry>()
  for (const mail of [...a.sent, ...b.sent]) sent.set(mail.id, mail)
  return { pending: [...incoming.values()].filter(m => m.pending).map(m => m.mail),
    delivered: [...incoming.values()].filter(m => !m.pending).map(m => m.mail), sent: [...sent.values()] }
}

/** One bounded page on open/change/scroll, never an unbounded history refresh.
 * Keep older pages when the live head changes; invalidate old identity responses. */
export function useMailboxHistory(slug: string, base: InboxPayload | null | undefined, folder: string, visible: boolean, refresh: unknown = 0) {
  const identity = JSON.stringify([slug, folder])
  const [state, setState] = useState({ identity, box: empty(), cursor: null as string | null,
    paged: false, ready: false, loading: false, error: null as string | null, deleted: [] as string[], read: [] as string[] })
  const current = state.identity === identity ? state : { ...state, identity, box: empty(), cursor: null, paged: false, ready: false, loading: false, error: null, deleted: [], read: [] }
  const latest = useRef(current); latest.current = current
  const generation = useRef(0), busy = useRef(false), retryCursor = useRef<string | undefined>(undefined)
  const revision = JSON.stringify([base?.mail_revision, base?.pending.map(m => m.id), base?.delivered.map(m => m.id), base?.sent.map(m => m.id)])
  const read = useCallback((before: string | undefined, request: number) => {
    if (busy.current || (folder !== 'inbox' && folder !== 'sent')) return
    busy.current = true; retryCursor.current = before
    setState(old => ({ ...(old.identity === identity ? old : { ...current }), identity, loading: true, error: null }))
    void getMailHistory(slug, folder, before).then(page => {
      if (generation.current !== request) return
      setState(old => ({ ...old, identity, box: merge(old.identity === identity ? old.box : empty(), page),
        cursor: !before && old.identity === identity && old.paged ? old.cursor : page.next_cursor ?? null,
        paged: !!before || old.paged, ready: true, loading: false, error: null }))
    }).catch((e: Error) => {
      if (generation.current === request) setState(old => ({ ...old, loading: false, error: e.message }))
    }).finally(() => { if (generation.current === request) busy.current = false })
  // The request's identity, not the current rows, owns the response.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, folder, identity])
  useEffect(() => {
    const request = ++generation.current; busy.current = false
    if (visible && base) read(undefined, request)
    return () => { ++generation.current; busy.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, visible, !!base, revision, refresh, read])
  const box = useMemo(() => {
    if (!base) return base
    const merged = merge(current.box, base), removed = new Set(current.deleted), acknowledged = new Set(current.read)
    return { ...merged, pending: merged.pending.filter(m => !removed.has(m.id) && !acknowledged.has(m.id)),
      delivered: [...merged.delivered, ...merged.pending.filter(m => acknowledged.has(m.id))].filter(m => !removed.has(m.id)),
      sent: merged.sent.filter(m => !removed.has(m.id)) }
  }, [base, current.box, current.deleted, current.read])
  const loadMore = () => { if (visible && latest.current.cursor) read(latest.current.cursor, generation.current) }
  const retry = () => { if (visible) read(retryCursor.current, generation.current) }
  const remove = (id: string) => setState(old => old.identity === identity ? { ...old, deleted: [...old.deleted, id] } : old)
  const acknowledge = (id: string) => setState(old => old.identity === identity ? { ...old, read: [...old.read, id] } : old)
  return { box, hasMore: !!current.cursor, loading: current.loading, error: current.error, loadMore, retry, remove, acknowledge }
}
