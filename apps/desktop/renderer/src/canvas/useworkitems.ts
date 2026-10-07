import { useCallback, useEffect, useRef, useState } from 'react'
import { getWorkPage } from '../api'
import { onLiveBump } from '../livebus'
import type { WorkItem, WorkItemsPayload } from '../types'
import type { WorkGroup, WorkPage, WorkPageOptions, WorkPaging } from '../workpages'
import type { PolledStatus } from './shared'

const loading: PolledStatus = { loading: true, failed: false, stale: false,
  unavailable: false, at: null, error: null }
type Pages = Partial<Record<WorkGroup, WorkPage>>
type State = { identity: string; scope: string; slug: string; value: WorkItemsPayload | null;
  pages: Pages; status: PolledStatus; loadingMore: boolean }

function payload(pages: Pages): WorkItemsPayload {
  const first = pages.items!
  const rows = Object.values(pages).flatMap(p => p.rows)
  return { items: first.rows, ...(pages.archived ? { archived: pages.archived.rows } : {}),
    ...(pages.backlogged ? { backlogged: pages.backlogged.rows } : {}),
    revision: first.revision, now: first.at, counts: first.counts, assigned_count:first.assigned_count,
    references: rows.map(({slug,title,parent,archived,status,rev,view_revision}) =>
      ({slug,title,parent,archived,status,rev,view_revision})),
    attention: rows.filter(row => row.manual_attention) }
}

export function useWorkItems(slug: string, archive = false, backlog = false,
                            ms = 5000, refreshKey: unknown = 0, options: WorkPageOptions = {}) {
  const scope = JSON.stringify([slug, options])
  const identity = JSON.stringify([scope, archive, backlog])
  const [state, setState] = useState<State>({identity,scope,slug,value:null,pages:{},status:loading,loadingMore:false})
  if (state.identity !== identity) {
    const pages: Pages = state.scope === scope ? {items:state.pages.items,
      ...(archive ? {archived:state.pages.archived} : {}),
      ...(backlog ? {backlogged:state.pages.backlogged} : {})} : {}
    for (const group of Object.keys(pages) as WorkGroup[]) if (!pages[group]) delete pages[group]
    setState({identity,scope,slug,value:pages.items ? payload(pages) : null,pages,status:loading,loadingMore:false})
  }
  const current = useRef(state)
  current.current = state
  const requestMore = useRef<() => void>(() => {})
  useEffect(() => {
    let dead = false, busy = false
    const groups: WorkGroup[] = ['items', ...(backlog ? ['backlogged' as const] : []), ...(archive ? ['archived' as const] : [])]
    const valid = () => !dead && current.current.identity === identity
    const run = async (more = false) => {
      if (busy || !valid()) return
      const old = current.current
      if (more && !Object.values(old.pages).some(p => p.next_offset !== null)) return
      busy = true
      if (more) setState(s => ({...s, loadingMore:true}))
      try {
        const pages: Pages = {}
        for (const group of groups) {
          const previous = old.pages[group]
          if (more && previous?.next_offset === null) { pages[group] = previous; continue }
          const offset = more ? previous?.next_offset ?? 0 : 0
          let page = await getWorkPage(slug,group,options,offset,more ? previous : pages.items)
          if (!valid()) return
          if (page.reset) throw new Error('The docket changed while paging; refresh to continue.')
          if (!more && previous?.revision === page.revision && previous.total === page.total
              && previous.rows.length > page.rows.length) {
            pages[group] = {...previous,counts:page.counts,totals:page.totals,matched:page.matched}
            continue
          }
          let rows = more && previous ? [...previous.rows,...page.rows] : page.rows
          // Refresh only pages this view has already asked to see. Never walk
          // unloaded pages just because a poll or live notification fired.
          const wanted = more ? rows.length : previous?.rows.length ?? 0
          while (!more && rows.length < wanted && page.next_offset !== null) {
            page = await getWorkPage(slug,group,options,page.next_offset,page)
            if (!valid()) return
            if (page.reset) throw new Error('The docket changed while paging; refresh to continue.')
            rows = [...rows,...page.rows]
          }
          pages[group] = {...page,rows:[...new Map(rows.map(r => [r.slug,r])).values()]}
        }
        if (!valid()) return
        const revisions = new Set(Object.values(pages).map(p => p.revision))
        if (revisions.size !== 1) throw new Error('The docket changed while paging; refresh to continue.')
        const next = {identity,scope,slug,pages,value:payload(pages),loadingMore:false,
          status:{loading:false,failed:false,stale:false,unavailable:false,at:Date.now(),error:null}}
        current.current = next
        setState(next)
      } catch (error) {
        if (valid()) setState(s => ({...s,loadingMore:false,status:{loading:false,failed:true,
          stale:s.value!==null,unavailable:s.value===null,at:s.status.at,
          error:error instanceof Error ? error.message : String(error)}}))
      } finally { busy = false }
    }
    requestMore.current = () => { void run(true) }
    void run()
    const timer = setInterval(() => { void run() },ms)
    const off = onLiveBump(() => { void run() })
    return () => { dead=true; clearInterval(timer); off() }
  },[identity,ms,refreshKey])
  const loadMore = useCallback(() => requestMore.current(),[])
  const answer = state.identity === identity ? state : {...state,value:null,pages:{},status:loading}
  const pages = Object.values(answer.pages)
  const paging: WorkPaging = {counts:answer.value?.counts,loadMore,more:pages.some(p=>p.next_offset!==null),loadingMore:answer.loadingMore,
    loaded:pages.reduce((n,p)=>n+p.rows.length,0),total:pages.reduce((n,p)=>n+p.total,0)}
  return {...answer,paging}
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
