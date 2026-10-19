// deskshell.tsx — the frame both desks share (agent desk in desk.tsx,
// project desk in projectdesk.tsx): the tab strip, the header meta row and
// the presented-documents strip, step 1 of
// agent-desks-and-project-desks-share-one-common-d (user 2026-10-19).
// Presentational only: each desk keeps its own view state, counts and
// callbacks — nothing here owns state, so DeskChatInner's ownership
// invariants inside OwnedDeskChat are untouched.
import type { ReactNode } from 'react'
import type { ToastFn } from '../types'
import { DocIcon } from '../icons'
import { PresentationCard, recentDocumentChips } from './docs'

/** One tab on a desk. `id` is the stable route (data-tab); `label` is only
 *  what the button says (the project desk's desk tab says "summary"). */
export interface DeskTabDef {
  id: string
  label: ReactNode
  /** badge number; shown when > 0 unless showCount is false */
  count?: number
  /** extra class on the count chip (the agent desk's provider tint) */
  countClass?: string
  showCount?: boolean
}

/** The .cc-tabs strip, identical on both desks: one button per tab with an
 *  optional count chip. `onShow` carries each desk's own reveal-then-
 *  setView logic (revealAgentPanelTab first). */
export function DeskTabs({ tabs, shown, onShow }: {
  tabs: DeskTabDef[]
  shown: string
  onShow: (id: string) => void
}) {
  return (
    <span className="cc-tabs">
      {tabs.map((t) => (
        <button key={t.id} data-tab={t.id} className={shown === t.id ? 'on' : ''}
          onClick={() => onShow(t.id)}>
          {t.label}{(t.count ?? 0) > 0 && t.showCount !== false
            ? <>{' '}<span className={'tab-count' + (t.countClass ? ' ' + t.countClass : '')}>
                {t.count}</span></>
            : ''}
        </button>
      ))}
    </span>
  )
}

/** A header meta row (.cc-head-meta): the chips/status rows under the
 *  identity line on both desks. Contents stay per-desk; the row is shared. */
export function DeskMetaRow({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={'cc-head-meta' + (className ? ' ' + className : '')}>{children}</div>
}

type DeskDocs = Parameters<typeof recentDocumentChips>[0]
type DeskDoc = ReturnType<typeof recentDocumentChips>[number]

/** The presented-documents strip under the header (FR-03): one card per
 *  recent presentation. The agent desk passes its own documents, the
 *  project desk its subtree's; the strip itself is the same. */
export function DeskDocsStrip({ slug, docs, toast, onOpen, onReply, replyLabel }: {
  slug: string
  docs: DeskDocs
  toast: ToastFn
  onOpen: (id: string) => void
  onReply?: (doc: DeskDoc) => void
  replyLabel?: string
}) {
  return (
    <div className="desk-docs">
      {recentDocumentChips(docs).map((d) => (
        <PresentationCard key={d.id} slug={slug} doc={d} toast={toast}
          className="doc-badge" direct onOpen={onOpen}
          onReply={onReply ? () => onReply(d) : undefined} replyLabel={replyLabel}>
          <DocIcon fontSize="inherit" /><span>{d.title}</span>
        </PresentationCard>
      ))}
    </div>
  )
}
