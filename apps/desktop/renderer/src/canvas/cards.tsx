// canvas/cards.tsx — the canvas's card components: the overseer eye
// (UserNode) with its switchboard (EyeDesk), the hire chips (SpawnChips),
// the drag-adjustable CreditBar, the draft/hiring card (DraftNode), and the
// agent card itself (NodeSquare). Extracted verbatim from Canvas.tsx in the
// phase-3 split.

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ToastFn, TreePayload } from '../types'
import { audienceAction, dissolveAll, getCharters, unstickNode } from '../api'
// §4.8 — a card is drawn straight from its tree entry and cannot await a
// fetch, so anything it decides about an ARCHIVED seat reads the summary
// marker when the full field is not there. Never dereference `lineage` or
// `scope` here directly.
import { lineageCount, readOnlyAgent } from '../archived'
import { accountTint } from '../accounttint'
import { THEMES } from '../themes'
import {
  CheckIcon, CloseIcon, DocketIcon, FocusIcon, FullscreenIcon, FrozenIcon, LayersIcon,
  LockIcon, MailIcon, PinIcon, RetireIcon, SettingsIcon, DocIcon,
} from '../icons'
import {
  ago, anyTierSeat, codexTierOffer, CODEX_TIER_LETTER, CODEX_TIER_SEAT, CODEX_TIERS, DESK_SCALE, deskDpi, DRAFT, familyOffer, fmtCredits, formatCount, freezeKind, FREEZE_LABEL_SHORT, ANTIGRAVITY_TIER_LETTER, ANTIGRAVITY_TIER_SEAT, ANTIGRAVITY_TIERS, isOpenRouterTier, NODE_H, NODE_W, openrouterTierIds, providerOf, queuedSwitchTitle, stateLabel, TIER_LETTER, TIER_SEAT, tierLabel, TIERS, unicodeLength, USER,
  USER_H, USER_W, useAgentShortcuts,
} from './shared'
import type {
  AttentionPip, CanvasNode, DraftScope, DraftState, HireState, MailLinkFn, OpFn, Pile,
  WorkLinkFn,
  Pt,
} from './shared'
import {
  AgentWorkstate, ContextWheel, deriveTurnState, isUsageFrozen, DeskChat, DestinationBusy, LastTurnAge,
  MapModeIndicator, MapTurnAge, RouteBadge,
} from './desk'
import { DocChips } from './docs'
import { useContextMenu } from './contextmenu'
import type { MenuEntry } from './contextmenu'
import { AgentRetireConfirm, agentMenuEntries } from './agentmenu'
import type { RetireKind } from './agentmenu'
import { useDeskActionsNow } from './deskhosts'
import { isMobile } from '../mobile'
import { AgentName } from './identity'
import { PinnedPlaceholder } from './pins'
import { ConfirmModal, DraftScopeModal } from './modals'

// ------------------------------------------------------------- the overseer
interface UserNodeProps {
  pos: Pt
  isDrop: boolean
  stats: { circ: number; seats: number; free: number }
  /** the inbox badge, already decided (D-169) — see `attentionPip` in
   *  canvas/shared.ts. Passed in rather than re-derived: several surfaces
   *  show it, and they used to each write the two-tier rule out by hand and
   *  drift apart on the tooltip. */
  pip: AttentionPip | null
  seats: Record<string, number>
  codexHire?: HireState | null
  antigravityHire?: HireState | null
  claudeHire?: HireState | null
  openrouterHire?: HireState | null
  /** D-199: route out of the no-harness state (opens the accounts panel). */
  onNoHarness?: () => void
  kiosk: TreePayload['kiosk']
  pub: boolean
  kioskRemaining: number | null
  kioskSegs?: { seat: number; grant: number }[]
  pxc: number
  zoom: number
  /** open the user's inbox. Reachable two ways (user 2026-09-11): the ✉ on
   *  the card, which appears only with agent-card shortcuts turned on, and
   *  the card's context menu, which does not depend on that setting. */
  onInbox?: () => void
  /** open GENERAL org settings — the whole modal, not one of its tabs (user
   *  ruling 2026-09-11). Absent on a public org, where that modal has no
   *  door at all; the ⚙ and the menu entry both disappear with it rather
   *  than becoming dead controls. */
  onGear?: () => void
  onSpawn: (tier: string) => void
  onMailLink: MailLinkFn
  onWorkLink: WorkLinkFn
  focused: boolean
  eyeW: number
  onFocus?: () => void
  posX: (id: string) => number
  onJump?: (id: string) => void
  map: Map<string, CanvasNode>
  op: OpFn
  slug: string
  toast: ToastFn
  compactAt?: number
  maxTop?: number
  /** FR-03: open a presented document in the in-page reader */
  onOpenDoc?: (id: string) => void
  /** per-node lineage/config for the switchboard panel headers (they mirror
   *  the desk header identically — user spec 2026-08-19) */
  onNodeLineage?: (id: string) => void
  onNodeConfig?: (id: string) => void
  /** pinned agents keep their tab but not a second chat — see EyeDeskProps */
  pinnedIds?: ReadonlySet<string>
  onShowPin?: (id: string) => void
}

export function UserNode({ pos, isDrop, stats, pip, seats, codexHire, claudeHire, onNoHarness,
  antigravityHire, openrouterHire,
  kiosk, pub, kioskRemaining, kioskSegs, pxc, zoom, onInbox, onGear, onSpawn,
  onMailLink, onWorkLink,
  focused, eyeW, onFocus, posX, onJump, map, op, slug, toast,
  compactAt, maxTop, onOpenDoc, onNodeLineage, onNodeConfig,
  pinnedIds, onShowPin }: UserNodeProps) {
  // the eye's hire chips collapse behind the same far-zoom ⋯ toggle as every
  // other node's (NodeSquare's expandedHireEdge) — the eye has one static
  // edge (soleHire), so a plain boolean stands in for that per-edge map.
  // Cleared on zoom change so a cluster can't be left floating after the
  // camera moves, same as NodeSquare.
  const [expandedHire, setExpandedHire] = useState(false)
  useEffect(() => { setExpandedHire(false) }, [zoom])
  // The ✉ and ⚙ came BACK on 2026-09-11, but conditionally: the user asked
  // for them "only when Show agent card shortcuts is enabled", and that
  // setting's default stays OFF. It is the SAME flag that governs every
  // agent card's hover row (`.sq-actions` in NodeSquare below) — one setting
  // for "show me the shortcut buttons", not a second one that could be set
  // differently and leave the reader wondering which card obeys which.
  const showShortcuts = useAgentShortcuts()
  const menu = useContextMenu()
  const [askingRetireAll, setAskingRetireAll] = useState(false)
  // ⚠ THE MENU IS THE UNCONDITIONAL ROUTE. The two buttons above are a
  // convenience that most readers will never switch on, so every action they
  // offer has to be reachable without them — otherwise turning the setting
  // off would silently remove capabilities rather than just tidying the card.
  // Retire-all is here and nowhere else on the canvas; its other door is the
  // Hire defaults tab in org settings.
  const menuEntries = (): MenuEntry[] => {
    const entries: MenuEntry[] = []
    if (onInbox) entries.push({ label: 'Open inbox', onSelect: () => onInbox() })
    if (onGear) {
      entries.push({ label: 'Org settings',
        title: 'the whole settings modal — hire defaults are a tab of it',
        onSelect: () => onGear() })
    }
    entries.push('sep', {
      label: 'Retire all agents…', danger: true,
      title: 'retires every agent in the org at once; context is kept',
      onSelect: () => setAskingRetireAll(true),
    })
    return entries
  }
  return (
    // the mail glow is GONE (user ruling 2026-08-04): unread mail keeps its
    // count badge; the only thing that glows anywhere is an agent that needs
    // the user's answer (see .asking), echoed by the header ask icon
    // static edge-b: the eye only has bottom chips, so the nearest-edge
    // gate always resolves to them
    <div className={'sq user edge-b' + (focused ? ' desk eyeboard' : '')
      + (isDrop ? ' drop' : '')}
      /* the eye's context menu — NOT at switchboard focus, character for
         character the rule NodeSquare uses for its own desk: the open
         surface has chat text, mail rows and its own controls, and a
         right-click there must keep the browser's or the row's menu. */
      onContextMenu={(e) => { if (!focused) menu.open(e, menuEntries) }}
      style={{
        transform: `translate(${pos.x}px, ${pos.y}px)`,
        width: focused ? eyeW : USER_W, height: USER_H,
        // symmetric expansion: the layout slot stays 124 wide, the card grows
        // both ways so the eye's center (and its edges) never move
        marginLeft: focused ? -(eyeW - USER_W) / 2 : 0,
        zIndex: focused ? 5 : undefined,
      }}
      // ROOT CAUSE (user bug 2026-09-03: "I can drag for a fraction of a
      // second, but my mouse lets go after only a few pixels of movement").
      // Unlike NodeSquare, the eye has no drag of its own to claim the
      // gesture for (it cannot be reparented), so this used to just track a
      // click-vs-drag threshold locally and call `onFocus` on release — and
      // stopped propagation getting there, unconditionally, for no reason
      // that behaviour needed. The eye sits centrally in the layout, a
      // natural place to grab to pan, and that stopPropagation killed the
      // pointerdown before it could ever reach the viewport's
      // background-pan handler: the camera never engaged, any apparent
      // motion was the settle/follow spring finishing on an unrelated
      // frame, and it flatlined the instant that settled — well before the
      // pointer stopped moving. Letting the gesture bubble is the fix, but
      // the viewport's onPointerDown also calls setPointerCapture on
      // itself, and once that capture is live this element's OWN
      // onPointerUp — a descendant of the capturing element — can never
      // fire again for this pointer. So the click-to-focus arbitration
      // moved to the viewport's onPointerUp (OrgCanvas.tsx), the same place
      // that already arbitrates a mobile tap; `onFocus` here now serves only
      // EyeDesk's "click empty desk space to recenter" below.
    >
      {/* the user's pool is infinite, so their bar fades out into the top
          instead of ending; hovering it reports the org's circulation
          (the tip is a sibling — the fade mask would swallow a child).
          It stays rendered at switchboard focus (user ruling): anchored to
          the card's left edge, it glides outward as the square expands. */}
      <div className="cbar-inf-wrap">
            <div className="cbar-infinite" />
            <div className="cbar-tip">
              {/* fmtCredits: these three are SUMS of per-node holdings, so
                  with a fractional seat in the org they are exactly where
                  float drift would surface (0.1 + 0.2 = 0.30000000000000004) */}
              <div>circulation <b className="n-fill">{fmtCredits(stats.circ)}</b></div>
              <div>seats <b className="n-seat">{fmtCredits(stats.seats)}</b></div>
              <div>free <b className="n-free">{fmtCredits(stats.free)}</b></div>
            </div>
          </div>
      <svg className="eye" viewBox="0 0 48 26">
        <path d="M 2 13 C 13 2, 35 2, 46 13 C 35 24, 13 24, 2 13 Z" />
        <circle className="iris" cx="24" cy="13" r="6.5" />
        <circle className="pupil" cx="24" cy="13" r="2.6" />
      </svg>
      {!focused && <div className="user-label">you</div>}
      {/* ⚠ STILL NOTHING ON THE SWITCHBOARD HEAD. The user had both icons
          removed from the zoomed-in view where the desks are (EyeDesk below)
          and that stands — these two are the OVERVIEW card's, and only with
          agent-card shortcuts turned on. The ⚙ opens GENERAL org settings,
          not the Hire defaults tab directly (user ruling 2026-09-11). */}
      {/* two-tier pip (user spec 2026-08-06): open asks outrank unread mail —
          the ask count wears the vibrant pulsing form, plain unread the
          muted one */}
      {!focused && showShortcuts && onInbox && <button className="eye-inbox"
        title={pip?.title ?? 'your inbox'} aria-label="your inbox"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onInbox() }}>
        <MailIcon fontSize="inherit" />
        {pip && <span className={'count' + (pip.urgent ? ' asks' : '')}>
          {pip.count}</span>}
      </button>}
      {!focused && showShortcuts && onGear && <button className="eye-gear"
        title="org settings" aria-label="org settings"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onGear() }}><SettingsIcon fontSize="inherit" /></button>}
      {/* real seat costs in the hover hints — a literal 0 was technically true
          (infinite pool) but read as wrong next to every other card. The
          chips survive switchboard focus too (user spec) — hiring is never
          out of reach. */}
      {/* soleHire: the eye carries no side or top sets (see the static edge-b
          above), so its subordinate badge stands alone and needs no role word
          to tell it apart from anything */}
      <SpawnChips onSpawn={onSpawn} free={kioskRemaining ?? Infinity} seats={seats}
        maxTier={kiosk?.max_tier} soleHire codexHire={codexHire}
        claudeHire={claudeHire} onNoHarness={onNoHarness}
        antigravityHire={antigravityHire} openrouterHire={openrouterHire}
        zoom={focused ? undefined : zoom} expanded={expandedHire}
        onToggleExpanded={() => setExpandedHire((v) => !v)} />
      {focused && (
        <EyeDesk map={map} op={op} slug={slug} toast={toast}
          /* `onFocus` IS `centerOn(USER)` — the very glide an unfocused eye
             gets from the click below. Re-centring is that same action asked
             for again, so it is the same callback, not a second one that
             could drift from it. */
          onRecenter={onFocus}
          pub={pub} eyeW={eyeW} posX={posX} onJump={onJump}
          compactAt={compactAt} maxTop={maxTop} pxc={pxc}
          onMailLink={onMailLink} onWorkLink={onWorkLink} onOpenDoc={onOpenDoc}
          onNodeLineage={onNodeLineage} onNodeConfig={onNodeConfig}
          pinnedIds={pinnedIds} onShowPin={onShowPin} />
      )}
      {menu.node}
      {/* The SAME confirmation and the SAME call the org-settings button
          makes — one action with two doors, not two implementations that
          could come to disagree about what "retire all" means. Portaled to
          <body> like NodeSquare's: this card lives inside the world
          transform, where a position:fixed dialog would resolve against the
          SCALED ancestor and render enormous. */}
      {askingRetireAll && createPortal(
        <ConfirmModal title="dissolve ALL agents?"
          body="Every agent in the entire org is retired at once. Context is kept; rehire brings any of them back."
          confirmLabel="dissolve all"
          onConfirm={() => dissolveAll(slug)
            .then((r) => toast([`dissolved ${r.nodes} node(s), freed ${fmtCredits(r.freed)} credits`]))
            .catch((e: Error) => toast([`error: ${e.message}`]))}
          close={() => setAskingRetireAll(false)} />, document.body)}
    </div>
  )
}

