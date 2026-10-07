import { useEffect, useState } from 'react'
import { req } from '../api'

export function formatToolInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const value = input as Record<string, unknown>
    const key = ['command', 'cmd', 'CommandLine'].find(k => typeof value[k] === 'string')
    if (key) {
      const rest = { ...value }
      delete rest[key]
      const options = Object.keys(rest).length ? `${JSON.stringify(rest, null, 2)}\n\n` : ''
      return `${options}${value[key]}`
    }
  }
  return JSON.stringify(input, null, 2) ?? String(input)
}

export function ToolInputDetails({ slug, nid, seq, tool }: {
  slug: string; nid: string; seq?: number; tool?: string | null
}) {
  const [result, setResult] = useState<{ input: unknown; note?: string }>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    setResult(undefined)
    setError('')
    if (seq === undefined || !tool) return
    let active = true
    const path = `/api/orgs/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nid)}/toolinput/${seq}/${encodeURIComponent(tool)}`
    void req<{ input: unknown; note?: string }>(path).then(
      value => { if (active) setResult(value) },
      reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) },
    )
    return () => { active = false }
  }, [slug, nid, seq, tool, retry])
  return <div className="toolinput">
    <div className="dim">Input</div>
    {seq === undefined || !tool ? <div className="dim">The full input was not retained for this older tool call.</div>
      : error ? <div role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>Retry</button></div>
      : !result ? <div className="dim">Loading input…</div>
      : <>
        <pre className="filepre respre">{formatToolInput(result.input)}</pre>
        {result.note && <div className="dim">{result.note} <button onClick={() => setRetry(n => n + 1)}>Retry</button></div>}
      </>}
  </div>
}
