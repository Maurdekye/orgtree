import { useMemo, useState, type ReactNode } from 'react'

// Structured view of a tool call's JSON input/output (docket item
// structured-rendering-of-tool-call-json-input-and): objects as key/value
// rows, nested containers indented and foldable, arrays as lists, strings
// with newlines as text blocks, a small "Raw" toggle for the JSON itself.
// Payloads over ROW_LIMIT rows or BYTE_LIMIT bytes start collapsed past the
// first level so a huge result never mounts a huge DOM.

export const ROW_LIMIT = 200
export const BYTE_LIMIT = 64 * 1024

type Json = unknown

const isContainer = (v: Json): v is Record<string, Json> | Json[] =>
  v !== null && typeof v === 'object'

/** Parse tool output text; only an object or array counts as structured. */
export function parseStructured(text: string | undefined | null): Json | undefined {
  if (!text) return undefined
  const s = text.trim()
  if (s[0] !== '{' && s[0] !== '[') return undefined
  try {
    const v = JSON.parse(s)
    return isContainer(v) ? v : undefined
  } catch { return undefined }
}

/** Rows a full expansion would mount (stops counting once past the limit). */
export function countRows(v: Json, cap = ROW_LIMIT + 1): number {
  let n = 0
  const walk = (x: Json) => {
    if (n > cap) return
    if (isContainer(x)) {
      for (const c of Array.isArray(x) ? x : Object.values(x)) { n++; walk(c) }
    }
  }
  walk(v)
  return n
}

function Scalar({ v }: { v: Json }) {
  if (v === null) return <span className="sj-null">null</span>
  if (typeof v === 'number') return <span className="sj-num">{String(v)}</span>
  if (typeof v === 'boolean') return <span className="sj-bool">{String(v)}</span>
  const s = String(v)
  if (s.includes('\n')) return <pre className="sj-text">{s}</pre>
  return <span className="sj-str">{s === '' ? '""' : s}</span>
}

function summary(v: Json): string {
  if (Array.isArray(v)) return `[${v.length}]`
  return `{${Object.keys(v as object).length}}`
}

function Row({ name, v, depth, collapseFrom }: {
  name: string; v: Json; depth: number; collapseFrom: number
}) {
  const container = isContainer(v)
  const empty = container && (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0)
  const [open, setOpen] = useState(depth < collapseFrom)
  if (!container || empty) {
    const multi = typeof v === 'string' && v.includes('\n')
    return <div className={'sj-row' + (multi ? ' sj-block' : '')}>
      <span className="sj-key">{name}</span>
      {empty ? <span className="dim">{Array.isArray(v) ? '[]' : '{}'}</span> : <Scalar v={v} />}
    </div>
  }
  return <div className="sj-group">
    <div className="sj-row sj-fold" onClick={() => setOpen(o => !o)} role="button"
      aria-expanded={open} title={open ? 'collapse' : 'expand'}>
      <span className="sj-caret">{open ? '▾' : '▸'}</span>
      <span className="sj-key">{name}</span>
      <span className="dim">{summary(v)}</span>
    </div>
    {open && <Children v={v} depth={depth + 1} collapseFrom={collapseFrom} />}
  </div>
}

function Children({ v, depth, collapseFrom }: { v: Json; depth: number; collapseFrom: number }) {
  const entries: [string, Json][] = Array.isArray(v)
    ? v.map((x, i) => [String(i), x]) : Object.entries(v as object)
  return <div className="sj-children">
    {entries.map(([k, x]) => <Row key={k} name={k} v={x} depth={depth} collapseFrom={collapseFrom} />)}
  </div>
}

/** Structured view with the Raw toggle. `raw` is what Raw shows. */
export function StructuredJson({ value, raw, rawText }: {
  value: Json; raw?: string; rawText?: () => string
}): ReactNode {
  const [showRaw, setShowRaw] = useState(false)
  const big = useMemo(() => {
    const rows = countRows(value)
    if (rows > ROW_LIMIT) return true
    return (raw?.length ?? JSON.stringify(value).length) > BYTE_LIMIT
  }, [value, raw])
  // normal payloads open every level; big ones only the first
  const collapseFrom = big ? 1 : Infinity
  return <div className="sj">
    <button className={'sj-raw' + (showRaw ? ' on' : '')} aria-pressed={showRaw}
      title={showRaw ? 'show structured view' : 'show raw JSON'}
      onClick={e => { e.stopPropagation(); setShowRaw(r => !r) }}>Raw</button>
    {showRaw
      ? <pre className="filepre respre sj-rawpre">{raw ?? rawText?.() ?? JSON.stringify(value, null, 2)}</pre>
      : <Children v={value} depth={0} collapseFrom={collapseFrom} />}
  </div>
}
