import { useContext, useEffect, useMemo, useState } from 'react'
import { getEvents, getHistory, getInbox, getNodeInbox } from './api'
import { usePolled, usePolledStatus } from './canvas/shared'
import type { PolledStatus } from './canvas/shared'
import { OrgRecordContext, useOrgRecords, useOrgRecordSubscription } from './recordsession'
import { projectEvents, projectHistory, projectMailbox, projectUserInbox } from './recordpanels'
import { RecordPanelSelection } from './recordpanelselection'
import { resolveRecordSelection } from './recordtransport'
import type { EventsPayload } from './types'

export function useRecordsEnabled(slug: string): boolean {
  return useContext(OrgRecordContext)?.slug === slug
}

export function useRecordInbox(slug: string, refreshKey: unknown = 0) {
  const enabled = useRecordsEnabled(slug), view = useOrgRecords(slug)
  const legacy = usePolledStatus(() => getInbox(slug), [slug], 5000, refreshKey, !enabled)
  const value = useMemo(() => view ? projectUserInbox(view.records) : null, [view])
  const status = useMemo<PolledStatus>(() => ({ loading: !view, failed: false, stale: false,
    unavailable: false, at: view ? Date.now() : null, error: null }), [view])
  const context = useContext(OrgRecordContext)
  const reported = context?.slug === slug ? context.status : undefined
  return enabled ? { value, status: reported ? { ...reported,
    loading: !view && !reported.failed, stale: !!view && reported.failed,
    unavailable: !view && reported.failed } : status } : legacy
}

function usePanelAgent(slug: string, name: string) {
  const context = useContext(OrgRecordContext)
  const session = context?.slug === slug ? context.session : null
  const view = useOrgRecords(slug)
  const own = view ? JSON.stringify([view.cursor.org_uuid, view.cursor.incarnation]) : ''
  const [answer, setAnswer] = useState({ session, name, own: '', id: null as string | null })
  useEffect(() => {
    if (!session) return
    const selection = new RecordPanelSelection(session, name, request => resolveRecordSelection(slug, request),
      id => {
        const c = session.getSnapshot()?.cursor
        setAnswer({ session, name, own: c ? JSON.stringify([c.org_uuid, c.incarnation]) : '', id })
      })
    return () => selection.dispose()
  }, [session, slug, name])
  return answer.session === session && answer.name === name && answer.own === own ? answer.id : null
}

export function useRecordMailbox(slug: string, name: string) {
  const enabled = useRecordsEnabled(slug), agent = usePanelAgent(slug, name), view = useOrgRecords(slug)
  const ready = useOrgRecordSubscription(slug, agent ? { windows: [{ kind: 'agent_mail', agent }], agents: [agent] } : null)
  const legacy = usePolled(() => getNodeInbox(slug, name), [slug, name], 5000, 0, !enabled)
  const value = useMemo(() => view && agent && ready ? projectMailbox(view.records, view.runtime, agent) : null, [view, agent, ready])
  return enabled ? value : legacy
}

export function useRecordHistory(slug: string, name: string) {
  const enabled = useRecordsEnabled(slug), agent = usePanelAgent(slug, name), view = useOrgRecords(slug)
  const ready = useOrgRecordSubscription(slug, agent ? { windows: [{ kind: 'agent_history', agent }] } : null)
  const legacy = usePolled(() => getHistory(slug, name).then(r => r.items), [slug, name], 5000, 0, !enabled)
  const value = useMemo(() => view && agent && ready ? projectHistory(view.records, agent) : null, [view, agent, ready])
  return enabled ? value : legacy
}

export function useRecordEvents(slug: string, visible: boolean, full: boolean) {
  const enabled = useRecordsEnabled(slug), view = useOrgRecords(slug)
  const legacy = usePolled(() => visible ? getEvents(slug, full ? undefined : 300).then(r => r.events)
    : Promise.resolve(null), [slug, visible, full], 5000, 0, !enabled)
  const [search, setSearch] = useState<{ slug: string; rows: EventsPayload['events'] } | null>(null)
  useEffect(() => {
    if (!enabled || !visible || !full) { setSearch(null); return }
    let dead = false
    void getEvents(slug).then(r => { if (!dead) setSearch({ slug, rows: r.events }) }).catch(() => {})
    return () => { dead = true }
  }, [enabled, slug, visible, full])
  const rows = useMemo(() => view ? projectEvents(view.records).events : null, [view])
  return enabled ? !visible ? null : full ? search?.slug === slug ? search.rows : null : rows : legacy
}