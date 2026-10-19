import { useLayoutEffect, useRef } from 'react'

interface ReadableMail { id?: string; _wait?: boolean; _ask?: unknown }
type Reader = { owner: Window; flush: () => void }
const readers = new Set<Reader>()
const saving = new Set<{owner: Window; promise: Promise<unknown>}>()

function save(owner: Window, read: () => void | Promise<unknown>) {
  // Invoke synchronously: the optimistic read belongs to the leave commit.
  // Keep the actual promise after unmount so a subsequent native close waits
  // for reads already sent by a filter/tab change too.
  let result: void | Promise<unknown>
  try { result = read() } catch { return } // callers own their error UI
  const entry = {owner, promise: Promise.resolve(result)}
  saving.add(entry)
  void entry.promise.catch(() => {}).finally(() => saving.delete(entry))
}

/** Flush only committed reading panes, including reads already in flight.
 * With no owner, app shutdown includes adopted/pop-out documents too. */
export async function flushOpenedMail(owner?: Window): Promise<void> {
  for (const reader of readers) if (!owner || reader.owner === owner) reader.flush()
  await Promise.allSettled([...saving].filter(p => !owner || p.owner === owner).map(p => p.promise))
}

function waitFor(event: Event, owner?: Window) {
  const pending = flushOpenedMail(owner)
  const detail = (event as CustomEvent<{waitUntil?: (p: Promise<unknown>) => void}>).detail
  detail?.waitUntil?.(pending)
}

// A top-level renderer owns its React portals even when their DOM is adopted
// into another native document. App shutdown drains them all before its engine
// can stop; a single child close is document-scoped below.
if (typeof window !== 'undefined') {
  window.addEventListener('orgtree:before-exit', e => waitFor(e))
  window.addEventListener('orgtree:flush-mail-reads', e => waitFor(e))
}

/** One rule for every selection route: read each unread real mail whose body
 * stopped being displayed. Rendering new props never overwrites the prior
 * committed mail or its org-bound callback before it is acknowledged. */
export function useReadOnLeave<T extends ReadableMail>(scope: string, displayed: T[],
  read: ((mail: T) => void | Promise<unknown>) | undefined, owner: Window) {
  const committed = useRef<{scope: string; mails: Map<string, {mail: T; read: NonNullable<typeof read>; attempted: boolean}>}>(
    {scope, mails: new Map()})
  const reader = useRef<Reader>({owner, flush: () => {}})
  reader.current.owner = owner
  const leave = (item: {mail: T; read: NonNullable<typeof read>; attempted: boolean}) => {
    if (item.attempted || !item.mail._wait || item.mail._ask || !item.mail.id) return
    item.attempted = true
    save(reader.current.owner, () => item.read(item.mail))
  }
  reader.current.flush = () => { for (const item of committed.current.mails.values()) leave(item) }
  useLayoutEffect(() => {
    const previous = committed.current
    const next = new Map<string, {mail: T; read: NonNullable<typeof read>; attempted: boolean}>()
    if (read) for (const mail of displayed) {
      if (!mail.id || mail._ask) continue
      const old = previous.scope === scope ? previous.mails.get(mail.id) : undefined
      next.set(mail.id, {mail, read, attempted: old?.attempted ?? false})
    }
    committed.current = {scope, mails: next}
    for (const [id, item] of previous.mails) if (previous.scope !== scope || !next.has(id)) leave(item)
  })
  useLayoutEffect(() => {
    const current = reader.current
    readers.add(current)
    return () => { current.flush(); readers.delete(current) }
  }, [])
  useLayoutEffect(() => {
    const close = (event: Event) => waitFor(event, owner)
    owner.addEventListener('beforeunload', close)
    owner.addEventListener('pagehide', close)
    // The module's root-window handler already includes every child reader.
    if (owner !== window) {
      owner.addEventListener('orgtree:flush-mail-reads', close)
      owner.addEventListener('orgtree:before-exit', close)
    }
    return () => {
      owner.removeEventListener('beforeunload', close)
      owner.removeEventListener('pagehide', close)
      owner.removeEventListener('orgtree:flush-mail-reads', close)
      owner.removeEventListener('orgtree:before-exit', close)
    }
  }, [owner])
}
