// canvas/newproject.tsx — the DRAFT project card (docs/rust-engine/
// PROJECT-NODES.md; user 2026-10-17 19:14Z: making a project by hand works
// like a manual hire). "New project…" and the project hire tokens open a
// draft card where the project will go, the camera walks to it, and the user
// gives it a name and a description there. The description is the project's
// standing charter: every agent under the project receives it.

import { useEffect, useState } from 'react'
import { CheckIcon, CloseIcon, FolderIcon } from '../icons'
import { NODE_H, NODE_W } from './shared'
import type { DraftState, Pt } from './shared'
import type { OpRequest } from '../types'
import { normalizeUserEnteredName } from './nameinput'

/** a project draft's `tier`: projects have no model */
export const PROJECT_DRAFT = 'project'

/** The ops that create the drafted project in its place: one create_project
 *  (under the draft's parent, at the top level, or above its anchor holding
 *  it), then for a side token the same reorder a side hire pins. */
export function projectDraftSteps(draft: DraftState, typed: string, description: string): OpRequest[] {
  // spaces become hyphens, as in a hire's name (user 2026-10-17 19:22:46Z)
  const name = normalizeUserEnteredName(typed)
  const create: OpRequest = { op: 'create_project', name,
    ...(description.trim() ? { description: description.trim() } : {}),
    ...(draft.above ? { above: draft.above.anchor } : { parent: draft.parent ?? 'user' }) }
  const b = draft.beside
  return b ? [create, { op: 'reorder', node: name, ...(b.side === 'left' ? { before: b.anchor } : { after: b.anchor }) }]
    : [create]
}

export function ProjectDraftNode({ pos, onConfirm, onCancel }: {
  pos: Pt
  onConfirm: (name: string, description: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  const ok = name.trim().length > 0
  const create = () => { if (ok) onConfirm(name.trim(), description.trim()) }
  return (
    <div className="sq draft project" style={{
      transform: `translate(${pos.x}px, ${pos.y}px)`, width: NODE_W, height: NODE_H,
    }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="draft-tag">new project</div>
      {/* the hire draft's counter-scaled form, with the folder mark in place
          of the tier token and no credit bar: a project is free */}
      <div className="draft-over" onWheel={(e) => e.stopPropagation()}>
        <div className="draft-inner">
          <div className="df-head">
            <span className="project-mark" title="project node: runs no turns, holds no credits">
              <FolderIcon fontSize="inherit" />
            </span>
            <input className="df-name" placeholder="project name…" value={name} spellCheck={false}
              // focus without scroll, as the hire draft does
              ref={(el) => {
                if (el && !el.dataset.f) {
                  el.dataset.f = '1'
                  el.focus({ preventScroll: true })
                }
              }}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ok) create() }} />
          </div>
          <div className="df-charter-wrap">
            <textarea className="df-charter"
              aria-label="Project Summary"
              placeholder="Summary (optional): what the project is. Every agent under it gets this as a standing charter."
              value={description} onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && ok) { e.preventDefault(); create() } }} />
          </div>
          <div className="df-foot">
            <span className="spacer" />
            <button onClick={onCancel}><CloseIcon fontSize="inherit" /> cancel</button>
            <button className="primary" disabled={!ok} onClick={create}
              title={ok ? undefined : 'give the project a name first'}>
              <CheckIcon fontSize="inherit" /> create</button>
          </div>
        </div>
      </div>
    </div>
  )
}
