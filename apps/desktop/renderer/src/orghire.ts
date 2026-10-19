import { useEffect, useState } from 'react'
import { getOrgAccounts } from './api'
import { useAppValue } from './appfeed'
import { onLiveBump } from './livebus'

/** Org settings and staffing use these same engine-computed lane decisions.
 * They intentionally include signed-out lanes: lack of sign-in is a disabled
 * preview, not an org prohibition. Unknown/failed first reads preserve that
 * existing discovery policy. No account identities or auth state are cached.
 */
export function useOrgHireProviders(slug: string): ReadonlySet<string> | null {
  const providers = useAppValue('providers')
  const accounts = useAppValue('accounts')
  const [observed, setObserved] = useState<{ slug: string; allowed: Set<string> } | null>(null)
  useEffect(() => {
    let active = true, request = 0
    const load = () => {
      const current = ++request
      void getOrgAccounts(slug).then(result => {
        if (!active || current !== request || result.org !== slug || !Array.isArray(result.accounts)) return
        setObserved({ slug, allowed: new Set(result.accounts
          .filter(lane => lane.allowed && lane.enabled !== false).map(lane => lane.provider)) })
      }).catch(() => { /* retain the last observed permissions for this org */ })
    }
    load()
    const off = onLiveBump(load)
    return () => { active = false; off() }
  }, [slug, providers, accounts])
  // Even the first render after navigation cannot inherit another org's list.
  return observed?.slug === slug ? observed.allowed : null
}
