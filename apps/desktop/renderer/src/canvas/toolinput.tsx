import { useEffect, useState } from 'react'
import { req } from '../api'
import { StructuredJson } from './structuredjson'

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

export function ToolInputDetails({ slug, nid, seq, tool, retained }: {
  slug: string; nid: string; seq?: number; tool?: string | null
  retained?: { input: unknown; note?: string }
}) {
  const [result, setResult] = useState<{ input: unknown; note?: string }>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    setResult(undefined)
    setError('')
    if (retained || seq === undefined || !tool) return
    let active = true
    const path = `/api/orgs/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nid)}/toolinput/${seq}/${encodeURIComponent(tool)}`
    void req<{ input: unknown; note?: string }>(path).then(
      value => { if (active) setResult(value) },
      reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) },
    )
    return () => { active = false }
  }, [slug, nid, seq, tool, retry, retained])
  const shown = retained ?? result
  return <div className="toolinput">
    {!retained && (seq === undefined || !tool) ? <div className="dim">The full input was not retained for this older tool call.</div>
      : error ? <div role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>Retry</button></div>
      : !shown ? <div className="dim">Loading input…</div>
      : <>
        {shown.input !== undefined && (shown.input !== null && typeof shown.input === 'object'
          ? <StructuredJson value={shown.input} rawText={() => formatToolInput(shown.input)} />
          : <pre className="filepre respre">{formatToolInput(shown.input)}</pre>)}
        {shown.note && <div className="dim">{shown.note} {!retained && <button onClick={() => setRetry(n => n + 1)}>Retry</button>}</div>}
      </>}
  </div>
}
