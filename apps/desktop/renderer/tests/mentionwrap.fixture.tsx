import { AccountsPanel } from '../src/canvas/accounts'
import { RefChip, refToken, resolveRef, type RefWorld } from '../src/canvas/reflinks'
import { RefMdBody } from '../src/canvas/refmd'
import { WorkRefText, type MentionIndex, type TypedRef } from '../src/canvas/workrefs'

export const ticket = 'caption-placement-in-the-first-cut-of-the-introduction-tutorial'
export const title = 'Caption placement in the first cut of the introduction tutorial'
export const docTitle = 'A presentation describing every step of the initial tutorial recording'
export const refs: TypedRef[] = [
  { kind: 'item', org: 'wrap-fixture', id: ticket },
  { kind: 'doc', org: 'wrap-fixture', id: 'presentation-fixture' },
  { kind: 'app', org: 'wrap-fixture', id: 'app-fixture' },
  { kind: 'panel', org: 'wrap-fixture', id: 'panel-fixture' },
]
export const world: RefWorld = { org: 'wrap-fixture', items: new Map([[ticket, title]]), docs: new Map([['presentation-fixture', docTitle]]),
  refName: ref => ({ outcome: 'ready', label: ref.kind === 'item' ? title : ref.kind === 'doc' ? docTitle
    : ref.kind === 'app' ? 'An app with a deliberately long name for inline wrapping' : 'unbroken'.repeat(11),
    flare: ref.kind === 'item' ? { cls: 'status-in_progress', tip: 'In progress' }
      : ref.kind === 'doc' ? { cls: 'doc-new', tip: 'Unread' } : undefined }) }
export const index: MentionIndex = new Map([[ticket, { kind: 'item', slug: ticket, title, status: 'in_progress' }]])

export function WrapExamples({ open = (_id: string) => {} }: { open?: (id: string) => void }) {
  return <div id="wrap-examples" className="settings docket-modal" style={{ position: 'static', width: 740, maxWidth: 'none', padding: 20 }}>
    <h3>Object mentions within a sentence</h3>
    <div style={{ display: 'grid', gridTemplateColumns: '340px 340px', gap: 20 }}>
      <section id="react-links"><h4>Shared React links</h4>{refs.map(ref => <p className="wrap-row" key={ref.kind}>
        Before this link <RefChip r={resolveRef(ref, world)} onOpen={r => open(r.ref.id)} /> then the sentence continues.
      </p>)}</section>
      <section id="markdown-links"><h4>Rendered Markdown</h4><RefMdBody className="md" world={world} onOpen={r => open(r.ref.id)}
        html={{ __html: refs.map(ref => `<p class="wrap-row">Before this link ${refToken(ref)} then the sentence continues.</p>`).join('') }} />
      <h4>Docket title links</h4><p className="wrap-row" id="legacy-react">Before this link <WorkRefText text={ticket} index={index} onPick={open} /> then the sentence continues.</p>
      <RefMdBody className="md" world={world} mentions={{ index, onPick: open }} onOpen={r => open(r.ref.id)}
        html={{ __html: `<p class="wrap-row" id="legacy-md">Before this link ${ticket} then the sentence continues.</p>` }} /></section>
    </div>
  </div>
}

export function WrapSettings({ close = () => {} }: { close?: () => void }) {
  return <AccountsPanel initialTab="display" toast={() => {}} close={close} />
}

/** Entirely synthetic settings and app-feed transport, used by unit and pixels. */
export function installWrapBackend(epoch = 'wrap') {
  const sockets: Socket[] = [], writes: unknown[] = []
  let seq = 1, enabled: boolean | undefined
  const values = () => enabled === undefined ? {} : { wrap_object_mentions: { epoch, seq, value: enabled } }
  const snapshot = () => ({ type: 'app_snapshot', epoch, seq,
    registry: { type: 'registry_snapshot', epoch, cursor: { app_uuid: 'wrap', incarnation: 'fixture', rev: 1 }, records: [] },
    summaries: {}, notices: {}, runtime: { values: values(), orgs: {} } })
  class Socket {
    onmessage: ((event: { data: string }) => void) | null = null
    constructor(_url: string) { sockets.push(this); queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(snapshot()) })) }
    close() {}
  }
  const emit = (value: boolean) => { enabled = value; seq++; for (const s of sockets) s.onmessage?.({ data: JSON.stringify({ type: 'app_runtime', epoch, seq, values: values() }) }) }
  const empty = { providers: [], accounts: [], rows: [], items: [], entries: [], details: [], dirs: [], templates: [], folders: [], charters: [], counts: {}, models: [], tiers: [], version: 2, primary: { id: 'primary', signed_in: false }, keys: [], assignments: {}, harnesses: [] }
  const fetcher: typeof fetch = async (input, init) => {
    const p = new URL(String(input), 'http://wrap-fixture.invalid').pathname
    let data: unknown = empty
    if (p === '/api/app/records') data = snapshot()
    else if (p === '/api/app-settings/runtime') {
      if (init?.method === 'PUT') { const patch = JSON.parse(String(init.body)); writes.push(patch); emit(patch.wrap_object_mentions) }
      data = { wrap_object_mentions: enabled ?? false, warming_enabled: true, max_concurrent_turns: 4, enter_key_behavior: 'send' }
    } else if (p === '/api/defaults') data = { max_top_grant: 1000, default_top_grant: 20, compact_at: 0.8 }
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
  }
  return { Socket, fetcher, emit, writes }
}
