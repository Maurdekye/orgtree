import { fileBase } from '../api'
import { useRecordHistory } from '../recordpanelhooks'
import { fmtFull } from '../timefmt'
import { EventCard, eventSurface } from '../events/card'
import { decodeEventRow } from '../events/decode'
import { AgentName, useAgentDirectory } from './identity'
import { tierLabel } from './shared'
import type { RefRoutes } from './reflinks'

export function HistoryView({ slug, nid, refs }: { slug: string; nid: string; refs?: RefRoutes }) {
  // The agent can keep acting while this panel is open; keep the history view
  // tied to the live record subscription (or its legacy poll).
  const history = useRecordHistory(slug, nid)
  return <AgentHistoryView slug={slug} nid={nid} refs={refs} history={history} />
}

export type AgentHistoryState = ReturnType<typeof useRecordHistory>

export function AgentHistoryView({ slug, nid, refs, history }: {
  slug: string
  nid: string
  refs?: RefRoutes
  history: AgentHistoryState
}) {
  const items = history.value
  const profile = 'operator'
  return (
    <div className="msgs" ref={history.ref} onFocusCapture={history.onFocus}>
      {history.error ? <div className="dim pad" role="alert">Could not load history. <button onClick={history.retry}>Retry</button></div>
        : items == null && <div className="dim pad">loading…</div>}
      {items?.length === 0 && <div className="dim pad">nothing recorded yet</div>}
      {items?.map((it, i) => {
        const text = String(it.detail.gist ?? it.detail.text ?? Object.entries(it.detail)
          .filter(([k]) => k !== 'gist').map(([k, v]) => `${k}=${v}`).join(' · '))
        const row = {...it, text}
        const decoded = decodeEventRow(row, profile)
        const surface = eventSurface(row, profile)
        return <div key={i} {...surface} className={(decoded.kind === 'legacy' ? 'hist-row ' : 'hist-event ') + surface.className}>
          {decoded.kind === 'legacy' ? <span className="dim">{fmtFull(it.at)}</span>
            : <header className="event-head"><span className="dim">{fmtFull(it.at)}</span>
              <EventCard part="header" row={row} profile={profile} org={slug}
                world={refs?.world} onOpen={refs?.onOpen} actor={id => <MailFrom from={id}/>} /></header>}
          {decoded.kind === 'legacy' ? <><b>{it.kind}</b><span className="dim hist-actor"><MailFrom from={it.actor}/></span><span>{text}</span></>
            : <EventCard part="body" row={row} profile={profile} org={slug} world={refs?.world} onOpen={refs?.onOpen}
                actor={id => <MailFrom from={id}/>} imgBase={fileBase(slug,nid)}/>}
        </div>
      })}
    </div>
  )
}

/** A mail sender's identity: its model chip and the route to its desk, or the
 * plain name when this surface cannot vouch for it. Facts by context. */
export function MailFrom({ from, nameClass }: { from: string; nameClass?: string }) {
  const dir = useAgentDirectory()
  const agent = from && !from.startsWith('@') ? dir?.resolve(from) : undefined
  const atDest = Boolean(dir?.destination) && dir!.destination === from
  if (!agent) return <b>{from}</b>
  const why = (agent.tier ? `${from} — current model, ${tierLabel(agent.tier)}.`
    : `${from} — current model not known.`)
    + (atDest ? ' This is its own desk.'
      : dir?.onFocus ? ' Go to its desk.' : '')
  return <AgentName id={from} tier={agent.tier} nameClass={nameClass}
    why={why} atDestination={atDest}
    onFocus={dir?.onFocus ? (id) => dir.onFocus!(id) : undefined} />
}
