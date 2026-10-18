import { useEffect, useState } from 'react'
import { getOrgPicture } from '../api'
import './orgheaderlogo.css'

/** The canonical cropped org logo, keyed by its pushed revision. Returning
 * null leaves the title's original spacing intact when no image is available. */
export function OrgHeaderLogo({ slug, revision }: {
  slug?: string
  revision?: string | null
}) {
  const [loaded, setLoaded] = useState<{
    slug: string; revision: string; data: string | null
  } | null>(null)
  useEffect(() => {
    let current = true
    if (slug && revision) {
      getOrgPicture(slug).then(result => {
        if (current) setLoaded({ slug, revision, data: result.picture?.data ?? null })
      }).catch(() => {
        if (current) setLoaded({ slug, revision, data: null })
      })
    }
    return () => { current = false }
  }, [slug, revision])
  if (!slug || !revision || loaded?.slug !== slug
      || loaded.revision !== revision || !loaded.data) return null
  return <img className="org-header-logo" src={`data:image/png;base64,${loaded.data}`}
    alt="" aria-hidden="true" draggable={false} />
}
