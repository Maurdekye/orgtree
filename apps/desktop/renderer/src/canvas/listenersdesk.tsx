// canvas/listenersdesk.tsx — the project desk's LISTENERS tab (Orgtree
// 4.4.0; docket `project-event-listeners-sync-monitor-watchdogs-l`, user
// 2026-10-19). Shown while any project_listener or listener_watch dog
// targets the project. It lists the armed event listeners and listener
// watches (agent, dog, one-shot or continuous, the watch's count, and
// the tool calls a dog runs when it fires) from the tree's watchdogs,
// and carries the fire control: the same `fire_project_event` op the
// agents' `orgtree_project action=fire_event` runs, with an optional
// message for the listeners.

import { useState } from 'react'
import type { ToastFn, Watchdog } from '../types'
import { ago } from './shared'
import type { CanvasNode, OpFn } from './shared'
import { AgentLink, nodeTierOf } from './identity'
import { useDogRoute } from './deskdogs'
import { fireActionTools, projectListenerState } from './listeners'

export function ListenersView({ node, dogs, map, onJump, op, toast }: {
  node: CanvasNode; dogs: Watchdog[]; map: Map<string, CanvasNode>
  onJump?: (id: string) => void; op: OpFn; toast: ToastFn
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const route = useDogRoute()
  const state = projectListenerState(node.id, dogs)
  const live = node.state === 'live'
  const agentLink = (id: string) => <AgentLink id={id} tier={nodeTierOf(map.get(id))} onFocus={onJump} />
  const mode = (w: Watchdog) => w.once ? 'one-shot' : 'continuous'
  const dogButton = (w: Watchdog) => route
    ? <button type="button" className="listener-dog" title={`watchdog "${w.name}" (${w.kind}) — ${w.state}; click for detail`}
        onClick={() => route.open(w.id)}>{w.name}</button>
    : <span className="mono">{w.name}</span>
  const actions = (w: Watchdog) => {
    const tools = fireActionTools(w)
    return tools.length
      ? <span className="dim" title="tool calls this watchdog runs as its owner when it fires; results ride its fire mail">
          runs {tools.join(', ')} on fire</span>
      : null
  }
  const fire = () => {
    if (busy || !live) return
    setBusy(true)
    op({ op: 'fire_project_event', node: node.id, ...(text.trim() ? { body: text.trim() } : {}) })
      .then((r) => {
        const n = (r as { listeners_armed?: number }).listeners_armed ?? state.armed.length
        toast([`fired project ${node.id}'s event to ${n} listener${n === 1 ? '' : 's'}`])
        setText('')
      })
      .catch(() => {})   // `op` toasts the refusal
      .finally(() => setBusy(false))
  }
  return (
    <div className="desk-tabpanel project-listeners">
      <div className="listener-fire">
        <input type="text" value={text} disabled={!live || busy}
          placeholder={`message for ${node.id}'s listeners (optional)`}
          aria-label={`message for project ${node.id}'s event listeners`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); fire() } }} />
        <button type="button" className="primary" data-action="fire-event" disabled={!live || busy}
          title={`fire project ${node.id}'s event now: every armed project_listener on it receives it at once`}
          onClick={fire}>fire event</button>
      </div>
      <h4>Event listeners</h4>
      <div className="listeners-list">
        {state.listeners.length === 0 && <div className="dim">No agent listens on this project. An agent above or below it arms one
          with <code>orgtree_watchdog action=create kind=project_listener target={node.id} once=true</code> and is woken when the event fires.</div>}
        {state.listeners.map((w) => (
          <div key={w.id} className="listener-row">
            <span className="listener-agent">{agentLink(w.owner)}</span>
            {dogButton(w)}
            <span className="dim">{mode(w)}{w.state === 'paused' ? ' · paused' : ''}{w.notice ? ' · passive' : ''}</span>
            {actions(w)}
            <span className="spacer" />
            <span className="dim">{w.fired} fired{w.last_fired ? ` · last ${ago(w.last_fired)} ago` : ''}</span>
          </div>
        ))}
      </div>
      <h4>Listener watches</h4>
      <div className="listeners-watches">
        {state.watches.length === 0 && <div className="dim">No listener watch is armed. A watch fires when a set number of listeners
          are armed — with a fire action it releases the whole group at once:
          <code> orgtree_watchdog action=create kind=listener_watch target={node.id} count=N once=true</code>.</div>}
        {state.watches.map((w) => (
          <div key={w.id} className="listener-row">
            <span className="listener-agent">{agentLink(w.owner)}</span>
            {dogButton(w)}
            <span className="listener-count" title={`${state.armed.length} of ${w.count ?? '?'} event listeners armed`}>
              {state.armed.length}/{w.count ?? '?'}</span>
            <span className="dim">{mode(w)}{w.state === 'paused' ? ' · paused' : ''}{w.notice ? ' · passive' : ''}</span>
            {actions(w)}
            <span className="spacer" />
            <span className="dim">{w.fired} fired{w.last_fired ? ` · last ${ago(w.last_fired)} ago` : ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
