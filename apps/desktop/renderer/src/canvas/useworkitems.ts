import { useEffect, useRef, useState } from 'react'
import { getForegroundWorkItems } from '../api'
import { onLiveBump } from '../livebus'
import type { WorkItem, WorkItemsPayload } from '../types'
import type { PolledStatus } from './shared'

const loading: PolledStatus = { loading: true, failed: false, stale: false,
  unavailable: false, at: null, error: null }

/** Release disabled groups, including their references, before another fetch
 * can fail or complete. Only the selected pane may retain a hidden row. */
function enabled(body: WorkItemsPayload | null, archive: boolean, backlog: boolean) {
  if (!body) return null
  const { archived, backlogged, references, ...rest } = body
  const visible = new Set([...body.items,
    ...(archive ? archived ?? [] : []), ...(backlog ? backlogged ?? [] : [])].map(it => it.slug))
  return { ...rest, ...(archive && archived ? { archived } : {}),
    ...(backlog && backlogged ? { backlogged } : {}),
    references: references?.filter(it => visible.has(it.slug)) }
}

export function useWorkItems(slug: string, archive = false, backlog = false,
                             ms = 5000, refreshKey: unknown = 0) {
  const identity = JSON.stringify([slug, archive, backlog])
  const [state, setState] = useState<{ identity: string; slug: string;
    value: WorkItemsPayload | null; status: PolledStatus }>(
    { identity, slug, value: null, status: loading })
  // A render-time adjustment prevents even one frame with another org's data,
  // and drops the actual stored archive rather than just hiding its rows.
  if (state.identity !== identity) {
    setState({ identity, slug, value: state.slug === slug
      ? enabled(state.value, archive, backlog) : null, status: loading })
  }
  const current = useRef(identity)
  current.current = identity
  useEffect(() => {
    let dead = false
    let issued = 0
    let accepted = 0
    const tick = () => {
      const seq = ++issued
      void getForegroundWorkItems(slug, archive, backlog).then(value => {
        if (dead || current.current !== identity || seq < accepted) return
        accepted = seq
        setState({ identity, slug, value: enabled(value, archive, backlog),
          status: { loading: false, failed: false, stale: false,
            unavailable: false, at: Date.now(), error: null } })
      }, error => {
        if (dead || current.current !== identity || seq < accepted) return
        accepted = seq
        setState(old => ({ ...old, status: { loading: false, failed: true,
          stale: old.value !== null, unavailable: old.value === null,
          at: old.status.at, error: error instanceof Error ? error.message : String(error) } }))
      })
    }
    tick()
    const timer = setInterval(tick, ms)
    const off = onLiveBump(tick)
    return () => { dead = true; clearInterval(timer); off() }
  }, [identity, ms, refreshKey])
  return state.identity === identity ? state : { ...state, value: null, status: loading }
}

/** Keep one selected hidden-group row, never an entire previously-open list.
 * Disappearing active rows and rows removed from an enabled group expire. */
export function useSelectedWork(scope: string, id: string | null,
                                current: WorkItem | undefined,
                                archive: boolean, backlog: boolean) {
  const retained = useRef<{ scope: string; item: WorkItem } | null>(null)
  if (current) retained.current = { scope, item: current }
  else {
    const old = retained.current
    if (!old || old.scope !== scope || old.item.slug !== id
        || !(old.item.archived ? !archive : old.item.status === 'backlogged' && !backlog)) {
      retained.current = null
    }
  }
  return current ?? retained.current?.item
}
