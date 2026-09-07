import { useEffect, useState } from 'react'
import { req } from './api'
import { PinFrame } from './canvas/modalpin'
import { DocumentDownload } from './canvas/download'
import { MockupOpen } from './canvas/docs'

type Collection = { id: string; label: string; needs_node: boolean }
type Sources = { collections: Collection[]; nodes: { id: string; state: string; generation: number }[] }
type Page = { items: Record<string, unknown>[]; total: number; next_cursor: string | null }
const text = (value: unknown) => typeof value === 'string' ? value : ''

export function HistoryBrowser({ slug, close }: { slug: string; close: () => void }) {
  const [sources, setSources] = useState<Sources | null>(null)
  const [section, setSection] = useState('user-mail')
  const [node, setNode] = useState('')
  const [cursors, setCursors] = useState([''])
  const [page, setPage] = useState<Page | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const needsNode = sources?.collections.find(c => c.id === section)?.needs_node
  useEffect(() => {
    let active = true
    setSources(null)
    req<Sources>(`/api/orgs/${encodeURIComponent(slug)}/history`).then(value => {
      if (active) { setSources(value); setNode(value.nodes[0]?.id ?? '') }
    }).catch(err => { if (active) setError(String(err)) })
    return () => { active = false }
  }, [slug])
  useEffect(() => {
    let active = true
    setPage(null); setError('')
    if (!sources || (needsNode && !node)) return
    const query = new URLSearchParams({ node, cursor: cursors[cursors.length - 1] ?? '', limit: '50' })
    req<Page>(`/api/orgs/${encodeURIComponent(slug)}/history/${section}?${query}`).then(value => {
      if (active) setPage(value)
    }).catch(err => { if (active) setError(String(err)) })
    return () => { active = false }
  }, [slug, sources, section, node, cursors, refresh, needsNode])
  const restart = () => { setCursors(['']); setRefresh(v => v + 1) }
  return <PinFrame kind="retained-history" title="History" panel="settings wide" close={close}>
    <h3>History</h3>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <label>Records <select aria-label="History records" value={section} onChange={e => {
        setSection(e.target.value); setCursors([''])
      }}>{sources?.collections.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
      {needsNode && <label>Agent <select aria-label="History agent" value={node} onChange={e => {
        setNode(e.target.value); setCursors([''])
      }}>{sources?.nodes.map(n => <option key={n.id} value={n.id}>{n.id}{n.state === 'live' ? '' : ` (${n.state})`}</option>)}</select></label>}
      <button onClick={restart}>Refresh</button>
      <button aria-label="Close history" onClick={close}>Close</button>
    </div>
    <p className="dim">Records are kept until manually removed. Newest entries appear first.</p>
    {error && <p role="alert">{error}</p>}
    {!error && !page && <p>{needsNode && !node ? 'No agents in this organization.' : 'Loading…'}</p>}
    {page && <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button disabled={cursors.length === 1} onClick={() => setCursors(c => c.slice(0, -1))}>Newer</button>
        <span>{page.total} records · page {cursors.length}</span>
        <button disabled={!page.next_cursor} onClick={() => setCursors(c => [...c, page.next_cursor!])}>Older</button>
      </div>
      {page.items.length === 0 && <p>No records in this collection.</p>}
      <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
        {page.items.map((row, i) => <HistoryEntry key={`${cursors.length}:${i}`} row={row} slug={slug} section={section} />)}
      </div>
    </>}
  </PinFrame>
}

function HistoryEntry({ row, slug, section }: { row: Record<string, unknown>; slug: string; section: string }) {
  const body = text(row.body) || text(row.text) || text(row.q) || text(row.gist)
  const title = text(row.title) || text(row.kind) || text(row.role) || text(row.op) || text(row.file) || 'Record'
  const actor = text(row.node) || text(row.from) || text(row.actor) || text(row.peer)
  return <details style={{ borderBottom: '1px solid var(--border, #555)', padding: '10px 0' }}>
    <summary style={{ cursor: 'pointer' }}>
      <strong>{title}</strong>{actor && ` · ${actor}`} · {text(row.at) || text(row.ts)}
      {body && <span className="dim"> · {body.slice(0, 120)}</span>}
    </summary>
    {section === 'documents' && text(row.id) && <div>
      <DocumentDownload slug={slug} id={text(row.id)} title={title} format={text(row.format)} />
      {row.format === 'html' && <MockupOpen slug={slug} docId={text(row.id)} />}
    </div>}
    {body && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>{body}</pre>}
    {text(row.a) && <pre style={{ whiteSpace: 'pre-wrap', font: 'inherit' }}>{text(row.a)}</pre>}
    {(!body || Boolean(row.detail) || Boolean(row.events)) && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(row.detail ?? row, null, 2)}</pre>}
  </details>
}
