import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  /** the desk row's one-line input summary, the result's full line count and
   *  whether `result` is a clipped preview (engine helper_transcript.rs) */
  arg?: string; result_lines?: number; truncated?: boolean
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
      return { id: child.id, name: child.name, arg: child.arg, result: child.result,
        result_lines: child.result_lines, truncated: child.truncated,
        error: child.error ? typeof child.error === 'string' ? child.error : 'tool error' : undefined,
        started_at: child.started_at, ended_at: child.ended_at, writing_secs: child.writing_secs, task: child.task,
        retained_input: { input, note: input === undefined ? 'Input was not supplied in this helper snapshot.' : undefined } }
    }) }
}

/** Mounted only inside an expanded call. Native child details cannot recurse. */
export function HelperTranscript({ slug, nid, seq, tool, autoFollow = false }: {
  slug: string; nid: string; seq?: number; tool?: string | null; autoFollow?: boolean
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const folds = useFoldState()
  const section = useRef<HTMLElement>(null)
  const following = useRef(true)
  // TAIL FOLLOW IS RELEASED ONLY BY THE READER, as on the desk transcript
  // (desk.tsx noteScrollIntent/pin). A scroll event alone never releases it:
  // our own programmatic scroll's event can land after the next snapshot has
  // already grown the content, and reading that as "far from the bottom"
  // stuck a live 220-row transcript mid-stream with no input at all
  // (@build-sol capture 2026-11-10, gap 6939 px). Upward wheel/keys/touch or a
  // scrollbar drag release it; coming back down to the tail resumes it.
  const intent = useRef<{ direction: -1 | 1 | 0; until: number } | null>(null)
  const touchY = useRef<number | null>(null)
  const messages = useMemo(() => snapshot?.messages.map(retainedMessage) ?? [], [snapshot])
  useEffect(() => { folds.prune(foldKeysOf(messages)) }, [messages, folds.prune])
  const pin = () => { const el = section.current; if (el && following.current) el.scrollTop = el.scrollHeight }
  // After the commit, before paint: the new rows are in the DOM, so this
  // lands on the real bottom; one more frame covers late layout (Markdown).
  useLayoutEffect(() => {
    if (!autoFollow || !following.current) return
    pin()
    const frame = requestAnimationFrame(pin)
    return () => cancelAnimationFrame(frame)
  }, [snapshot, autoFollow])
  const noteIntent = (direction: -1 | 1 | 0) => {
    intent.current = { direction, until: performance.now() + 1000 }
    if (direction < 0) following.current = false
  }
  const onScroll = (el: HTMLElement) => {
    const recent = intent.current && performance.now() <= intent.current.until ? intent.current.direction : null
    const atTail = el.scrollHeight - el.scrollTop - el.clientHeight <= 8
    // a scrollbar drag (0) follows the thumb: off above the tail, on at it
    if (recent === 0) following.current = atTail
    else if (recent === 1 && atTail) following.current = true
  }
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
  return <section className="helper-transcript" aria-label="Helper transcript" ref={section}
    onScroll={autoFollow ? e => onScroll(e.currentTarget) : undefined}
    onWheel={autoFollow ? e => { if (e.deltaY) noteIntent(e.deltaY < 0 ? -1 : 1) } : undefined}
    onKeyDown={autoFollow ? e => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) noteIntent(-1)
      else if (['ArrowDown', 'PageDown', 'End'].includes(e.key)) noteIntent(1)
    } : undefined}
    onTouchStart={autoFollow ? e => { touchY.current = e.touches[0]?.clientY ?? null } : undefined}
    onTouchMove={autoFollow ? e => {
      const y = e.touches[0]?.clientY
      if (y !== undefined && touchY.current !== null && y !== touchY.current) noteIntent(y > touchY.current ? -1 : 1)
      if (y !== undefined) touchY.current = y
    } : undefined}
    onPointerDown={autoFollow ? e => {
      // a press on the section itself (not its content) is its scrollbar:
      // a drag up releases follow, a drag back to the tail resumes it
      if (e.target === e.currentTarget) noteIntent(0)
    } : undefined}>
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
