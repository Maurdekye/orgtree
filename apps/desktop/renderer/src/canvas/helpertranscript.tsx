import { useEffect, useState } from 'react'
import { req } from '../api'
import type { ToolChip } from '../types'
import { StructuredJson } from './structuredjson'

export function hasHelperTranscript(tool: ToolChip): boolean {
  return tool.helper_transcript === true || /^(Agent|Task|subagent|invoke_subagent|browser_subagent|spawnAgent|spawn_agent|collaboration)$/.test(tool.name)
}

interface HelperTool { id?: string; name: string; input?: unknown; input_text?: string; result?: string; error?: boolean }
interface Snapshot {
  messages: Array<{ id: string; text?: string; thinking?: string; tools?: HelperTool[] }>
  live: boolean; note?: string; truncated?: boolean
}

/** Mounted only inside an expanded call. Native child details cannot recurse. */
export function HelperTranscript({ slug, nid, seq, tool }: {
  slug: string; nid: string; seq?: number; tool?: string | null
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    setSnapshot(undefined); setError('')
    if (seq === undefined || !tool) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = new AbortController()
    const path = `/api/orgs/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nid)}/helpertranscript/${seq}/${encodeURIComponent(tool)}`
    async function read() {
      const deadline = setTimeout(() => abort.abort(), 15000)
      try {
        const value = await req<Snapshot>(path, { signal: abort.signal })
        if (!active) return
        setSnapshot(value)
        if (value.live) timer = setTimeout(() => { void read() }, 750)
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      } finally { clearTimeout(deadline) }
    }
    void read()
    return () => { active = false; clearTimeout(timer); abort.abort() }
  }, [slug, nid, seq, tool, retry])
  return <section className="helper-transcript" aria-label="Helper transcript">
    <div className="helper-transcript-heading">Helper transcript{snapshot?.live && <span className="dim"> · live</span>}</div>
    {seq === undefined || !tool ? <div className="dim">A helper transcript was not retained for this older call.</div>
      : error ? <div role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>Retry</button></div>
      : !snapshot ? <div className="dim">Loading helper transcript…</div>
      : <>
        {snapshot.messages.map(message => <div className="helper-transcript-message" key={message.id}>
          {message.thinking && <details className="helper-thought"><summary>Thoughts</summary><div className="helper-prose">{message.thinking}</div></details>}
          {message.text && <div className="helper-prose">{message.text}</div>}
          {message.tools?.map((child, index) => <details className={'helper-tool' + (child.error ? ' terr' : '')} key={child.id ?? index}>
            <summary>{child.name}{child.error ? ' · error' : ''}</summary>
            {child.input !== undefined ? <StructuredJson value={child.input} /> : child.input_text && <pre className="filepre respre">{child.input_text}</pre>}
            {child.result !== undefined && <pre className="filepre respre">{child.result}</pre>}
          </details>)}
        </div>)}
        {snapshot.note && <div className="dim">{snapshot.note}</div>}
        {snapshot.truncated && <div className="dim">Some helper activity was omitted because the retained transcript reached its size limit.</div>}
        {!snapshot.messages.length && !snapshot.note && <div className="dim">{snapshot.live ? 'Waiting for helper transcript records…' : 'No helper transcript records were supplied.'}</div>}
      </>}
  </section>
}
