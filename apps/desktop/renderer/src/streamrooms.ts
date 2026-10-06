// Transcript rooms (Orgtree 4 engine): an agent's live stream frames — token
// deltas, thinking, tool rows, steered mail — reach only the windows that
// watch that agent. A window watches every node whose conversation it has on
// screen: each mounted conversation view joins its node's room, and the set is
// sent over the org socket whenever it changes and again on every reconnect.

type Send = (msg: unknown) => void

/** slug → node → mounted conversation views */
const watched = new Map<string, Map<string, number>>()
const senders = new Map<string, Send>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function flush(slug: string): void {
  timers.delete(slug)
  const send = senders.get(slug)
  if (!send) return
  send({ type: 'watch', agents: [...(watched.get(slug)?.keys() ?? [])] })
}

/** Coalesce a burst of mounts (opening a desk mounts several views). */
function schedule(slug: string): void {
  if (timers.has(slug)) return
  timers.set(slug, setTimeout(() => flush(slug), 30))
}

/** A conversation view of `nid` mounted; the returned function unmounts it. */
export function watchNode(slug: string, nid: string): () => void {
  let nodes = watched.get(slug)
  if (!nodes) { nodes = new Map(); watched.set(slug, nodes) }
  nodes.set(nid, (nodes.get(nid) ?? 0) + 1)
  schedule(slug)
  let done = false
  return () => {
    if (done) return
    done = true
    const cur = watched.get(slug)
    if (!cur) return
    const left = (cur.get(nid) ?? 1) - 1
    if (left > 0) cur.set(nid, left)
    else cur.delete(nid)
    schedule(slug)
  }
}

/** The org socket opened (`send`) or went away (`null`). An open socket is
 *  told the current set at once: rooms are per connection on the engine. */
export function bindRoomSocket(slug: string, send: Send | null): void {
  if (send) {
    senders.set(slug, send)
    flush(slug)
  } else {
    senders.delete(slug)
  }
}
