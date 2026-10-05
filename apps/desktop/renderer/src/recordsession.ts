import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { RecordSession, SubscriptionInput } from './recordfeed'

/** App owns one controller per selected org. Panels consume its exact cursor
 * and overlapping sets; they neither open another socket nor fetch a baseline.
 */
export const OrgRecordContext = createContext<{ slug: string; session: RecordSession } | null>(null)
const emptySubscribe = () => () => {}
const emptySnapshot = () => null

export function useOrgRecords(slug: string) {
  const context = useContext(OrgRecordContext)
  const session = context?.slug === slug ? context.session : null
  return useSyncExternalStore(session?.listen ?? emptySubscribe, session?.getSnapshot ?? emptySnapshot)
}

/** Declarations, not prior membership. A changed declaration releases its set
 * before subscribing again; a late answer cannot restore the released set.
 */
export function useOrgRecordSubscription(slug: string, input: SubscriptionInput | null): boolean {
  const context = useContext(OrgRecordContext)
  const session = context?.slug === slug ? context.session : null
  const encoded = JSON.stringify(input)
  const [answer, setAnswer] = useState({ session, encoded, ready: false })
  const declaration = useMemo(() => JSON.parse(encoded) as SubscriptionInput | null, [encoded])
  useEffect(() => {
    if (!session || !declaration) return
    return session.subscribe(declaration, ready => setAnswer({ session, encoded, ready }))
  }, [session, declaration])
  return !!declaration && answer.session === session && answer.encoded === encoded && answer.ready
}