// ---------------------------------------------------------- the switchboard
// Focusing the eye opens SIDE-BY-SIDE live chats with every agent that has a
// direct line to the user — top-level agents plus user-audience holders
// (user spec). Tabs stay visible at all times; chats minimize/maximize to
// manage crowding. A line that exists via an audience grant carries an ✕:
// closing that tab RESCINDS the grant (top-level lines are permanent).
interface EyeDeskProps {
  map: Map<string, CanvasNode>
  op: OpFn
  slug: string
  toast: ToastFn
  pub: boolean
  eyeW: number
  posX: (id: string) => number
  onJump?: (id: string) => void
  compactAt?: number
  maxTop?: number
  pxc?: number
  onMailLink: MailLinkFn
  onWorkLink: WorkLinkFn
  /** FR-03: open a presented document in the in-page reader */
  onOpenDoc?: (id: string) => void
  /** the panel headers mirror the desk header identically (user spec
   *  2026-08-19) — the gen badge and the gear need the same per-node
   *  targets the full desk gets */
  onNodeLineage?: (id: string) => void
  onNodeConfig?: (id: string) => void
  /** user bug 2026-08-26: clicking a focused AGENT's desk re-centres the
   *  camera on it (`.desk-over`'s onClick, desk.tsx). The switchboard is the
   *  eye's desk and already wore the same `.desk-over` class — but it is
   *  built here, separately, and never got the same handler. So it re-centred
   *  only while it was NOT already focused. Same gesture, same result. */
  onRecenter?: () => void
  /** user ruling 2026-09-05: an agent PINNED to screenspace already has a live
   *  chat on screen, so the switchboard must not mount a SECOND one. Its tab
   *  stays in the row and raises the existing window instead. */
  pinnedIds?: ReadonlySet<string>
  onShowPin?: (id: string) => void
}

export function EyeDesk({ map, op, slug, toast,
  pub, eyeW, posX, onJump, compactAt, maxTop, pxc,
  onMailLink, onWorkLink, onOpenDoc, onNodeLineage, onNodeConfig, onRecenter,
  pinnedIds, onShowPin }: EyeDeskProps) {
  const isPinned = (id: string) => !!pinnedIds?.has(id)
  const agents = [...map.values()].filter((n) =>
    n.id !== USER && n.id !== DRAFT && n.state === 'live' && !n.isBearerOf
    && (n.parent === USER || n.audiences_held?.includes(USER)))
    // tab order mirrors the tree's left→right spatial order (user ruling)
    .sort((a, b) => (posX?.(a.id) ?? 0) - (posX?.(b.id) ?? 0))
  const [minned, setMinned] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('orgtree-eyemin-' + slug)
        || '[]') as string[])
    } catch { return new Set() }
  })
  const toggle = (id: string) => setMinned((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    localStorage.setItem('orgtree-eyemin-' + slug, JSON.stringify([...n]))
    return n
  })
  // №24: a NEW direct line arrives MINIMIZED with its tab lit — the shipped
  // coordinator charter grants an audience after every hire, and each grant
  // used to shove another full-width panel into the row automatically.
  // `seen` persists beside `min` (review): a bare ref only worked while
  // EyeDesk stayed mounted, so any grant landing with the camera away
  // rendered open anyway
  const seenIds = useRef<Set<string> | null>(null)
  if (seenIds.current === null) {
    try {
      const stored = localStorage.getItem('orgtree-eyeseen-' + slug)
      seenIds.current = stored ? new Set(JSON.parse(stored) as string[]) : null
    } catch { seenIds.current = null }
  }
  const idsKey = agents.map((a) => a.id).join(',')
  // Auto-open (user 2026-09-01, OPTIONAL and OFF by default): while the user
  // is actually AT the switchboard — this surface only mounts focused — a NEW
  // direct line (hired with a user audience, or an existing agent granted
  // one) may open its panel immediately instead of arriving minimized, IF one
  // more panel still fits without horizontal scrolling. The first effect run
  // after mount is the catch-up pass for lines that arrived while the camera
  // was away; those keep №24's arrive-minimized rule — "at the same time
  // they're hired" is the user's condition, and a mount is not that moment.
  const [autoOpen, setAutoOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('orgtree-eyeauto-' + slug) === '1' }
    catch { return false }
  })
  const liveRun = useRef(false)
  useEffect(() => {
    const ids = new Set(idsKey ? idsKey.split(',') : [])
    if (seenIds.current) {
      const fresh = [...ids].filter((id) => !seenIds.current!.has(id))
      if (fresh.length) {
        // №24's own minimums — 420px panel min-width, 10px gaps — measured
        // against the same inner width the row lays out in. Conservative on
        // purpose: auto-open must never CAUSE the scroll it is gated on.
        const openNow = agents.filter((a) => !fresh.includes(a.id)
          && !minned.has(a.id)).length
        const fits = (already: number) =>
          (already + 1) * 420 + already * 10 <= innerW - 24
        let opened = 0
        const toMin: string[] = []
        for (const id of fresh) {
          if (liveRun.current && autoOpen && fits(openNow + opened)) opened += 1
          else toMin.push(id)
        }
        if (toMin.length) {
          setMinned((s) => {
            const n = new Set(s)
            toMin.forEach((id) => n.add(id))
            localStorage.setItem('orgtree-eyemin-' + slug, JSON.stringify([...n]))
            return n
          })
        }
      }
    }
    liveRun.current = true
    seenIds.current = ids
    try {
      localStorage.setItem('orgtree-eyeseen-' + slug, JSON.stringify([...ids]))
    } catch { /* private mode */ }
    // agents/minned/innerW/autoOpen are read at the moment a NEW ID LANDS —
    // only the id set may trigger this, or every resize/toggle would re-run
    // the arrival rule on lines that already arrived
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, slug])
  // ⚠ PINNED IS A SEPARATE FILTER FROM `minned`, NOT A WRITE INTO IT. A pin
  // borrows the panel; it must not consume the reader's own open/minimized
  // choice, so unpinning restores exactly the tab state they left. The chat
  // itself is the same component either way and its draft and scroll are
  // persisted per node id (desk.tsx №2), not per surface.
  const open = agents.filter((a) => !minned.has(a.id) && !isPinned(a.id))
  // the inner virtual panel matches the card interior through the desk scale.
  // DESK_SCALE/deskDpi are shared so this stays in step with .desk-inner's
  // transform — the same equation used to be written out here AND in the CSS
  const innerW = Math.round((eyeW - 4) / (DESK_SCALE * deskDpi()))
  return (
    <div className="desk-over eye-desk" onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      /* recenter-on-click, character-for-character the guard `.desk-over`
         uses in desk.tsx — never steal a click meant for a control, never
         fight a text selection in progress. Deliberately ONE handler on the
         switchboard root rather than one per panel: the panels are `bare`
         (no overlay wrapper, by design — a second one would double-scale),
         so their clicks bubble to here and land on the eye, which is the
         focused thing. The per-agent jump stays reachable because it is a
         `button` (`.cc-name-jump`) and the guard excludes buttons. */
      onClick={(e) => {
        if ((e.target as Element).closest(
          'button, input, textarea, select, a, label, .mailrow, .eff-pop')) return
        if (window.getSelection()?.toString()) return
        onRecenter?.()
      }}>
      <div className="desk-inner desk-body eye-inner" style={{ width: innerW }}>
        {/* one row (user spec 2026-07-31): the "you · N direct lines" label
            was dead space — the TABS live in the head now, beside the eye */}
        <div className="eye-head">
          <svg className="eye eye-mini" viewBox="0 0 48 26">
            <path d="M 2 13 C 13 2, 35 2, 46 13 C 35 24, 13 24, 2 13 Z" />
            <circle className="iris" cx="24" cy="13" r="6.5" />
            <circle className="pupil" cx="24" cy="13" r="2.6" />
          </svg>
          <div className="eye-tabs">
          {agents.map((a) => (
            <span key={a.id} data-copy-agent-name={a.id} className={'eye-tab'
              + (isPinned(a.id) ? ' pinned' : minned.has(a.id) ? '' : ' on')}>
              {/* The tab name selects its panel. Agent navigation belongs
                  only to the separate jump button (user 2026-09-10). */}
              <button className="eye-tab-main" type="button"
                title={isPinned(a.id)
                  ? 'this chat is open in a pinned window — click to raise it'
                  : minned.has(a.id) ? 'open this chat' : 'minimize this chat'}
                onClick={() => isPinned(a.id) ? onShowPin?.(a.id) : toggle(a.id)}>
                <span className="eye-tab-id">
                  <AgentName id={a.id} tier={a.tier} />
                </span>
                {isPinned(a.id) && <PinIcon fontSize="inherit" />}
                {a.busy && <DestinationBusy tier={a.tier} />}
                {/* the unread count wears the TAB AGENT's provider — the same
                    hue as its working spinner beside it, never a global tint */}
                {(a.mail_pending ?? 0) > 0 &&
                  <b className={'eye-count prov-' + providerOf(a.tier ?? '')}>
                    {a.mail_pending}</b>}
                {/* a glyph of its own, or the control is an empty box for an
                    idle agent with no mail */}
                {!isPinned(a.id) &&
                  <FullscreenIcon className="eye-tab-panel-glyph" fontSize="inherit" />}
              </button>
              {onJump && <button className="eye-tab-jump" type="button"
                title={`jump to ${a.id}`} aria-label={`jump to ${a.id}`}
                onClick={() => onJump(a.id)}>
                <FocusIcon fontSize="inherit" />
              </button>}
              {/* ✕ only on audience-granted lines; closing RESCINDS the grant
                  (user spec) — top-level lines have no ✕, they are intrinsic */}
              {a.parent !== USER && a.audiences_held?.includes(USER) &&
                <button className="eye-tab-x"
                  title="close this line (rescinds its audience with you)"
                  onClick={() => audienceAction(slug, 'revoke', a.id, USER)
                    .then(() => toast([`audience ${a.id} → you rescinded`]))
                    .catch((e: Error) => toast([`error: ${e.message}`]))}>
                  <CloseIcon fontSize="inherit" /></button>}
            </span>
          ))}
          {!agents.length &&
            <span className="dim">no direct lines yet — top-level hires and user-audience holders appear here</span>}
          </div>
          {/* no spacer here (user bug 2026-08-05): .eye-tabs already has
              flex:1, and a second flex:1 sibling split the header 50/50 so
              the tab strip wrapped at half width */}
          <button className={'cc-icon eye-auto' + (autoOpen ? ' on' : '')}
            title={autoOpen
              ? 'auto-open new direct lines: on — a line hired with (or '
                + 'granted) a user audience opens its panel immediately '
                + 'while another panel still fits without scrolling; '
                + 'click to turn off'
              : 'auto-open new direct lines: off — new lines arrive as '
                + 'minimized tabs; click to turn on'}
            aria-pressed={autoOpen}
            onClick={() => setAutoOpen((v) => {
              const next = !v
              try {
                localStorage.setItem('orgtree-eyeauto-' + slug,
                  next ? '1' : '0')
              } catch { /* private mode */ }
              return next
            })}>auto</button>
          {/* the ✉ and ⚙ that sat here are gone — see UserNode above for
              where each capability lives now. `auto` is the only head
              control left, and it is not one of the two the user named. */}
        </div>
        <div className="eye-panels">
          {open.map((a) => (
            <div className="eye-panel" key={a.id}>
              <DeskChat node={a} map={map} op={op} slug={slug}
                toast={toast} pub={pub} bare compact compactAt={compactAt}
                onJump={onJump} maxTop={maxTop} pxc={pxc} onMailLink={onMailLink}
                onWorkLink={onWorkLink}
                onOpenDoc={onOpenDoc}
                onLineage={onNodeLineage ? () => onNodeLineage(a.id) : undefined}
                onConfig={onNodeConfig ? () => onNodeConfig(a.id) : undefined} />
            </div>
          ))}
          {/* the empty state has to name the RIGHT absence: "every chat is
              minimized" is a lie when they are pinned, and the reader would go
              looking for a tab to un-minimize that does not exist */}
          {!open.length && agents.length > 0 &&
            <div className="dim pad">{
              agents.every((a) => isPinned(a.id))
                ? 'every chat is open in a pinned window — click a tab to raise one'
                : agents.some((a) => isPinned(a.id))
                  ? 'every chat is minimized or pinned — click a tab above'
                  : 'every chat is minimized — click a tab above'
            }</div>}
        </div>
      </div>
    </div>
  )
}

