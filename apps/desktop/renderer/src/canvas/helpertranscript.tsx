import { useEffect, useMemo, useState } from 'react'
import { req } from '../api'
import type { ChatMessage, ToolChip } from '../types'
import { Msg } from './desk'
import { FoldProvider, foldKeysOf, useFoldState } from './foldstate'
import { TurnActiveContext } from './toolclock'

export function hasHelperTranscript(tool: ToolChip): boolean {
  return tool.helper_transcript === true || /^(Agent|Task|subagent|invoke_subagent|browser_subagent|spawnAgent|spawn_agent|collaboration)$/.test(tool.name)
}

interface HelperTool {
  id?: string; name: string; input?: unknown; input_text?: string; result?: string; error?: boolean | string
  started_at?: string; ended_at?: string; writing_secs?: number; task?: ToolChip['task']
}
interface HelperMessage {
  id: string; text?: string; thinking?: string; tools?: HelperTool[]
  content_blocks?: ChatMessage['content_blocks']; think_secs?: number
}
interface Snapshot {
  messages: HelperMessage[]
  live: boolean; note?: string; truncated?: boolean
}

function retainedMessage(message: HelperMessage): ChatMessage {
  return { role: 'assistant', row_id: message.id, thinking_event_id: message.id,
    text: message.text ?? '', thinking: message.thinking, think_secs: message.think_secs,
    content_blocks: message.content_blocks,
    tools: message.tools?.map(child => {
      let input = child.input !== undefined ? child.input : child.input_text
      if (child.input === undefined && child.input_text !== undefined) {
        try { input = JSON.parse(child.input_text) } catch { /* A clipped JSON prefix remains readable verbatim. */ }
      }
      return { id: child.id, name: child.name, result: child.result,
        error: child.error ? typeof child.error === 'string' ? child.error : 'tool error' : undefined,
        started_at: child.started_at, ended_at: child.ended_at, writing_secs: child.writing_secs, task: child.task,
        retained_input: { input, note: input === undefined ? 'Input was not supplied in this helper snapshot.' : undefined } }
    }) }
}

/** Mounted only inside an expanded call. Native child details cannot recurse. */
export function HelperTranscript({ slug, nid, seq, tool }: {
  slug: string; nid: string; seq?: number; tool?: string | null
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const folds = useFoldState()
  const messages = useMemo(() => snapshot?.messages.map(retainedMessage) ?? [], [snapshot])
  useEffect(() => { folds.prune(foldKeysOf(messages)) }, [messages, folds.prune])
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
        {/* Each helper owns its folds: native IDs never alias a parent or sibling.
            It has no parent turn clock; only supplied completed timings render. */}
        <FoldProvider value={folds.store}><TurnActiveContext.Provider value={false}>
          {messages.map(message => <div className="helper-transcript-message" key={message.row_id}>
            <Msg m={message} slug={slug} nid={nid} />
          </div>)}
        </TurnActiveContext.Provider></FoldProvider>
        {snapshot.note && <div className="dim">{snapshot.note}</div>}
        {snapshot.truncated && <div className="dim">Some helper activity was omitted because the retained transcript reached its size limit.</div>}
        {!snapshot.messages.length && !snapshot.note && <div className="dim">{snapshot.live ? 'Waiting for helper transcript records…' : 'No helper transcript records were supplied.'}</div>}
      </>}
  </section>
}
