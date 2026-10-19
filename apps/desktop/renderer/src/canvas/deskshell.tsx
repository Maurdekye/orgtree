// deskshell.tsx — the frame both desks share (agent desk in desk.tsx,
// project desk in projectdesk.tsx): the tab strip, the header meta row and
// the presented-documents strip, step 1 of
// agent-desks-and-project-desks-share-one-common-d (user 2026-10-19).
// Presentational only: each desk keeps its own view state, counts and
// callbacks — nothing here owns state, so DeskChatInner's ownership
// invariants inside OwnedDeskChat are untouched.
import type { ReactNode } from 'react'
import PushPinIcon from '@mui/icons-material/PushPinOutlined'
import PushPinFilledIcon from '@mui/icons-material/PushPin'
import type { ToastFn } from '../types'
import { DocIcon, SettingsIcon } from '../icons'
import { PopoutWindowControls } from '../popout'
import { agentNavProps } from './agentnav'
import { AgentName } from './identity'
import { PinFrame } from './modalpin'
import type { PinRect } from './pins'
import { PresentationCard, recentDocumentChips } from './docs'

/** The one name a desk modal's title bar shows (step 3): the pin-window
 *  name, so a framed desk never repeats it in its own header. */
export function DeskModalName({ id, tier }: { id: string; tier?: string | null }) {
  return <AgentName id={id} tier={tier} nameClass="pinwin-name" />
}

/** A desk modal's title bar: the name, and the pin button while pinning is
 *  on offer. The temporary agent desk renders this as its head; the
 *  project desk's PinFrame bar carries the same name element. */
export function DeskTitleBar({ id, tier, onPin }: {
  id: string
  tier?: string | null
  onPin?: () => void
}) {
  return (
    <div className="tempdesk-head pinwin-title" data-copy-agent-name={id}>
      <DeskModalName id={id} tier={tier} />
      <span className="spacer" />
      {onPin && (
        <button className="tempdesk-pin pinwin-unpin" onClick={onPin}
          aria-label={`pin ${id}`} title={`pin ${id}'s desk as a window`}>
          <PushPinFilledIcon fontSize="inherit" />
        </button>
      )}
    </div>
  )
}

/** The framed-desk modal shell: PinFrame in its desk configuration — the
 *  temporary desk's panel type, one title bar carrying the desk's name,
 *  the desk inside bare. The project desk's modal is this; the temporary
 *  agent desk keeps its own frame (its borrow and focus semantics are
 *  desk-specific) and shares the title bar above instead. */
export function DeskModalShell({ kind, title, nodeId, tier, panel, close, pinElsewhere, children }: {
  kind: string
  title: string
  nodeId: string
  tier?: string | null
  panel: string
  close: () => void
  pinElsewhere?: (rect: PinRect) => void
  children: ReactNode
}) {
  return (
    <PinFrame kind={kind} title={title}
      restore={{ agent: nodeId }}
      panel={panel} close={close}
      deskTitle titleBar={<DeskModalName id={nodeId} tier={tier} />}
      pinElsewhere={pinElsewhere}>
      {children}
    </PinFrame>
  )
}

/** The desk header frame (.cc-head), step 2 of the same item: identity on
 *  the left, actions + tabs + pin/settings on the right, window controls
 *  outside the wrapping right span, meta rows below. Both desks render
 *  exactly this; only the slot contents differ. The left span carries the
 *  copy-agent-name marker and nav props for both kinds. */
export function DeskHead({ nodeId, left, actions, tabs, rightExtras, pin, settings, meta }: {
  nodeId: string
  left: ReactNode
  actions?: ReactNode
  tabs: ReactNode
  /** pop-out controls, whose conditions differ per host */
  rightExtras?: ReactNode
  pin?: { ariaLabel: string; onPin: () => void } | null
  settings?: { label: string; onConfig?: () => void } | null
  meta?: ReactNode
}) {
  return (
    <div className="cc-head">
      <div className="cc-head-top">
        {/* ⚠ MARKED UNCONDITIONALLY, unlike every other target. The scope
            predicate everywhere else is "the primary click navigates", and on
            the FOCUSED desk this name deliberately does not: `atDestination`
            makes it plain text, because the click would take you where you
            already are. But the desk header name is the surface the original
            ticket was filed about — "in Desk view the context menu on an
            agent's displayed name shows only Copy agent name" — so it is in
            scope by name, not by predicate, and the marker goes on the
            header region rather than on the name's navigating branch. */}
        <span className="cc-head-left" data-copy-agent-name={nodeId}
          {...agentNavProps(nodeId)}>
          {left}
        </span>
        <span className="spacer" aria-hidden="true" />
        <span className="cc-head-right">
          <span className="cc-actions">
            {actions}
          </span>
          {tabs}
          {rightExtras}
          {pin && (
            <button className="cc-icon cc-pin" aria-label={pin.ariaLabel}
              title="pin as a window — it stays put while the canvas moves"
              onClick={pin.onPin}>
              <PushPinIcon fontSize="inherit" />
            </button>
          )}
          {settings && (
            <button className="cc-icon" aria-label={`settings for ${settings.label}`}
              title={`settings for ${settings.label}`} onClick={settings.onConfig}>
              <SettingsIcon fontSize="inherit" />
            </button>
          )}
        </span>
        {/* Outside .cc-head-right on purpose: the header wraps at narrow
            widths and the window controls must not wrap with it. */}
        <PopoutWindowControls />
      </div>
      {meta}
    </div>
  )
}

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