interface SpawnChipsProps {
  onSpawn: (tier: string) => void
  free: number
  seats: Record<string, number>
  maxTier?: string | null
  /** F-03: render as a vertical column on this edge — the chips hire a
   *  COWORKER (same superior, placed to that side), not a report.
   *  FR-25: 'top' is the third variant — a horizontal row above the card
   *  whose hire SPLICES IN as the anchor's new superior. */
  side?: 'left' | 'right' | 'top'
  /** this is the ONLY hire badge on its card, so the tooltip drops the role
   *  word (user 2026-08-28: "under the overseer badge, where only the
   *  subordinate hire badges appear, make the text just say 'hire a haiku
   *  (-1)'"). The role exists to separate three badges sitting side by side;
   *  where one appears alone it names a choice that cannot be got wrong.
   *
   *  ⚠ Passed ONLY by UserNode, deliberately. The overseer is not the only
   *  card that shows a lone subordinate badge — the front of a CROWD pile is
   *  another (live leaf reports of a >8-report team; `pile` suppresses the
   *  side and top sets while the bottom set survives). The user described the
   *  overseer and justified it by the lone badge, and those are not the same
   *  predicate, so this implements what they asked for. If they later want it
   *  general, pass this at the crowd front too — one line, and this comment
   *  is why it was not done unasked. */
  soleHire?: boolean
  /** FR-15 M8: the codex family's hire state, from the /api/providers
   *  payload (threaded from OrgCanvas). undefined = payload not loaded —
   *  degrade to the disabled preview, never to hidden (`familyOffer`). */
  codexHire?: HireState | null
  /** D-189: the antigravity family's hire state, same contract. */
  antigravityHire?: HireState | null
  /** the OpenRouter family (2026-09-02), same contract; its TIERS come from
   *  the shared registry (`openrouterTierIds`), filled by the same payload */
  openrouterHire?: HireState | null
  /** D-199: ...and Claude's, which nothing used to ask for. Same contract:
   *  absent means "not known yet", not "not installed". */
  claudeHire?: HireState | null
  /** D-199: open the accounts panel — the route out of the no-harness state.
   *  Optional: a surface that cannot open it simply renders the badge inert
   *  rather than lying about being clickable. */
  onNoHarness?: () => void
  /** At far map zoom the screen-constant family cluster exceeds its card.
   *  Keep its provider/tier selection intact, but stage it behind one neutral
   *  outward-pointing control until the user asks to see it. */
  /** current canvas scale: compactness is a fit comparison, not a fixed zoom */
  zoom?: number
  expanded?: boolean
  onToggleExpanded?: () => void
}

