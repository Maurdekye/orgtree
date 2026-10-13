import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { req } from '../api'

interface Output { output: string; truncated?: boolean; provider_truncated?: boolean }
export function ToolOutputDetails({ slug, nid, seq, tool, fallback, clipped, renderOutput }: {
  slug: string; nid: string; seq?: number; tool?: string | null; fallback: string;
  clipped?: boolean; renderOutput: (text: string) => ReactNode
}) {
  const [result, setResult] = useState<Output>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const identity = `${slug}\0${nid}\0${seq}\0${tool}`
  const [loadedIdentity, setLoadedIdentity] = useState('')
  useEffect(() => {
    setResult(undefined); setError(''); setLoadedIdentity('')
    if (seq === undefined || !tool) return
    let active = true
    const path = `/api/orgs/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nid)}/tooloutput/${seq}/${encodeURIComponent(tool)}`
    void req<Output>(path).then(value => {
      if (active) { setResult(value); setLoadedIdentity(identity) }
    }, reason => {
      if (active) { setError(reason instanceof Error ? reason.message : String(reason)); setLoadedIdentity(identity) }
    })
    return () => { active = false }
  }, [slug, nid, seq, tool, identity, retry])
  if (seq === undefined || !tool) return <>{renderOutput(fallback)}
    {clipped && <div className="dim">Only the clipped output was retained for this older call.</div>}</>
  if (loadedIdentity !== identity) return <div className="dim">Loading error output…</div>
  if (error) return <div role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>Retry</button></div>
  return <>{renderOutput(result?.output ?? '')}
    {result?.truncated && <div className="dim">output truncated at 1 MiB</div>}
    {result?.provider_truncated && <div className="dim">The provider supplied truncated output.</div>}</>
}
