// canvas/newproject.tsx — the "New project" form (docs/rust-engine/
// PROJECT-NODES.md): a name and an optional description for a project node
// under `parent` (an agent, a project, or the top level). The engine checks
// the name and the placement; a refusal is toasted by `op` and the form stays.

import { useEffect, useId, useRef, useState } from 'react'
import type { ToastFn } from '../types'
import { useEsc, USER } from './shared'
import type { OpFn } from './shared'
import { ModalOverPins } from './modalpin'

export function NewProjectModal({ parent, above, beside, op, toast, close }: {
  /** the parent node's id, or USER for the top level */
  parent: string
  /** instead: the node this project takes the place of, holding it */
  above?: string
  /** a side token's sibling slot: the project lands next to `anchor` on
   *  that side, the way a side hire does (the same follow-up reorder) */
  beside?: { anchor: string; side: 'left' | 'right' }
  op: OpFn
  toast: ToastFn
  close: () => void
}) {
  useEsc(close)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  useEffect(() => { nameRef.current?.focus() }, [])
  const where = above ? `above ${above}, holding it`
    : beside ? `beside ${beside.anchor}`
    : parent === USER ? 'at the top level' : `under ${parent}`
  const create = () => {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    op({ op: 'create_project', name: n, description: description.trim() || undefined,
         ...(above ? { above } : { parent: parent === USER ? 'user' : parent }) })
      .then(() => beside
        ? op({ op: 'reorder', node: n,
               ...(beside.side === 'left' ? { before: beside.anchor } : { after: beside.anchor }) })
            .catch(() => undefined)   // `op` toasts it; the project stands, last among its siblings
        : undefined)
      .then(() => { toast([`project ${n} created ${where}`]); close() })
      .catch(() => setBusy(false))
  }
  return (
    <ModalOverPins><div className="overlay" onClick={close} onPointerDown={(e) => e.stopPropagation()}>
      <div className="settings content-height confirm-box new-project" role="dialog" aria-modal="true"
        aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId}>New project {where}</h3>
        <div className="confirm-body">
          A project node stands for one project. It runs no turns and costs nothing: the agents under it
          work on it, report to the agent above it, and get its folder's AGENTS.md. Its mail goes to the
          agents that watch it with a fair-queue watchdog.
        </div>
        <label className="field">
          <span>Name</span>
          <input ref={nameRef} value={name} spellCheck={false} placeholder="e.g. website"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create() } }} />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea value={description} rows={3} placeholder="what the project is (optional)"
            onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="row">
          <button className="solid" disabled={!name.trim() || busy} onClick={create}>create</button>
          <button onClick={close}>cancel</button>
        </div>
      </div>
    </div></ModalOverPins>
  )
}