function SpawnChips({ onSpawn, free, seats, maxTier, side, soleHire,
  codexHire, antigravityHire, claudeHire, openrouterHire, onNoHarness, zoom,
  expanded = false, onToggleExpanded }: SpawnChipsProps) {
  // kiosk tier cap (user spec): tokens above the cap DISAPPEAR entirely —
  // seat cost doubles as the tier rank, so the cap is a simple cost compare
  const shown = TIERS.filter((t) =>
    !maxTier || (seats[t] ?? 0) <= (seats[maxTier] ?? Infinity))
  const chip = (t: string, letter: string | undefined) => {
    const seat = seats[t] ?? anyTierSeat(t)
    const cant = Number.isFinite(free) && free < seat
    // the tooltip names the tier the way the user reads it everywhere else:
    // an OpenRouter favorite by its model (`claude-sonnet-5`), never by its
    // `or-…` tier id (user ask 2026-09-03)
    const name = tierLabel(t)
    return (
      <button key={t} disabled={cant} className={'t-' + t}
        title={cant
          // user report: an exhausted kiosk cap read as an opaque dead
          // end — the tooltip now carries the REMEDY, not just the number
          ? `${name}: needs ${fmtCredits(seat)} free (has ${fmtCredits(free)}) — the kiosk credit `
            + 'cap is fully held; drag an agent’s credit bar down '
            + 'or retire one to free credits'
          // ONE SHAPE FOR ALL THREE (user request 2026-08-28: "make them
          // more concise; just 3-5 words at most", "for subordinate,
          // superior, and coworker"). They were written at different times
          // and read like it: `hire a haiku (seat 1)` named no role at all,
          // the coworker one appended its placement, the superior one
          // explained the whole splice in twenty words. Now they are
          // `hire <a|an> <tier> <role>` and differ in exactly the one word
          // that differs in meaning — the role. Lowercase imperative to
          // match every other control tooltip on the card (`retire — …`,
          // `dissolve — …`), four words each.
          //
          // The seat cost rides along as `(-N)` — the user's own shape and
          // their own example, after they were asked whether losing it to
          // the word ceiling was acceptable and said it was not. The MINUS
          // is the point: it reads as what this costs you, where the older
          // `(seat 1)` read as a label. It is a suffix, not a word, so the
          // four-word phrase above stays exactly as it is rather than
          // being shortened to make room.
          // ...and where this is the only hire badge on the card, the role
          // word is dropped entirely — see `soleHire`. The cost badge
          // stays: it is the one part that still says something the user
          // cannot read off the badge's position.
          : `hire ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`
            + (soleHire ? ''
              : ` ${side === 'top' ? 'superior' : side ? 'coworker' : 'subordinate'}`)
            + ` (-${fmtCredits(seat)})`}
        onClick={(e) => { e.stopPropagation(); onSpawn(t) }}>
        {letter}
      </button>
    )
  }
  // D-199: one disabled chip, for a family that IS installed but signed out.
  // The reason is the payload's own (`run codex login`, `run claude once`),
  // so the remedy the user reads here is the remedy the accounts panel and
  // the server's refusal name too.
  const outChip = (t: string, letter: string | undefined, label: string,
                   reason: string | null, seat: number) => (
    <button key={t} disabled className={'t-' + t + ' codex-preview'}
      title={`${tierLabel(t)} — ${label}; `
        + (reason ?? 'hiring is not enabled yet') + ` (-${fmtCredits(seat)})`}>
      {letter}
    </button>
  )
  // PROVIDER ROWS (user spec 2026-08-28): each provider's chips on their own
  // row (own COLUMN on the coworker edges), the families sorted INWARD-TO-
  // OUTWARD by how many model tiers each has available, highest count
  // nearest the card (user refinement 2026-08-28: "sort the provider rows
  // inward-to-outward by number of available model tiers, highest to
  // lowest"). The same inward-first list rendered on opposite edges is what
  // makes top/bottom mirror about x and left/right about y — in DOM terms
  // the list is REVERSED exactly on the edges where "first" points away
  // (top's stack grows upward, left's grows outward).
  //
  // D-199: ONE RULE PER FAMILY, THE SAME ON EVERY STRIP. `familyOffer` decides
  // offer/disable/hide (shared.ts owns it; do not re-derive it here or in
  // anything wrapping this). What this replaced was three different rules:
  // codex and antigravity showed a disabled preview on the subordinate strip but
  // vanished from the side and top strips (`!side`), so one provider was
  // visible on one edge of a card and absent from another — and Claude was
  // never asked at all, which is the bug the user reported.
  //
  // The kiosk holdout is unchanged and still absolute: kiosks hold codex and
  // antigravity out entirely (user ruling — sandboxing unsettled), and the kiosk
  // cap is the one thing that sets maxTier, so it doubles as the kiosk test.
  const fams: { key: string; tiers: string[]; body: ReactNode }[] = []
  const fam = (key: string, tiers: string[], letters: Record<string, string>,
               label: string, hire: HireState | null | undefined,
               seatOf: (t: string) => number,
               kioskHeld = false): void => {
    if (kioskHeld) return
    // a family with no tiers has nothing to offer or to explain — only the
    // OpenRouter registry can be empty (no favorites picked yet), and an
    // empty row must not count as "a harness exists" for the no-harness
    // fallback below
    if (!tiers.length) return
    const offer = familyOffer(hire)
    if (offer === 'hide') return
    // a LEGACY codex token (gpt-reserve, item 12) is 'hide' from
    // `codexTierOffer` unconditionally: it is not a tier any more, and a
    // hidden tier leaves the row completely rather than sitting in it
    // disabled (user ruling 2026-09-02 — "dont just grey out the reserve
    // token. remove it entirely").
    const offerOf = (t: string) =>
      (key === 'codex' ? codexTierOffer(hire, t) : offer)
    // ⚠ FILTERED BEFORE `tiers` IS STORED, because the inward-first sort below
    // orders families by "number of available model tiers" — a hidden chip
    // that still counted would push Codex inward for a row it does not render.
    const vis = tiers.filter((t) => offerOf(t) !== 'hide')
    // every tier hid: the same nothing-to-offer case as an empty family above
    if (!vis.length) return
    fams.push({
      key, tiers: vis,
      body: vis.map((t) => (
        offerOf(t) === 'offer'
          ? chip(t, letters[t])
          : outChip(t, letters[t], label, hire?.reason ?? null, seatOf(t))
      )),
    })
  }
  // Claude's own list is the kiosk-capped `shown`, not the raw family: the cap
  // removes tiers, the offer rule removes families, and they compose.
  fam('claude', shown, TIER_LETTER, 'Claude', claudeHire,
      (t) => seats[t] ?? TIER_SEAT[t] ?? 0)
  fam('codex', CODEX_TIERS, CODEX_TIER_LETTER, 'Codex', codexHire,
      (t) => seats[t] ?? CODEX_TIER_SEAT[t] ?? 0, !!maxTier)
  fam('antigravity', ANTIGRAVITY_TIERS, ANTIGRAVITY_TIER_LETTER, 'Antigravity', antigravityHire,
      (t) => seats[t] ?? ANTIGRAVITY_TIER_SEAT[t] ?? 0, !!maxTier)
  // the OpenRouter family (2026-09-02): its tiers are the user's favorites,
  // read from the shared registry the providers payload fills; the letters
  // were written into TIER_LETTER by the same call. Kiosk-held like the
  // other non-Claude lanes until its sandboxing is settled.
  fam('openrouter', openrouterTierIds(), TIER_LETTER, 'OpenRouter',
      openrouterHire, (t) => seats[t] ?? anyTierSeat(t), !!maxTier)
  fams.sort((a, b) => b.tiers.length - a.tiers.length)   // inward-first
  const providersOff = [claudeHire, codexHire, antigravityHire, openrouterHire]
    .some((h) => h?.userEnabled === false)
  // D-199, the state a brand-new user on a fresh machine hits FIRST: no
  // provider is installed, so every family hid and the strip would render
  // empty. An empty hover strip is indistinguishable from a broken one, so
  // this says what happened and points at the one place that can fix it.
  // Deliberately a `fams` ENTRY rather than a branch around the strip: the
  // far-zoom compact control wraps whatever `fams` produced, so shaping the
  // empty state as a family means that control expands it like any other row
  // instead of collapsing to a dead arrow.
  if (!fams.length && !maxTier)
    fams.push({
      key: 'none', tiers: [],
      body: (
        <button className="hs-none" disabled={!onNoHarness}
          onClick={(e) => { e.stopPropagation(); onNoHarness?.() }}
          title={(providersOff
            ? 'agent providers are off in App settings → Providers'
            : 'no agent harness found on this machine — install or sign in '
              + 'to Claude Code, Codex or Antigravity')
            + (onNoHarness ? ' (opens App settings)' : '')}>
          {providersOff ? 'providers off' : 'no harness'}
        </button>
      ),
    })
  // ...and the residual case that is NOT the no-harness state: a kiosk whose
  // cap has excluded everything. There is nothing to say and nothing to open,
  // so leave the strip out entirely — a compact arrow with no hire choice
  // behind it is worse than an absent affordance.
  // Keep the hooks below unconditional: provider availability can change
  // after its payload loads, including into or out of this empty residual.
  const hasFamilies = fams.length > 0
  const away = side === 'top' || side === 'left'   // "first" points away
  if (away) fams.reverse()
  /* D-200 / user fit rule: counter-scaled badges retain their 22px screen
     width while the card gets narrower with zoom. Collapse only when the
     WIDEST provider row no longer fits inside the actual 124px node panel.
     `fams` is the provider gate's live result, so a one-provider machine gets
     its own later crossover and a no-harness row (tiers: []) never needlessly
     collapses.

     The two figures below mirror the shipped `.hsof button` width and
     `.hs-fam` gap. They are dimensions, not a zoom threshold. A 4px deadband
     avoids a wheel resting on the exact boundary making the control flicker:
     compact enters after a 4px overflow and exits after 4px of free room. */
  const HIRE_BUTTON_PX = 22, HIRE_GAP_PX = 4, FIT_DEADBAND_PX = 4
  const widestFamilyPx = Math.max(0, ...fams.map((f) =>
    f.tiers.length * HIRE_BUTTON_PX + Math.max(0, f.tiers.length - 1) * HIRE_GAP_PX))
  const fitDelta = (zoom == null ? Infinity : NODE_W * zoom - widestFamilyPx)
  const [farCompact, setFarCompact] = useState(() => fitDelta <= 0)
  useEffect(() => {
    setFarCompact((wasCompact) => wasCompact
      ? fitDelta < FIT_DEADBAND_PX
      : fitDelta <= -FIT_DEADBAND_PX)
  }, [fitDelta])
  if (!hasFamilies) return null
  const direction = side === 'left' ? '←' : side === 'right' ? '→'
    : side === 'top' ? '↑' : '↓'
  const rows = (!farCompact || expanded)
    ? fams.map((f) => <div className="hs-fam" key={f.key}>{f.body}</div>)
    : null
  const expand = farCompact && (
    <button className="hire-expand" type="button" aria-expanded={expanded}
      title={expanded ? 'hide hire tiers' : 'show hire tiers'}
      aria-label={expanded ? 'hide hire tiers' : 'show hire tiers'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onToggleExpanded?.() }}>
      {direction}
    </button>
  )
  return (
    <div className={'hsof' + (side ? ` side side-${side[0]}` : '')
      + (farCompact ? ' hire-compact' : '')
      + (farCompact && expanded ? ' is-expanded' : '')}
      onPointerDown={(e) => e.stopPropagation()}>
      {away && rows}
      {expand}
      {!away && rows}
    </div>
  )
}
// Every credit bar is DIRECTLY drag-adjustable (user ruling — no ± buttons):
// draft bars set the pending grant, live bars commit a reallocate on release.
// `min` floors a live bar at its committed amount; `max` caps at parent free.
// The bar spans seat+grant; the SEAT block sits at its foot (credits are
// incompressible — a node's whole holding is visible mass).
interface CreditBarProps {
  seat?: number
  grant: number
  committed: number
  segments?: { seat: number; grant: number }[]
  draftMode?: boolean
  min?: number
  max?: number
  maxGhost?: boolean
  onDragValue?: (v: number) => void   // draftMode: the pending grant
  onCommit?: (delta: number) => void  // live: reallocate on release
  zoom: number
  pxc: number
  capMode?: boolean
  /** F-05 counter-offer: the agent's CURRENT grant. The tip shows the offer's
   *  ±delta against it and an I-bar brackets the difference, so the size of
   *  the concession is visible rather than arithmetic. */
  baseline?: number
  /** draftMode drag released — the ask card runs its dry-run preview here */
  onRelease?: () => void
}

export function CreditBar({ seat = 0, grant, committed, segments = [], draftMode,
  min = 0, max, maxGhost, onDragValue, onCommit, zoom, pxc, capMode,
  baseline, onRelease }: CreditBarProps) {
  const [drag, setDrag] = useState<{ y0: number; g0: number; val: number } | null>(null)          // {y0, g0, val}
  const cur = drag && !draftMode ? drag.val : grant
  const seatLen = seat * pxc
  const len = Math.max(6, (seat + cur) * pxc)
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draftMode && !onCommit) return
    // §6 of the mobile spec: drag-to-reallocate is desktop-only by design —
    // precision is ~2px per credit and a finger cannot resolve one credit.
    // Touch devices get the ask card's stepper instead; the bar stays a
    // read-only gauge under a finger.
    if (isMobile) return
    e.stopPropagation(); e.preventDefault()
    setDrag({ y0: e.clientY, g0: grant, val: grant })
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return
    // mobile audit §3.2: a 6px dead zone before the drag stages anything —
    // without it any press that drifted a pixel past a rounding boundary
    // committed a live reallocation on release
    if (Math.abs(e.clientY - drag.y0) < 6) return
    const dg = (drag.y0 - e.clientY) / (pxc * zoom)
    // ⚠ CLAMP AFTER ROUNDING, and round the FLOOR up. Rounding last put the
    // value back below its own floor whenever `min` (the committed amount)
    // was fractional — a sub-$1 seat under this node is enough — so with a
    // grant of 104.2 a small UPWARD drag produced 104: an increase gesture
    // that shrinks the grant. `Math.ceil(min)` is the smallest WHOLE grant
    // that still covers what the children hold, which is the real floor now
    // that a grant is a whole number (user ruling 2026-09-04).
    const v = Math.min(max ?? Infinity,
      Math.max(Math.ceil(min), Math.round(drag.g0 + dg)))
    if (draftMode) onDragValue?.(v)
    else {
      setDrag((d) => d && { ...d, val: v })
      // the ask card mirrors the offer in realtime (user report 2026-08-05);
      // canvas bars pass no onDragValue and are untouched
      onDragValue?.(v)
    }
  }
  const end = () => {
    if (!drag) return
    const v = drag.val
    setDrag(null)
    if (!draftMode && v !== grant) onCommit?.(v - grant)
    if (draftMode) onRelease?.()
  }
  /* a UA-initiated cancel (touch scroll arbitration, capture loss) must
     ABORT the drag — routing it through `end` committed a live reallocation
     from a gesture the browser itself abandoned (mobile audit §0 class;
     endNodeDrag got this fix 2026-08-01, this bar was missed) */
  const cancel = () => {
    if (!drag) return
    onDragValue?.(drag.g0)
    setDrag(null)
  }
  // ruler rungs mark REAL quantities: every 5 credits, or every 25 when the
  // scale is too fine for 5s to resolve (user ruling — never equal-spaced fluff)
  const rung = (5 * pxc >= 4 ? 5 : 25) * pxc
  const delta = drag && !draftMode ? drag.val - drag.g0 : 0
  return (
    <div className={'cbar' + (draftMode || drag ? ' dragging' : '')}
      style={{
        height: len,
        background: `repeating-linear-gradient(to top,
          rgba(255,255,255,.07) 0, rgba(255,255,255,.07) 1px,
          transparent 1px, transparent ${rung}px), var(--input)`,
      }}
      onPointerDown={start} onPointerMove={move}
      onPointerUp={end} onPointerCancel={cancel}
      onWheel={(e) => e.stopPropagation()}>
      {/* while adjusting a non-top-level bar, a transparent ghost shows the
          ceiling the drag can reach (seat + grant + the parent's free) */}
      {(draftMode || drag) && maxGhost && Number.isFinite(max) &&
        <div className="cbar-max" style={{ height: Math.max(6, (seat + max!) * pxc) }} />}
      {/* inner layers live in a clip so they can never punch through the
          bar's rounded outline (border-box height overhang) */}
      <div className="cbar-clip">
        {/* corner rule (user ruling): square corners ONLY at the seat↔alloc
            junction — the fill's bottom is square iff a seat sits below it,
            and the seat's top is rounded iff no alloc sits above it */}
        <div className={'cbar-fill' + (seatLen > 0 ? '' : ' alone')} style={{
          bottom: seatLen,
          height: draftMode ? cur * pxc : committed * pxc,
        }} />
        {/* the fill is a stack of the children's holdings, one slab per hire —
            each child's SEAT is the darker band at its slab's foot (no divider
            inside a slab; the wash alone splits seat from grant). 1px grey
            hairlines part the own seat from the slabs, and slab from slab. */}
        {(() => {
          let cum = 0
          const out: ReactNode[] = []
          segments.forEach((s, i) => {
            out.push(<div key={'s' + i} className="cbar-subseat"
              style={{ bottom: seatLen + cum * pxc, height: s.seat * pxc }} />)
            cum += s.seat + s.grant
            if (i < segments.length - 1) out.push(<div key={'d' + i}
              className="cbar-div" style={{ bottom: seatLen + cum * pxc }} />)
          })
          return out
        })()}
        {seat > 0 &&
          <div className={'cbar-seat'
            + ((draftMode ? cur : committed) > 0 ? '' : ' crown')}
            style={{ height: seatLen }} />}
        {seat > 0 && cur > 0 && <div className="cbar-div" style={{ bottom: seatLen }} />}
      </div>
      {/* F-05: the I-bar spanning current grant → offered grant */}
      {baseline != null && cur !== baseline && (
        <div className={'cbar-ibar' + (cur < baseline ? ' down' : '')}
          style={{ bottom: seatLen + Math.min(baseline, cur) * pxc,
                   height: Math.max(2, Math.abs(cur - baseline) * pxc) }} />
      )}
      <div className="cbar-tip">
        {draftMode && baseline != null ? (
          /* the counter-offer tip: what is offered, vs what the agent holds */
          <>
            <div>offer <b className="n-fill">{fmtCredits(grant)}</b>
              {grant !== baseline && <span className={grant < baseline ? 'n-down' : 'dim'}>
                {' '}({grant > baseline ? '+' : ''}{fmtCredits(grant - baseline)})</span>}
            </div>
            <div className="dim">now <b>{fmtCredits(baseline)}</b></div>
          </>
        ) : draftMode ? (
          <>
            <div>grant <b className="n-fill">{fmtCredits(grant)}</b></div>
            <div className="dim">seat <b className="n-seat">{fmtCredits(seat)}</b></div>
          </>
        ) : capMode ? (
          /* the eye's kiosk bar: the same numbers wear their org-level names */
          <>
            <div>cap <b className="n-fill">{fmtCredits(cur)}</b>{delta !== 0 && <span className="dim"> ({delta > 0 ? '+' : ''}{fmtCredits(delta)})</span>}</div>
            <div>circulation <b className="n-fill">{fmtCredits(committed)}</b></div>
            <div>free <b className="n-free">{fmtCredits(cur - committed)}</b></div>
          </>
        ) : (
          <>
            <div>grant <b className="n-fill">{fmtCredits(cur)}</b>{delta !== 0 && <span className="dim"> ({delta > 0 ? '+' : ''}{fmtCredits(delta)})</span>}</div>
            <div>alloc <b className="n-fill">{fmtCredits(committed)}</b></div>
            <div>free <b className="n-free">{fmtCredits(cur - committed)}</b></div>
            <div className="dim">seat <b className="n-seat">{fmtCredits(seat)}</b></div>
          </>
        )}
      </div>
    </div>
  )
}

