import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getMailHistory, refreshMailHistory } from './api'
import type { InboxPayload, MailEntry, SentMailEntry } from './types'

const empty = (): InboxPayload => ({ pending: [], delivered: [], sent: [] })
const folders = ['pending', 'delivered', 'sent'] as const
const isMail = (row: unknown): row is MailEntry => !!row && typeof row === 'object'
  && typeof (row as MailEntry).id === 'string'
/** Legacy/live windows may omit unused folders. Normalize once per payload,
 * before either the revision key or the merged view reads those lists. */
function mailbox(value: unknown): InboxPayload {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<InboxPayload> : {}
  const rows = (field: typeof folders[number]) => Array.isArray(source[field]) ? source[field]!.filter(isMail) : []
  return { ...source, pending: rows('pending'), delivered: rows('delivered'), sent: rows('sent') }
}
/** A malformed 2xx page is a failed read, not an empty end of history. This
 * must run outside the state updater so the request's catch can offer Retry. */
function historyPage(value: unknown): InboxPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid mail history response')
  const source = value as Partial<InboxPayload>
  if (!folders.some(field => Array.isArray(source[field]))) throw Error('Invalid mail history response')
  for (const field of folders) {
    const rows = source[field]
    if (rows != null && (!Array.isArray(rows) || !rows.every(isMail))) throw Error('Invalid mail history response')
  }
  if (source.next_cursor != null && (typeof source.next_cursor !== 'string' || !/^[1-9][0-9]*$/.test(source.next_cursor))) throw Error('Invalid mail history response')
  return { ...mailbox(source), next_cursor: source.next_cursor ?? null }
}
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

/** Bounded history pages plus exact retained-ID refresh on mail changes.
 * Never infer deletion from absence in a head page or accept old identity responses.
 *
 * `peer` (the user's mailbox, folder `chat`): ONE CHAT'S OWN PAGES, both
 * directions under one cursor, filtered at the engine (the user's chats,
 * dm/DmPanel.tsx). Its first read is that chat's newest page, and every later
 * page holds that chat's mail only. */
export function useMailboxHistory(slug: string, rawBase: InboxPayload | null | undefined, folder: string, visible: boolean, refresh: unknown = 0, node?: string, peer?: string) {
  const base = useMemo(() => rawBase == null ? rawBase : mailbox(rawBase), [rawBase])
  const identity = JSON.stringify([slug, node ?? null, folder, peer ?? null])
  const [state, setState] = useState({ identity, box: empty(), cursor: null as string | null,
    paged: false, ready: false, loading: false, error: null as string | null, errorStatus: null as number | null, deleted: [] as string[], read: [] as string[] })
  const current = state.identity === identity ? state : { ...state, identity, box: empty(), cursor: null, paged: false, ready: false, loading: false, error: null, errorStatus: null, deleted: [], read: [] }
  const latest = useRef(current); latest.current = current
  const generation = useRef(0), busy = useRef(false), retryCursor = useRef<string | undefined>(undefined)
  const revision = JSON.stringify([base?.mail_revision, base?.pending.map(m => m.id), base?.delivered.map(m => m.id), base?.sent.map(m => m.id)])
  const read = useCallback((before: string | undefined, request: number) => {
    const chat = folder === 'chat' && !!peer
    if (busy.current || (folder !== 'inbox' && folder !== 'sent' && !chat)) return
    busy.current = true; retryCursor.current = before
    setState(old => ({ ...(old.identity === identity ? old : { ...current }), identity, loading: true, error: null, errorStatus: null }))
    const retained = latest.current.identity === identity ? latest.current.box : empty()
    void getMailHistory(slug, folder as 'inbox' | 'sent' | 'chat', before, node, peer).then(async value => {
      if (generation.current !== request) return
      const page = historyPage(value)
      let box = merge(retained, page)
      if (!before) {
        const fresh = new Set(folders.flatMap(field => page[field].map(m => m.id)))
        const ids = [...new Set(folders.flatMap(field => retained[field].map(m => m.id)))].filter(id => !fresh.has(id))
        // Refresh only loaded identities, 200 per indexed read. Complete all
        // batches before replacing state; failure cannot masquerade as deletion.
        let refreshed = empty()
        for (let offset = 0; offset < ids.length; offset += 200) {
          const batch = ids.slice(offset, offset + 200)
          // a chat's rows are of both folders: each is asked for the same ids, and answers for its own
          for (const one of chat ? ['inbox', 'sent'] as const : [folder as 'inbox' | 'sent']) {
            const result = await refreshMailHistory(slug, one, batch, node)
            if (generation.current !== request) return
            const rows = historyPage(result)
            if (!Array.isArray(result?.refreshed_ids) || result.refreshed_ids.length !== batch.length
              || batch.some(id => !result.refreshed_ids!.includes(id))
              || folders.some(field => rows[field].some(m => !batch.includes(m.id)))) throw Error('Invalid mail refresh coverage')
            refreshed = merge(refreshed, rows)
          }
        }
        box = merge(refreshed, page)
      }
      setState(old => ({ ...old, identity, box,
        cursor: !before && old.identity === identity && old.paged ? old.cursor : page.next_cursor ?? null,
        paged: !!before || old.paged, ready: true, loading: false, error: null, errorStatus: null }))
    }).catch((e: Error) => {
      // the engine's own answer (an HTTP status) is told apart from a read that never got one
      const status = (e as { status?: unknown }).status
      if (generation.current === request) setState(old => ({ ...old, loading: false, error: e.message, errorStatus: typeof status === 'number' ? status : null }))
    }).finally(() => { if (generation.current === request) busy.current = false })
  // The request's identity, not the current rows, owns the response.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, node, folder, peer, identity])
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
  // `cursor` names the next page: it changes when a page has arrived, also when React drew the request and
  // its answer in one render (so `loading` was never seen true)
  return { box, hasMore: !!current.cursor, cursor: current.cursor, loading: current.loading, error: current.error,
    /** the HTTP status of the failed read, when the engine answered it; null for a read that got no answer */
    errorStatus: current.errorStatus,
    /** the first read has answered */
    ready: current.ready, loadMore, retry, remove, acknowledge }
}
