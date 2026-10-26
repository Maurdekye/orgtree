import { useEffect, useState } from 'react'
import { req } from '../api'
import { fmtStamp } from '../timefmt'
import { HelperTranscript } from './helpertranscript'
import { ModalOverPins, PinFrame } from './modalpin'

export interface LiveHelper {
  id: string; harness: 'claude' | 'codex' | 'muse'; kind?: string | null
  description?: string | null; model?: string | null; started_at?: string
  status: string; live: boolean; background?: boolean; transcript: boolean
  seq?: number; tool?: string
}
export interface HelpersSnapshot { count: number; items: LiveHelper[]; truncated?: boolean }

/** One shared header action in every desk placement. Its temporary inspector
 * belongs to the originating desk; no saved window or historical session is opened. */
export function LiveHelpersBadge({ slug, nid, count = 0 }: { slug: string; nid: string; count?: number }) {
  const [open, setOpen] = useState(false)
  return <>
    {count > 0 && <button className="badge live-helpers-badge" title="Show live helper agents"
      aria-label={`${count} live helper${count === 1 ? '' : 's'}`} aria-expanded={open}
      onPointerDown={e => e.stopPropagation()} onClick={() => setOpen(true)}>
      {count} helper{count === 1 ? '' : 's'}
    </button>}
    {open && <LiveHelpersPanel slug={slug} nid={nid} count={count} close={() => setOpen(false)} />}
  </>
}

export function LiveHelpersPanel({ slug, nid, count, close }: {
  slug: string; nid: string; count: number; close: () => void
}) {
  const [data, setData] = useState<HelpersSnapshot>()
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const abort = new AbortController()
    async function read() {
      const deadline = setTimeout(() => abort.abort(), 15000)
      try {
        const next = await req<HelpersSnapshot>(`/api/orgs/${encodeURIComponent(slug)}/nodes/${encodeURIComponent(nid)}/helpers`, { signal: abort.signal })
        if (!active) return
        setData(next); setError('')
        if (next.count > 0) timer = setTimeout(() => { void read() }, 750)
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)) }
      finally { clearTimeout(deadline) }
    }
    void read()
    return () => { active = false; clearTimeout(timer); abort.abort() }
  }, [slug, nid, count, retry])
  const helpers = [...(data?.items ?? [])].sort((a,b) => Number(b.live)-Number(a.live) || (a.started_at ?? '').localeCompare(b.started_at ?? '') || a.id.localeCompare(b.id))
  const chosen = helpers.find(h => h.id === selected) ?? helpers[0]
  const harness = (h: LiveHelper) => ({ claude: 'Claude Code', codex: 'Codex', muse: 'Muse' })[h.harness]
  return <ModalOverPins><PinFrame kind={`live-helpers:${nid}`} title={`Helpers · ${nid}`}
    panel="settings live-helpers-panel" dialogLabel="Helper agents" close={close}
    pinnable={false} titleInModal closeInModal>
    <div className="live-helpers-body">
      <div className="dim">{data ? `${data.count} live helper${data.count === 1 ? '' : 's'}` : 'Loading helpers…'} · observed native activity</div>
      {error && <div role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>Retry</button></div>}
      {data?.truncated && <p role="status">Helper activity exceeded the 64-entry limit. This list and count cover retained identities only.</p>}
      {data && !helpers.length && <p>No helper agents are currently observed. Live helper detection is available for Claude Code, Codex and Muse; a zero count does not establish support for other harnesses.</p>}
      <div className="live-helpers-layout">
        <div className="live-helpers-list" aria-label="Helpers">
          {helpers.map(h => <button key={h.id} className={chosen?.id === h.id ? 'selected' : ''}
            aria-pressed={chosen?.id === h.id} onClick={() => setSelected(h.id)}>
            <strong>{h.description || h.kind || 'Helper agent'}</strong>
            <span>{harness(h)} · {h.live ? 'Running' : h.status}</span>
          </button>)}
        </div>
        {chosen && <section className="live-helper-details" aria-label="Helper details" key={chosen.id}>
          <h3>{chosen.description || chosen.kind || 'Helper agent'}</h3>
          <dl><dt>Type</dt><dd>{chosen.kind || 'Not reported'}</dd>
            <dt>Harness</dt><dd>{harness(chosen)}</dd>
            <dt>Model</dt><dd>{chosen.model || 'Not reported'}</dd>
            <dt>Observed start</dt><dd>{chosen.started_at ? fmtStamp(chosen.started_at) : 'Not reported'}</dd>
            <dt>Status</dt><dd>{chosen.live ? 'Running' : chosen.status}{chosen.background ? ' · background' : ''}</dd></dl>
          {chosen.transcript && chosen.seq !== undefined && chosen.tool
            ? <HelperTranscript slug={slug} nid={nid} seq={chosen.seq} tool={chosen.tool} autoFollow />
            : <p className="dim">{chosen.transcript ? 'Waiting for the retained helper call…' : `A live helper transcript is not available for this harness (${harness(chosen)}).`}</p>}
        </section>}
      </div>
    </div>
  </PinFrame></ModalOverPins>
}