interface DraftNodeProps {
  pos: Pt
  draft: DraftState
  map: Map<string, CanvasNode>
  seats: Record<string, number>
  maxTop: number
  defaultTop: number
  kioskRemaining: number | null
  tree: TreePayload
  zoom: number
  pxc: number
  onConfirm: (name: string, grant: number, charter: string,
    scope: DraftScope | null) => void
  onCancel: () => void
}

type CharterPreset = {
  name: string; content: string; path: string
  chars?: number; truncated?: boolean
}

export function DraftNode({ pos, draft, map, seats, maxTop, defaultTop, kioskRemaining,
  tree, zoom, pxc, onConfirm, onCancel }: DraftNodeProps) {
  const [name, setName] = useState('')
  const [charter, setCharter] = useState('')
  // pre-hire permissions (user spec): configure the agent's dirs, tool
  // switches, MCP grants and visibility BEFORE hiring — no post-hire
  // adjustment needed. null = the org/parent defaults, untouched.
  const [scope, setScope] = useState<DraftScope | null>(null)
  const [permsOpen, setPermsOpen] = useState(false)
  // named charter presets (user ruling): every .md in docs/charters/. Picked
  // presets appear as CARDS, not text (user spec) — click removes, hover
  // shows the source file's path on disk; only finalizing the hire turns
  // them into actual charter text (prepended to any manual entry).
  const [presets, setPresets] = useState<CharterPreset[]>([])
  const [chosen, setChosen] = useState<CharterPreset[]>([])
  const [presetLoad, setPresetLoad] = useState<'pending' | 'error' | 'ready'>('pending')
  const [presetError, setPresetError] = useState<string | null>(null)
  const [presetRetry, setPresetRetry] = useState(0)
  useEffect(() => {
    let current = true
    setPresetLoad('pending')
    setPresetError(null)
    getCharters().then((r) => {
      if (!current) return
      setPresets(r.charters ?? [])
      setPresetLoad('ready')
    }).catch((e: unknown) => {
      if (!current) return
      setPresetError(e instanceof Error && e.message ? e.message : 'request failed')
      setPresetLoad('error')
    })
    return () => { current = false }
  }, [presetRetry])
  const finalCharter = () =>
    [...chosen.map((c) => c.content), charter].filter((t) => t.trim())
      .join('\n\n')
  // ⚠ charter text used to be cut without a word — at 6000 on the way out of
  // /api/charters and at 4000 on the way in. Neither cut exists any more
  // (charters are uncapped; the preset bound is far above any real file), but
  // `cut` marks a preset the endpoint had to bound; the warning below explains
  // the resulting content without changing the hire flow.
  const cut = chosen.filter((c) => c.truncated)
  // top-level drafts pre-fill the org's default grant (50 unless configured),
  // clamped only by a kiosk's remaining headroom
  const [grant, setGrant] = useState(() => {
    const g = draft.parent == null ? (defaultTop ?? 50) : 0
    return kioskRemaining != null
      ? Math.max(0, Math.min(g, kioskRemaining - (seats[draft.tier] ?? 0))) : g
  })
  // user ruling: drag the allocation as high as you want — the cost bubbles
  // up the chain to you (§4.6) — bounded only by the org's GLOBAL grant cap
  // (settings: top-level grant cap), a kiosk's hard credit cap, or, when the
  // cascade_hire setting is off, the parent's own free credits.
  const max = kioskRemaining != null
    ? Math.max(0, kioskRemaining - (seats[draft.tier] ?? 0))
    : tree?.cascade_hire === false && draft.parent != null
      ? (map.get(draft.parent)?.free ?? 0)
      : maxTop
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  const ok = name.trim().length > 0
  const hire = () => { if (ok) onConfirm(name.trim(), grant, finalCharter(), scope) }
  // A draft already knows its tier, so it also knows its provider. Do not wait
  // for the hire to become a persisted TreeNode before applying provider
  // chrome: otherwise the dashed "uninitialized" Codex card briefly wears
  // Claude terracotta and flips to teal only after creation.
  const providerClass = ' prov-' + providerOf(draft.tier)
  return (
    <div className={'sq draft' + providerClass} style={{
      transform: `translate(${pos.x}px, ${pos.y}px)`, width: NODE_W, height: NODE_H,
    }} onPointerDown={(e) => e.stopPropagation()}>
      {/* unbounded drag — the ghost ceiling only exists under a kiosk cap */}
      <CreditBar seat={seats[draft.tier] ?? 0} grant={grant} committed={0}
        draftMode max={max}
        onDragValue={setGrant} zoom={zoom} pxc={pxc} />
      <div className="draft-tag">uninitialized</div>
      {/* the form is authored at natural screen scale and counter-scaled into
          the card — the desk's inverted-scale regime, on a 200px surface so
          the whole hiring flow stays near overview zoom */}
      <div className="draft-over" onWheel={(e) => e.stopPropagation()}>
        <div className="draft-inner">
          {/* top row: tier token · name entry · gear — one flex row, all three
              the same height with equal gaps (user ruling); the gear is
              always visible and stages the pre-hire permissions */}
          <div className="df-head">
            <span className={'tier t-' + draft.tier}>{TIER_LETTER[draft.tier]}</span>
            <input className="df-name" placeholder="name…" value={name}
              // focus WITHOUT scroll: autoFocus on an element inside the
              // world transform made the browser scroll the overflow:hidden
              // viewport when the draft spawned off-screen (from a desk)
              ref={(el) => {
                if (el && !el.dataset.f) {
                  el.dataset.f = '1'
                  el.focus({ preventScroll: true })
                }
              }}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ok) hire() }} />
            <button className="df-gear"
              title="permissions — folders, tools, MCP, visibility (applied with the hire)"
              onClick={() => setPermsOpen(true)}>
              <SettingsIcon fontSize="inherit" /></button>
          </div>
          {/* grant lives ONLY on the credit bar (user ruling) — no slider,
              no readout line; the bar's own tip reports grant + seat */}
          {presetLoad === 'pending' && (
            <div className="df-preset-status" role="status" aria-live="polite">
              Loading charter presets...
            </div>
          )}
          {presetLoad === 'error' && (
            <div className="df-preset-status" role="alert">
              Unable to load charter presets ({presetError ?? 'request failed'}).
              <button type="button"
                onClick={() => setPresetRetry((n) => n + 1)}>Retry</button>
            </div>
          )}
          {presetLoad === 'ready' && presets.length > 0 && (
            <select className="df-preset-add" value=""
              onChange={(e) => {
                const p = presets.find((x) => x.name === e.target.value)
                if (p && !chosen.some((c) => c.name === p.name)) {
                  setChosen((cs) => [...cs, p])
                  // user spec: the FIRST chosen preset names a still-unnamed
                  // agent after itself (typing over it still works)
                  if (!name.trim()) setName(p.name)
                }
              }}>
              <option value="">add charter preset…</option>
              {presets.filter((p) => !chosen.some((c) => c.name === p.name))
                .map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          )}
          {/* the picked cards live INSIDE the charter box (user spec) — they
              visually ARE part of the charter, compiled to text at hire */}
          <div className="df-charter-wrap">
            {chosen.length > 0 && (
              <div className="preset-cards">
                {chosen.map((c) => (
                  <button key={c.name} className="preset-card"
                    title={c.path ? `${c.path}\n(click to remove)` : 'click to remove'}
                    onClick={() => setChosen((cs) => cs.filter((x) => x.name !== c.name))}>
                    {c.name} <CloseIcon fontSize="inherit" />
                  </button>
                ))}
              </div>
            )}
            <textarea className="df-charter"
              placeholder="charter (optional): standing role notes…"
              value={charter} onChange={(e) => setCharter(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && ok && !isMobile) { e.preventDefault(); hire() } }} />
          </div>
          {cut.length > 0 && (
            <div className="df-charter-warn" role="alert">
              ⚠ {cut.map((c) => {
                const supplied = unicodeLength(c.content)
                if (c.chars == null) {
                  return `${c.name}: using ${formatCount(supplied)} characters supplied; original length unavailable, so omitted amount is unknown`
                }
                const original = c.chars
                const omitted = Math.max(0, original - supplied)
                const originalUnit = original === 1 ? 'character' : 'characters'
                const omittedUnit = omitted === 1 ? 'character' : 'characters'
                return `${c.name}: using ${formatCount(supplied)} of ${formatCount(original)} ${originalUnit}; ${formatCount(omitted)} ${omittedUnit} omitted`
              }).join(' · ')}. The hire gets only the first part. Shorten the preset file.
            </div>
          )}
          <div className="df-foot">
            <span className="spacer" />
            <button onClick={onCancel}><CloseIcon fontSize="inherit" /> cancel</button>
            <button className="primary" disabled={!ok} onClick={hire}
              title={ok ? undefined : 'give the agent a name first'}>
              <CheckIcon fontSize="inherit" /> hire</button>
          </div>
        </div>
      </div>
      {permsOpen && (
        <DraftScopeModal draft={draft} map={map} tree={tree} scope={scope}
          onSave={(s) => { setScope(s); setPermsOpen(false) }}
          close={() => setPermsOpen(false)} />
      )}
    </div>
  )
}
interface NodeSquareProps {
  node: CanvasNode
  pos: Pt
  lod: 'mini' | 'norm'
  focused: boolean
  dragging: boolean
  isDrop: boolean
  seats: Record<string, number>
  codexHire?: HireState | null
  antigravityHire?: HireState | null
  claudeHire?: HireState | null
  openrouterHire?: HireState | null
  /** D-199: route out of the no-harness state (opens the accounts panel). */
  onNoHarness?: () => void
  map: Map<string, CanvasNode>
  op: OpFn
  slug: string
  toast: ToastFn
  pxc: number
  zoom: number
  onSpawn: (tier: string) => void
  /** F-03: hire a sibling to this side (absent on piles/crowds — see render) */
  onSpawnSide?: (tier: string, side: 'left' | 'right') => void
  /** FR-25: the top-edge chips — hire a new SUPERIOR spliced above this node */
  onSpawnTop?: (tier: string) => void
  onConfig: () => void
  onInbox: () => void
  onDocket?: () => void
  onLineage: () => void
  /** FR-03: open a presented document in the in-page reader */
  onOpenDoc?: (id: string) => void
  /** open this agent's presentations in the shell's scoped modal */
  onOpenAgentGallery?: (agentId: string) => void
  onRecenter?: () => void
  onJump?: (id: string) => void
  pub: boolean
  kioskRemaining: number | null
  cascadeAlloc: boolean
  maxTop: number
  pile?: Pile
  compactAt?: number
  maxTier?: string | null
  onMailLink: MailLinkFn
  onWorkLink: WorkLinkFn
  onDragStart: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
  onDragMove: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
  onDragEnd: (e: React.PointerEvent<HTMLDivElement>, id: string,
    node: CanvasNode, focused: boolean) => void
  onDragCancel: (e: React.PointerEvent<HTMLDivElement>, id: string) => void
  /** compact map tier (mobile wave §5.1): the card renders as a MAP marker —
   *  tier block, name, status, last-turn stamp — no desk, no chips, no drag.
   *  Taps are arbitrated by the viewport (the sheet opens there). */
  mapMode?: boolean
  /** D-125 ②: watchdogs hide from the compact map; the owner card carries
   *  their count as a dot instead */
  dogs?: number
  /** D-200: compact maps still need to expose that part of the count is a
   * finite one-shot dog, even though the individual satellites are hidden. */
  oneShotDogs?: number
  /** FR-3: this desk is open as a pinned screen-space window (pins.tsx).
   *  The card wears a marker at every zoom. */
  pinned?: boolean
  /** FR-3: the camera would have focused this card, but its desk is pinned —
   *  render the placeholder in the desk's place, NEVER a second desk (user
   *  ruling 2026-09-04, "pinned means pinned"). Mutually exclusive with
   *  `focused`: OrgCanvas derives both from one nearest-card search. */
  pinnedFocus?: boolean
  /** FR-3: the desk header's pin button — absent hides it (mobile, and
   *  every desk that is not the canvas desk: switchboard panels, the sheet) */
  onPin?: () => void
  /** FR-3: the placeholder's click — raise, un-strand and flash the window */
  onShowPin?: () => void
  /** "Hire a subordinate…" picked from the AGENTS LIST rather than from this
   *  card (user request 2026-09-12): the chips live here, so the row glides to
   *  the agent and asks its card to open them. A COUNTER, not a flag — picking
   *  the entry twice for the same agent must reveal twice — and the card
   *  reports back through `onHireRevealed` so a card that is scrolled out of
   *  the viewport and back does not silently reveal them again. */
  revealHire?: number
  onHireRevealed?: () => void
}

/**
 * A badge that is ALSO an action, gated to desk view.
 *
 * THE RULE (user 2026-09-12, uploads/image-80.png). Outside desk view a card
 * is a thing you aim at to OPEN a desk. Its badge row is a row of SIGNS -
 * lifecycle, provenance, pinned, queued switch, limit, route - and two of
 * them happened to be buttons: the layers/stack count and the freeze badge
 * that unsticks the agent. Both cost the operator twice. They fired a
 * consequential action nobody aimed at, and because a control has to stop
 * its own pointerdown to survive the viewport's pointer capture, they also
 * SWALLOWED the press meant to focus the agent - which the user named as the
 * point of the ticket: "make it easier for the user to click anywhere on an
 * agent's surface and focus it from a distance".
 *
 * NOTHING IS LOST, AND THE DESK IS THE PRECEDENT. The open desk already
 * draws both of these correctly: its freeze chip is a plain span and the
 * release is a separate, labelled `unstick` button beside it, and its
 * lineage control is its own button (desk.tsx). This makes the card agree
 * with the desk instead of merging a status chip and an action into one.
 *
 * A SPAN, NOT A DISABLED BUTTON - the shape `PresentationCard` already uses
 * for the same job (canvas/docs.tsx): out here it is not an action at all,
 * so there is nothing to disable and nothing to announce as unavailable, it
 * takes no tab stop, and it holds no handler, so the press it used to
 * swallow reaches the card.
 *
 * WARNING - AND NOT `aria-hidden`, which is where this departs from the doc
 * chips. "Has presented a document" is carried by other controls; "this
 * agent is halted" is carried by nothing else on the card. Hiding it would
 * take the STATUS from a screen reader while leaving it for everyone else.
 * The inert form is an ordinary span beside `limit`, `queued` and `remote`,
 * which are plain spans already.
 *
 * WARNING - `deskView` IS THE RULE, NOT A SWITCH. Both call sites below sit
 * inside `.sq-badges`, which is not drawn in desk view at all, so today it
 * is false by construction and the inert branch is the only one a card
 * takes. It is written as the condition anyway so there is ONE place that
 * says when a badge may act, rather than two hand-inerted buttons that the
 * next badge action would not know to copy.
 * Behaviour is measured in tools/test-compact-card-actions.mjs.
 */
function ActionBadge({ deskView, className, title, onAct, children }: {
  deskView: boolean
  className: string
  title?: string
  onAct: () => void
  children: ReactNode
}) {
  if (!deskView) return <span className={className + ' inert'} title={title}>{children}</span>
  return <button className={className} title={title}
    onPointerDown={(e) => e.stopPropagation()}
    onClick={(e) => { e.stopPropagation(); onAct() }}>{children}</button>
}

export function NodeSquare({ node, pos, lod, focused: deskOpen, dragging, isDrop, seats, codexHire, antigravityHire, claudeHire, openrouterHire, onNoHarness, map, op, slug,
  toast, pxc, zoom, onSpawn, onSpawnSide, onSpawnTop, onConfig, onInbox, onDocket, onLineage, onOpenDoc, onOpenAgentGallery,
  onRecenter, onJump, pub, kioskRemaining, cascadeAlloc, maxTop, pile, compactAt, maxTier,
  onMailLink, onWorkLink, onDragStart, onDragMove, onDragEnd, onDragCancel,
  mapMode, dogs, oneShotDogs, pinned, pinnedFocus, onPin, onShowPin,
  revealHire, onHireRevealed }: NodeSquareProps) {
  // `focused` below is the card's LAYOUT state — desk-sized, head hidden, no
  // drag — which a pinned placeholder shares with an open desk. Only the
  // DeskChat mount itself keys on `deskOpen`.
  const showShortcuts = useAgentShortcuts()
  const focused = deskOpen || !!pinnedFocus
  // pile fronts zoom on a plain CENTER click (user spec) — track the
  // pointer-down point so a drag's trailing click doesn't re-zoom
  const downAt = useRef<Pt | null>(null)
  // retire from the CARD (user request 2026-08-17): the seat-freeing action
  // no longer requires zooming to the desk — same confirm + undo-toast flow,
  // same retire/dissolve split as the desk's cc-actions
  const [asking, setAsking] = useState<RetireKind | null>(null)
  const liveKids = node.children.some((c) => c.state === 'live')
  // NEAREST-EDGE chip gating (user ruling 2026-08-04): only the set at the
  // edge the cursor is closest to shows — bottom hires a report, left/right
  // hire a coworker, top (FR-25) inserts a superior. Tracked here from the
  // card's own pointer moves; normalized distances so the card's aspect
  // ratio doesn't bias the pick.
  const [edge, setEdge] = useState<'b' | 'l' | 'r' | 't'>('b')
  const [expandedHireEdge, setExpandedHireEdge] =
    useState<'b' | 'l' | 'r' | 't' | null>(null)
  // A cluster cannot remain floating over a card after the camera moves. This
  // also clears it when zooming back into the unchanged, direct-chip path.
  useEffect(() => { setExpandedHireEdge(null) }, [zoom])
  // THE CARD'S CONTEXT MENU (contextmenu.tsx). Every entry is one of the
  // card's own controls — the same callbacks, the same eligibility tests, the
  // same ConfirmModal for retire/dissolve. The LIST of entries is no longer
  // written here: it lives in canvas/agentmenu.tsx, because the Agents List
  // row offers the very same menu (user request 2026-09-12) and a second
  // hand-written copy is exactly the drift that ticket was about. This side
  // passes the card's own handlers and the two facts the builder cannot see.
  const menu = useContextMenu()
  const [hireReveal, setHireReveal] = useState(false)
  // "Hire a subordinate…" has no single handler (the tier choice and its
  // provider gating live in SpawnChips), so it REVEALS the bottom hire chips
  // the way a bottom-edge hover does: the `hire-reveal` class holds them open
  // until the pointer leaves the card. An Agents List row picks the same entry
  // from off-card, which is what `revealHire` below arrives as.
  const revealHireChips = () => { setEdge('b'); setHireReveal(true); setExpandedHireEdge('b') }
  // The signal runs the SAME reveal the card's own menu entry runs — it is the
  // same action asked for from another surface, not a second one. Read through
  // a ref so the effect stays keyed on the counter alone: `onHireRevealed` is
  // a fresh closure on every parent render, and depending on it would re-run
  // this on renders that changed nothing.
  const revealedCb = useRef(onHireRevealed)
  revealedCb.current = onHireRevealed
  useEffect(() => {
    if (revealHire == null) return
    revealHireChips()
    revealedCb.current?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealHire])
  // the desk's NATIVE window, read at menu-open time (deskhosts.tsx): whether
  // this agent's desk is already popped out decides which of the two entries
  // the builder offers, and a card must not hold a store subscription for it
  const deskNow = useDeskActionsNow(slug)
  const menuEntries = (): MenuEntry[] => {
    const desk = deskNow(node)
    return agentMenuEntries(node, {
      onOpenDesk: onRecenter,
      onInbox,
      onDocket,
      onPresentations: onOpenAgentGallery
        ? () => onOpenAgentGallery(node.id) : undefined,
      onLineage,
      onSettings: onConfig,
      onPin,
      onShowPin,
      // no native windows on mobile — the same reason the card has no `onPin`
      // there. A desk that is not mounted yet cannot be popped out on the
      // spot, so the request is retained and the camera goes to the agent,
      // which mounts it (deskhosts.tsx keeps the pending request).
      onPopout: !isMobile && desk.valid
        ? () => { desk.requestPopout(); if (!desk.present) onRecenter?.() }
        : undefined,
      onShowWindow: desk.show,
      onHire: revealHireChips,
      onRetireAsk: setAsking,
    }, { pinned, piled: !!pile, detached: desk.detached })
  }
  const trackEdge = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    if (!r.width || !r.height) return
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    const d = Math.min(x, 1 - x, 1 - y, y)
    const next = d === 1 - y ? 'b' : d === y ? 't' : d === x ? 'l' : 'r'
    if (edge !== next) setExpandedHireEdge(null)
    setEdge((cur) => cur === next ? cur : next)
  }
  const live = node.state === 'live'
  const cls = ['sq', node.state, focused ? 'desk' : lod, 'tier-' + node.tier,
               'edge-' + edge]
  // provider theming (user spec 2026-08-28): codex agents wear an
  // blue accent — desk border/shadow and busy ring — where claude
  // wears terracotta. Dormant until codex hire lands; keyed on the tier
  // family so it needs no new payload field.
  if (node.tier) cls.push('prov-' + providerOf(node.tier))
  if (live) cls.push(node.proc_warm ? 'proc-warm' : 'proc-cold')
  if (node.busy) cls.push('busy')
  // api_fallback (user feature 2026-08-19): a turn RUNNING on the org's own
  // API key wears the same red as the canvas border. No `busy` companion
  // check on purpose — the server writes this flag at spawn and clears it in
  // the turn's finally, and it lives in memory only, so it cannot outlast the
  // turn it describes (nor survive a backend restart).
  if (node.on_fallback) cls.push('onfallback')
  if (dragging) cls.push('lifted')
  if (isDrop) cls.push('drop')
  if (node.bearer_state) cls.push('bearer')
  if (node.limit_locked) cls.push('locked')
  if (node.frozen) cls.push('frozen')
  if (readOnlyAgent(node)) cls.push('ro-agent')
  // aura semantics reworked (user ruling 2026-08-04): the bright terracotta
  // glow now means ONE thing — this agent needs the user's attention (an open
  // ask). Holding a user audience is a capability, not an emergency: it wears
  // the same soft steel as any other audience.
  if (node.ask && (node.ask.status === 'open' || node.ask.status === 'pending')) {
    cls.push('asking')
  }
  if (node.audiences_held?.length) cls.push('aud')
  if (pinned) cls.push('pinned')
  if (hireReveal) cls.push('hire-reveal')
  const stackN = lineageCount(node)
  if (!focused && stackN) cls.push('stack' + Math.min(stackN, 3))
  const toggleCompactHire = (which: 'b' | 'l' | 'r' | 't') =>
    setExpandedHireEdge((open) => open === which ? null : which)
  // FR-23: the most recent completed turn (killed included — TurnStat.at is
  // written unconditionally at completion, unlike NodeStatus.at)
  const lastTurn = node.turns?.[node.turns.length - 1]
  // the card never changes size or place — the desk fades in over it (design
  // ruling). (Every real/bearer card carries the credit trio — only the eye
  // root omits it, and it never renders through NodeSquare — hence the `!`s.)
  const seat = node.seat!, grant = node.grant!, free = node.free!
  const style: React.CSSProperties = {
    transform: `translate(${pos.x}px, ${pos.y}px)`,
    width: NODE_W, height: NODE_H,
    zIndex: focused ? 5 : dragging ? 8 : undefined,
  }
  if (node.account && node.account_tint_ordinal != null) {
    const family = providerOf(node.tier ?? '')
    const base = family === 'openai' ? THEMES.codex.accent
      : family === 'google' ? THEMES.antigravity.accent
      : family === 'openrouter' ? THEMES.openrouter.accent : THEMES.claude.accent
    // Only the provider channel varies; work/status colors remain independent.
    Object.assign(style, { '--provider-accent': accountTint(base, node.account_tint_ordinal) })
  }
  // compact MAP tier (mobile wave, D-123/D-125): the card is a locator, not a
  // work surface — the desk lives in the full-screen sheet. Tier block, name,
  // status, last-turn stamp (FR-23 stays glanceable), watchdog count-dot
  // (D-125 ②). NO pointer handlers: the viewport arbitrates taps (a finger
  // that lands on a card must still be able to pan), and drag is hidden at
  // compact by design (§6). The `asking` aura class rides `cls` unchanged.
  if (mapMode) {
    const stat = node.last_status
    return (
      <div data-copy-agent-name={node.id} className={cls.join(' ') + ' maplod'} style={style}>
        <div className="map-top">
          <span className={'tier t-' + node.tier}>{TIER_LETTER[node.tier!] ?? '?'}</span>
          {node.pending_switch &&
            <span className="queued-mark" title={queuedSwitchTitle(node)}>
              →{TIER_LETTER[node.pending_switch.tier] ?? '?'}</span>}
          <MapModeIndicator node={node} />
          {(dogs ?? 0) > 0 && <span className={'map-dogs' + ((oneShotDogs ?? 0) > 0 ? ' oneshot' : '')}
            aria-label={`${dogs} watchdog${dogs === 1 ? '' : 's'}${(oneShotDogs ?? 0) > 0
              ? `, ${oneShotDogs} one-shot dog${oneShotDogs === 1 ? '' : 's'}` : ''}`}>
            ◉{dogs}{(oneShotDogs ?? 0) > 0 && <small>1×{oneShotDogs}</small>}
          </span>}
        </div>
        <span className="map-name">{node.id}</span>
        {node.halt || isUsageFrozen(node) || deriveTurnState(node) !== 'idle' ? (
          <MapTurnAge node={node} turn={lastTurn} />
        ) : (
          <LastTurnAge turn={lastTurn} busy={node.busy} variant="map" />
        )}
      </div>
    )
  }
  return (
    <div data-copy-agent-name={focused ? undefined : node.id} className={cls.join(' ')} style={style}
      onPointerDown={(e) => {
        downAt.current = { x: e.clientX, y: e.clientY }
        if (!focused) onDragStart(e, node.id)
      }}
      onPointerMove={(e) => { trackEdge(e); onDragMove(e, node.id) }}
      onPointerUp={(e) => onDragEnd(e, node.id, node, focused)}
      onPointerLeave={() => { setExpandedHireEdge(null); setHireReveal(false) }}
      /* the card's context menu — NOT at desk zoom: the open desk is its own
         surface (chat text, mail rows, its own header controls), and a
         right-click on its content must keep the browser's or the row's menu */
      onContextMenu={(e) => { if (!focused) menu.open(e, menuEntries) }}
      /* a UA-initiated cancel (touch arbitration, capture loss) must ABORT
         the drag — the end path's no-drop branch commits a reorder POST, so
         routing cancel through it turned a browser gesture cancellation
         into a live org restructure (mobile audit §0; fixed 2026-08-01) */
      onPointerCancel={(e) => onDragCancel(e, node.id)}
      onClick={(e) => {
        // pile front: center click = zoom onto the focused retiree (user
        // spec); margin clicks (the stack) are handled by the layers behind
        if (!pile || focused) return
        if ((e.target as Element).closest('button, input, textarea, select')) return
        const d = downAt.current
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return
        onRecenter?.()
      }}>
      {live && !node.isBearerOf && (
        <CreditBar seat={seat} grant={grant} committed={grant - free}
          segments={node.children.filter((c) => c.state !== 'archived')
            .map((c) => ({ seat: c.seat!, grant: c.grant! }))}   /* unrecoverable still holds */
          min={grant - free}
          /* reallocate cascades up the chain (§4.6), so the parent's free is
             not a ceiling — unless the cascade_alloc setting turns that off.
             Otherwise the org's global grant cap (or a kiosk's hard credit
             cap) bounds the drag. */
          max={kioskRemaining != null
            ? grant + kioskRemaining
            : cascadeAlloc === false && node.parent !== USER
              ? grant + (map.get(node.parent!)?.free ?? 0)
              : maxTop}
          maxGhost={cascadeAlloc === false && node.parent !== USER}
          onCommit={(delta) => op({ op: 'reallocate', node: node.id, delta })
            .then(() => toast(
              [`${node.id} grant ${delta > 0 ? '+' : ''}${fmtCredits(delta)}`],
              () => op({ op: 'reallocate', node: node.id, delta: -delta })
                .catch(() => {})))
            .catch(() => {})}
          zoom={zoom} pxc={pxc} />
      )}
      {/* the whole world-scaled head disappears at focus — the desk renders its
          own compact chrome inside the counter-scaled panel (a world-scaled name
          and tier chip blow up to poster size at desk zoom) */}
      {!focused && <div className="sq-head">
        {/* Zoomed-out cards have three deliberate rows: model/name, live
            state plus CLI/context status, and actions. Keeping the title and
            status groups separate prevents long names and status controls from
            stealing the context wheel's hit area. */}
        <div className="sq-title">
          <span className={'tier t-' + node.tier}>{TIER_LETTER[node.tier!] ?? '?'}</span>
          {node.pending_switch &&
            <span className="queued-mark" title={queuedSwitchTitle(node)}>
              →{TIER_LETTER[node.pending_switch.tier] ?? '?'}</span>}
          <span className="name" title={node.account ? `${node.id}: account ${node.account}` : node.id}>{node.id}</span>
        </div>
        <div className="sq-meta">
          <ContextWheel occ={node.occupancy} cw={node.context_window}
            est={node.occupancy_est} compactAt={compactAt} />
          <div className="sq-workstate">
            {node.halt || isUsageFrozen(node) || deriveTurnState(node) !== 'idle' ? (
              <AgentWorkstate node={node} turn={lastTurn} live={live} />
            ) : (
              <>
                <span className={'sq-idle ' + (node.last_status?.status ?? (live ? 'idle' : node.state))}
                  title={node.last_status?.summary ?? undefined}>
                  {stateLabel(node.last_status?.status ?? (live ? 'idle' : node.state))}
                </span>
                <LastTurnAge turn={lastTurn} busy={node.busy} variant="inline" />
              </>
            )}
          </div>
          {node.last_error && <span className="errdot" title={node.last_error ?? undefined} />}
        </div>
      </div>}
      {/* far-zoom mini cards are locators: the hover shortcuts scale UP
          with inverse zoom and would swallow the click that focuses the
          agent (their pointerdown stopPropagation starves the drag-end
          click→centerOn path), so at mini they are UNMOUNTED — no hit
          target at all — not merely faded (user report 2026-09-10) */}
      {showShortcuts && !focused && lod !== 'mini' && <div className="sq-actions">
        {onDocket && <button className="mailbtn docketbtn" aria-label={`Docket for ${node.id}`}
          title={`Docket for ${node.id}`}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onDocket() }}>
          <DocketIcon fontSize="inherit" />
        </button>}
        <button className={'mailbtn' + ((node.mail_pending ?? 0) > 0 ? ' has' : '')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onInbox() }}>
          <MailIcon fontSize="inherit" />{(node.mail_pending ?? 0) > 0 &&
            <span className={'count prov-' + providerOf(node.tier ?? '')}>{node.mail_pending}</span>}
        </button>
        {onPin && !pinned &&
          <button className="expandbtn" aria-label="Expand agent window"
            title="Expand agent window"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onPin() }}>
            <FullscreenIcon fontSize="inherit" />
          </button>}
        {/* retire without the zoom-in (user request 2026-08-17): hover-revealed
            like the gear/mail, confirm-gated like the desk button. Wears the
            desk's retire/dissolve split so it is never a dead control. */}
        {live && !node.isBearerOf && !node.bearer_state &&
          <button className="retirebtn"
            title={liveKids
              ? `dissolve — retire ${node.id} and its whole suborganization, freeing ${fmtCredits((node.seat ?? 0) + (node.grant ?? 0))} credit(s)`
              : `retire — frees ${fmtCredits((node.seat ?? 0) + (node.grant ?? 0))} credit(s); context kept, rehire brings it back`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              setAsking(liveKids ? 'dissolve' : 'retire')
            }}><RetireIcon fontSize="inherit" /></button>}
        {/* ceiling spec §2: visitors retool freely WITHIN the kiosk ceiling —
            the gear is theirs too; the ledger clamps, never a 403 */}
        <button className="gearbtn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onConfig() }}><SettingsIcon fontSize="inherit" /></button>
        {onOpenAgentGallery && (node.documents?.length ?? 0) > 0 &&
          <button className="presentedbtn" aria-label={`presented documents for ${node.id}`}
            title={`open presented documents for ${node.id}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onOpenAgentGallery(node.id) }}>
            <DocIcon fontSize="inherit" />
          </button>}
      </div>}
      {!focused && lod !== 'mini' && (
        <div className="sq-badges">
          {/* no seat/free badges — the credit bar carries all of that */}
          {/* LIFECYCLE AND PROVENANCE ARE TWO FACTS AND GET TWO CHIPS (user
              report 2026-08-28: "it looks retired… the ui is too similar; it
              needs to look more like a normal agent"). These used to share one
              `badge dim`, with the bearer state STANDING IN for the lifecycle
              state whenever it existed: a live bearer's only chip read
              `knowledge`, in the same grey, in the same slot where every other
              card says `archived`. So a rehired bearer mid-turn was labelled
              as though `knowledge` were its state. Now the lifecycle chip
              appears on exactly the cards that are not live — bearer or not —
              and the bearer mark is its own quieter, outlined chip beside it.
              An archived bearer therefore still shows `archived`, and shows it
              first. */}
          {node.state !== 'live' &&
            <span className="badge dim">{node.state}</span>}
          {/* FR-3: its desk is open as a pinned window — say so at every
              zoom, so the card is not mistaken for one that will open */}
          {pinned && <span className="badge pinbadge" title="this desk is pinned as a window">pinned</span>}
          {node.bearer_state &&
            <span className="badge bearermark"
              title={`${node.bearer_state} bearer — where this agent's context `
                + 'came from, not what it is doing; a rehired bearer works '
                + 'like any other agent'}>{node.bearer_state}</span>}
          {/* ⭐ clickable (user ruling 2026-08-06): the freeze badge IS the
              per-node unstick — the control lives where the user finds the
              agent, not only in org-level panels */}
          {/* the per-node unstick (user ruling 2026-08-06) used to ride on
              this chip. Since 2026-09-12 the chip is a SIGN out here and the
              release is the desk's own `unstick` button - the title says what
              is wrong and no longer invites a click a zoomed-out card must
              not accept. See ActionBadge. */}
          {node.frozen &&
            <ActionBadge deskView={focused} className="badge frozen"
              title={[node.frozen.error,
                node.frozen.account
                  ? `account ${node.frozen.account}`
                    + (node.frozen.provenance === 'inferred'
                      ? ' (inferred from its pooled limit, not measured '
                        + 'for this tier)'
                      : '')
                  : null].filter(Boolean).join(' — ') || undefined}
              onAct={() => {
                if (pub) return
                unstickNode(slug, node.id)
                  .then((r) => toast([r.released?.length
                    ? `${node.id} unstuck (${r.released.join(', ')})`
                    : (r.status ?? 'nothing to release'),
                    ...(r.warnings ?? [])]))
                  .catch((e2: Error) => toast([`error: ${e2.message}`]))
              }}><FrozenIcon fontSize="inherit" />{' '}
              {FREEZE_LABEL_SHORT[freezeKind(node.frozen, node.limit_locked) ?? 'limit']}
              {/* ⚠ not on a HALTED badge: a fable lock's clock can never fire,
                  so it carries no estimate for a provenance to qualify and
                  "halted (inferred)" would read as doubt about the halt
                  itself. Same guard as the desk badge in desk.tsx. */}
              {!node.limit_locked && node.frozen.provenance === 'inferred'
                ? ' (inferred)' : ''}</ActionBadge>}
          {node.remote_controlled &&
            <span className="badge frozen"
              title="the user is driving this session from another device — mail queues until release (gear panel)">
              remote</span>}
          {/* D-234 (user requirement 2026-09-03: "some flag somewhere visible
              on the agent that it will occur next turn"): a switch queued
              behind the running turn is WORN by the agent for as long as it
              waits — not only in the dialog at the moment of action. It names
              the target, and it clears with the field: applied, cancelled, or
              replaced (then it names the new target). */}
          {node.pending_switch &&
            <span className="badge queued" title={queuedSwitchTitle(node)}>
              → {node.pending_switch.tier} next turn</span>}
          {node.limit_locked && <span className="badge dim"><LockIcon fontSize="inherit" /> limit</span>}
          {/* item 12 (user spec 2026-09-04): the pool a luna is ACTUALLY on,
              on the card's second row as on the desk's — same component,
              same backend label, "last: " prefixed when it is not live */}
          <RouteBadge route={node.codex_route} />
          {/* the lineage opens from the desk's own stack badge; out here the
              count is a sign. Same reason as the freeze chip above. */}
          {stackN > 0 &&
            <ActionBadge deskView={focused} className="badge stackbadge"
              onAct={onLineage}><LayersIcon fontSize="inherit" /> {stackN}</ActionBadge>}
        </div>
      )}
      {deskOpen && (
        <DeskChat node={node} map={map} op={op} slug={slug}
          toast={toast}
          onLineage={onLineage} onConfig={onConfig} compactAt={compactAt}
          onRecenter={onRecenter} onJump={onJump} maxTop={maxTop} pxc={pxc}
          pub={pub} onMailLink={onMailLink} onWorkLink={onWorkLink}
          onOpenDoc={onOpenDoc}
          onPin={onPin} />
      )}
      {/* FR-3: the desk is a pinned window — the desk's place holds a
          placeholder, and there is no second DeskChat anywhere in this card */}
      {pinnedFocus && !deskOpen && onShowPin && (
        <div className="pin-holder">
          <PinnedPlaceholder id={node.id} onShow={onShowPin} />
        </div>
      )}
      {/* user ruling: chips are NEVER disabled by the node's own free credits —
          a user hire §4.6-cascades, granting the chain whatever it lacks.
          (Kiosk mode will pass the cap remainder here instead.)

          ⚠ AND NOT GATED ON `lod` (user report 2026-09-11: the hire tokens
          "disappear at maximum zoom and only come back when the card quick
          actions do"). They shared the shortcut row's Z_MINI threshold from
          2026-09-10, because a far-zoom control can swallow the click that
          focuses an agent — but that is a claim about geometry, and the two
          controls do not share the geometry. `.sq-actions` is a card ROW,
          drawn over the body it would steal from; a hire strip is anchored
          1 world px inside an EDGE and grows outward, covering 0.24px of its
          own card at the zoom clamp, and `farCompact` already holds it to the
          card's own width. What it CAN reach is the neighbour it grows
          toward, and that is settled in the stylesheet by paint order rather
          than by hiding the control (`.sq.mini:hover`); the numbers and the
          hit tests are in tests/minihire_probe.py. */}
      {live && !node.isBearerOf && !node.bearer_state &&
        <SpawnChips onSpawn={onSpawn} free={kioskRemaining ?? Infinity} seats={seats}
          maxTier={maxTier} codexHire={codexHire} antigravityHire={antigravityHire}
          claudeHire={claudeHire} onNoHarness={onNoHarness}
          openrouterHire={openrouterHire}
          zoom={focused ? undefined : zoom} expanded={expandedHireEdge === 'b'}
          onToggleExpanded={() => toggleCompactHire('b')} />}
      {/* FR-03: presented documents pop out the card's side as square icon
          chips — click opens the in-page reader. Not at desk zoom (the desk
          HEADER carries titled doc badges instead — world-scaled side chips
          blow up) and not on pile fronts (the side is the stack).
          ⚠ AND INERT AT MINI (user 2026-09-11: "dont make any cards in
          agents when zoomed out clickable"). These were the last CARDS still
          operable on a far-zoom card; the shortcut row and the badge row are
          unmounted at `mini`, on this threshold and for this reason: a
          screen-constant control drawn OVER a shrinking card swallows the
          click that focuses the agent, because `PresentationCard` stops the
          pointerdown and starves the drag-end → centerOn path.
          (The hire strips were unmounted here too until 2026-09-11, when the
          user asked for them back at maximum zoom. They are the one far-zoom
          control that sits OUTSIDE the card rather than over it, so they cost
          the card nothing; see the SpawnChips comment above.)
          They stay VISIBLE rather than going away like those three — the ask
          was that they not be CLICKABLE — and `inert` removes every route in
          (see canvas/docs.tsx). Interaction returns whole at `norm`. Pinned
          desks and the open desk are untouched: neither is a far-zoom
          surface, and neither receives `lod`. */}
      {!focused && !pile && (node.documents?.length ?? 0) > 0 && onOpenDoc && (
        <DocChips slug={slug} docs={node.documents!} onOpen={onOpenDoc}
          inert={lod === 'mini'} />
      )}
      {/* F-03: side chips hire a COWORKER — same superior, landing on that
          side. Not on pile/crowd fronts: the card's edges there are the
          stack's layers, and "the side of the agent" is not a free position. */}
      {live && !node.isBearerOf && !node.bearer_state && !pile && onSpawnSide && (
        <>
          {/* transparent hover bridges (user report 2026-08-28). The columns
              now sit beyond the credit bar and the doc chips so they cannot
              cover them at any zoom — which puts a strip of empty canvas
              between card and chips, and the chips only exist while the card
              is hovered. Without these the chips would blink out as the cursor
              crossed that strip and the hire gesture would become the new
              unreachable thing. Pure hit area: no paint, under the bar and the
              doc chips, so they take nothing else's clicks. */}
          <div className="hsof-bridge bridge-l" aria-hidden="true" />
          <div className="hsof-bridge bridge-r" aria-hidden="true" />
          <SpawnChips side="left" onSpawn={(t) => onSpawnSide(t, 'left')}
            free={kioskRemaining ?? Infinity} seats={seats} maxTier={maxTier}
            codexHire={codexHire} antigravityHire={antigravityHire}
            openrouterHire={openrouterHire}
            claudeHire={claudeHire} onNoHarness={onNoHarness}
            zoom={focused ? undefined : zoom} expanded={expandedHireEdge === 'l'}
            onToggleExpanded={() => toggleCompactHire('l')} />
          <SpawnChips side="right" onSpawn={(t) => onSpawnSide(t, 'right')}
            free={kioskRemaining ?? Infinity} seats={seats} maxTier={maxTier}
            codexHire={codexHire} antigravityHire={antigravityHire}
            openrouterHire={openrouterHire}
            claudeHire={claudeHire} onNoHarness={onNoHarness}
            zoom={focused ? undefined : zoom} expanded={expandedHireEdge === 'r'}
            onToggleExpanded={() => toggleCompactHire('r')} />
        </>
      )}
      {/* FR-25: top-edge chips SPLICE a new superior above this node — the
          draft takes this card's slot immediately (anchor hangs beneath it,
          dashed both ways), and the confirmed hire splices in server-side
          atomically. Same pile/bearer exclusions as the side chips. */}
      {live && !node.isBearerOf && !node.bearer_state && !pile && onSpawnTop && (
        <SpawnChips side="top" onSpawn={(t) => onSpawnTop(t)}
          free={kioskRemaining ?? Infinity} seats={seats} maxTier={maxTier}
          codexHire={codexHire} antigravityHire={antigravityHire}
          openrouterHire={openrouterHire}
          claudeHire={claudeHire} onNoHarness={onNoHarness}
          zoom={focused ? undefined : zoom} expanded={expandedHireEdge === 't'}
          onToggleExpanded={() => toggleCompactHire('t')} />
      )}
      {/* portal to <body>: the card lives inside the world transform, where
          position:fixed would resolve against the scaled ancestor (same
          reason DraftScopeModal portals). The dialog itself — wording, op and
          undo toast, mirroring the desk's confirms verbatim — is
          AgentRetireConfirm, shared with the Agents List row's menu; only
          WHERE it is portaled is this card's own business. */}
      {menu.node}
      {asking && createPortal(
        <AgentRetireConfirm kind={asking} node={node} op={op} toast={toast}
          close={() => setAsking(null)} />, document.body)}
    </div>
  )
}
