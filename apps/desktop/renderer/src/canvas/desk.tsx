import { resolveRef } from './reflinks'
import { readReply, replyContext, replyFromRow, replyWire, storeReply } from '../eventReply'
import type { ReplyContext } from '../eventReply'
import { ReplyPreview } from './replypreview'
import { useContextMenu } from './contextmenu'
import type { MouseEvent as ReplyMouseEvent } from 'react'
import { discardAllRecoverableDrafts, discardRecoverableDraft, readAttachments, recoverableDrafts, storeAttachments } from '../draftstore'
import { DeskSlot } from './deskhosts'
import { PopoutButton, useSurface, useSurfaceDocument } from '../popout'
// canvas/desk.tsx — the desk: DeskChat (the zoomed-in per-agent chat window,
// styled as a miniature Claude Code session) with its transcript renderers
// (Msg, ToolChip, ThoughtLine, SysLine), the composer's effort controls and
// slash hints, the history/files tabs, the lineage panel, and the small
// ContextWheel/Activity indicators shared with the cards. Extracted verbatim
// from Canvas.tsx in the phase-3 split.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type {
  CacheForecast, ChatMessage, ChatPayload, CodexRouteInfo, HistoryItem, PendingMail,
  Denial, Readiness, ScratchPayload, TreeFrozen, TurnStat,
  ToolChip as ToolChipData, ToastFn,
} from '../types'
import {
  audienceAction, BASE, compactNode, fileBase, fileUrl, getChat, getHistory,
  getScratch, getWorkItems, interruptNode, processControl, retractMail,
  saveScope, sendMessage,
  unstickNode, uploadFile,
} from '../api'
import { AttachThumb, fmtBytes, ImgCardCaption, isImg } from './img'
import { openLightbox } from './lightbox'
import PushPinIcon from '@mui/icons-material/PushPinOutlined'
import {
  ArrowDownIcon, ArrowUpIcon, AutorenewIcon, CloseIcon, DocIcon, DotIcon,
  DownloadIcon, EditIcon, EyeIcon, FileIcon, FolderIcon, FrozenIcon,
  DocketIcon, HearingIcon, LayersIcon, LockIcon, MailIcon, PlayIcon,
  PsychologyIcon,
  SettingsIcon, SparkIcon, StopIcon, WarnIcon,
} from '../icons'
import { ago, ALL_PRESENT, ALL_TIERS, anyTierSeat, CODEX_TIERS, CopyIcon, EXTERN, fmtCredits, freezeKind, FREEZE_LABEL, ANTIGRAVITY_TIERS, isOpenRouterTier, md, openrouterTierIds, PROVIDER_LABEL, providerOf, queuedSwitchTitle, reportedLabel, stateLabel, TIER_LETTER, tierCapabilityNotes, tierLabel, tierShown, USER, usePolled } from './shared'
import { closeIfCentred, ModalOverPins, PinFrame } from './modalpin'
import type { ProviderPresence } from './shared'
import {
  addPending, bindPendingMail, failPending, CHAT_WINDOW, dismissPending, dropPending,
  loadOlder as storeLoadOlder, markBusy, markGhostCommand,
  MAX_WINDOW, refreshConvo, useConvo,
} from '../convo'
import type { PendingGhost } from '../convo'
import type {
  ActivityInfo, CanvasNode, LiveRow, MailLinkFn, OpFn, WorkLinkFn,
} from './shared'
import { ConfirmModal } from './modals'
import { InboxView, RetiredFold } from './mail'
import { AskCard } from './asks'
import { AgentDocketView, agentItems } from './docket'
import { AgentGalleryView } from './gallery'
import { PresentationCard } from './docs'
import { buildNodeFacts } from './docket'
import { AgentDirectoryProvider, AgentName, agentFactsSig, useAgentDirectory } from './identity'
import type { AgentDirectory } from './identity'
import { mailRefTarget, useRefRoutes } from './reflinks'
import type { RefRoutes, RefWorld, ResolvedRef } from './reflinks'
import type { TypedRef } from './workrefs'
import { RefMdBody } from './refmd'
import { EventCard, eventSurface } from '../events/card'
import { MailMessage } from '../events/segments'
import { decodeEventRow } from '../events/decode'
import { authoredUserLabel, isSegments, SegmentList } from '../events/segments'
import { isMobile } from '../mobile'
import { fmtFull, fmtShort, fmtStamp, localizeFreezeUntil } from '../timefmt'

interface ContextWheelProps {
  occ?: number | null
  cw?: number | null
  onCompact?: () => void
  compactAt?: number
  /** The focused desk owns a permanent top-row slot, including before the
   * first measurement. Canvas cards keep their established omit-if-empty
   * behavior so this header change does not add chrome at overview zoom. */
  persistent?: boolean
  /** the fill is a post-compaction ESTIMATE — no turn has measured the new
   *  session yet (backend: occupancy_est / occupancy_estimated) */
  est?: boolean
}

export function ContextWheel({ occ, cw, onCompact, compactAt, est,
  persistent = false }: ContextWheelProps) {
  const knownWindow = typeof cw === 'number' && cw > 0
  const knownOccupancy = typeof occ === 'number' && occ >= 0
  const used = knownOccupancy ? Math.max(0, occ) : 0
  if (!persistent && (!knownWindow || !knownOccupancy || used === 0)) return null
  const frac = knownWindow ? Math.min(1, used / cw) : 0
  // №19: the red ring means "about to split" — the ORG'S configured
  // threshold, not a literal 0.8 (an org set to 50% got a ring that turned
  // red 30 points after its agents had already forked)
  const hot = knownWindow && knownOccupancy && frac >= (compactAt || 0.8)
  const R = 5.5, C = 2 * Math.PI * R
  const contextTitle = !knownWindow
    ? 'context: unavailable — context-window size not reported'
    : !knownOccupancy
      ? `context: empty — no completed turn has measured this session yet · capacity ${Math.round(cw / 1000)}k`
      : `context: ${est ? '≈' : ''}${Math.round(used / 1000)}k / ${Math.round(cw / 1000)}k (${Math.round(frac * 100)}%)`
        + (used === 0 ? ' — empty session' : '')
        + (est ? ' — estimated after compaction, until its next turn' : '')
        + ` — auto-compacts at ${Math.round((compactAt || 0.8) * 100)}%`
        + (onCompact ? ' — click to compact now' : '')
  const svg = (
    <svg className={'ctxwheel' + (est && knownOccupancy ? ' est' : '')}
      viewBox="0 0 16 16" width="15" height="15"
      role={onCompact ? undefined : 'img'} aria-hidden={onCompact ? true : undefined}
      aria-label={onCompact ? undefined : contextTitle}>
      {/* an estimated fill says so in the tooltip (a leading ≈) and draws its
          arc at half opacity (.ctxwheel.est .fill): the number is real enough
          to act on and was never measured */}
      <title>{contextTitle}</title>
      <circle cx="8" cy="8" r={R} className="track" />
      <circle cx="8" cy="8" r={R} className={'fill' + (hot ? ' hot' : '')}
        strokeDasharray={`${C * frac} ${C}`} transform="rotate(-90 8 8)" />
    </svg>
  )
  // clickable ONLY where a handler is wired — the zoomed desk (user ruling);
  // the zoomed-out card wheel stays a passive indicator
  if (!onCompact) return svg
  return <button className="ctxbtn" aria-label={contextTitle}
    onClick={onCompact}>{svg}</button>
}

/** D-201: a filled dot means the agent has a parked process ready; a quiet
 * hollow dot means its next turn needs a normal cold spawn. This is speed
 * information only, so it deliberately borrows no warning/error colour. */
export function ProcessWarmMark({ warm, embedded = false }: {
  warm: boolean; embedded?: boolean
}) {
  return <span className={'proc-mark ' + (warm ? 'warm' : 'cold')}
    aria-hidden={embedded || undefined}
    aria-label={embedded ? undefined : warm ? 'process warm' : 'process cold'}
    title={embedded ? undefined : warm ? 'process warm — ready for its next turn'
      : 'process cold — starts normally on its next turn'} />
}

// One clock for every card/desk badge. The prior card markup happened to
// refresh when its parent did; this shared second pulse keeps every mounted
// view in agreement without a tree refetch or one timer per agent.
let ageClockSecond = Math.floor(Date.now() / 1000)
let ageClockTimer: ReturnType<typeof setInterval> | null = null
const ageClockSubs = new Set<() => void>()
export const pulseAgeClock = () => {
  const next = Math.floor(Date.now() / 1000)
  if (next === ageClockSecond) return
  ageClockSecond = next
  for (const fn of [...ageClockSubs]) fn()
}
export const subscribeAgeClock = (fn: () => void) => {
  ageClockSubs.add(fn)
  if (ageClockSubs.size === 1) {
    pulseAgeClock()
    ageClockTimer = setInterval(pulseAgeClock, 1000)
  }
  return () => {
    ageClockSubs.delete(fn)
    if (!ageClockSubs.size && ageClockTimer) {
      clearInterval(ageClockTimer)
      ageClockTimer = null
    }
  }
}

/** The route token (item 12; user spec 2026-09-04) — shared by the desk's
 * meta row and the card's badge row so the two cannot word it differently.
 * Renders ONLY the backend's `label`: "reserve" while a luna turn is running
 * on the reserve pool, "direct · reserve out" while it runs direct because
 * reserve is spent/withdrawn, and the same with a "last: " prefix when it
 * describes the previous turn rather than a live one. A null label (every
 * other tier; a direct luna with nothing to disclose) renders nothing — the
 * token carries news or it is absent. The tooltip states the selected model
 * and, apart from it, what the provider reported back; neither is a claim
 * about which weights answered. */
export function RouteBadge({ route }: { route?: CodexRouteInfo | null }) {
  if (!route?.label) return null
  const reported = route.reported_model
    ? `; provider reported ${route.reported_model}`
    : '; provider reported nothing'
  // a KNOWN reroute: the server said it served another model than the one
  // sent; the pool that ran is the destination's, or unknown — said so,
  // never inferred (parent review 2026-09-05)
  const rerouted = route.rerouted
    ? `; the provider rerouted it to ${route.rerouted.toModel ?? '?'}`
      + (route.served_pool ? ` (the ${route.served_pool} pool)` : ' (no known pool)')
    : ''
  const when = route.live ? 'this turn' : `last turn${route.at ? ` (${ago(route.at)})` : ''}`
  // the class names the pool that RAN when known, the selected one otherwise
  const ran = route.rerouted
    ? (route.served_pool === 'reserve' ? 'reserve'
      : route.served_pool === 'plan' ? 'direct' : 'unknown')
    : route.route
  return (
    <span className={'badge route-' + ran + (route.live ? ' live' : '')}
      data-route-live={route.live ? '1' : '0'}
      title={`${when} was sent as ${route.model} on the ${route.route} pool `
        + `(${route.reason}${route.selection === 'retry' ? ', after the other pool rejected it' : ''})`
        + rerouted + reported + ' — the next turn re-resolves'}>
      {route.label}</span>
  )
}

/** FR-23's authoritative completed-turn age, shared by cards and desks.
 * Busy/never-ran nodes deliberately render nothing, exactly as the card did.
 * Source is TurnStat.at, written at every turn completion — NOT NodeStatus.at,
 * which exists only when the agent chose to report a status. */
export function LastTurnAge({ turn, busy = false, variant = 'badge' }: {
  turn?: TurnStat | null; busy?: boolean
  /** `inline` sits beside the card's state word, as the banner's time sits
   *  beside its label — same value, same clock */
  variant?: 'badge' | 'map' | 'inline'
}) {
  useSyncExternalStore(subscribeAgeClock, () => ageClockSecond,
    () => ageClockSecond)
  if (!turn || busy) return null
  const title = 'last turn ended '
    + fmtStamp(turn.at)
    + (turn.killed ? ' (killed)' : '')
  const cls = variant === 'map' ? 'map-ago'
    : variant === 'inline' ? 'sq-idle-time'
      : 'badge dim turnago'
  return <span className={cls}
    title={title} aria-label={title}>
    {ago(turn.at)}{variant === 'map' && turn.killed ? ' ✕' : ''}
  </span>
}

/** A busy arrow on navigation chrome must name the destination provider even
 * when it is rendered inside another provider's themed desk. */
export function DestinationBusy({ tier }: { tier?: string | null }) {
  return <AutorenewIcon fontSize="inherit"
    className={`cc-spin prov-${providerOf(tier ?? '')}`} />
}

/** The SYSTEM-OBSERVED turn state (user ruling 2026-09-07 06:28Z, one word
 *  each): a node with a turn executing right now is shown as "Active"; the
 *  word "Working" is reserved for the AGENT-REPORTED status (orgtree_status),
 *  which the desk shows out of turn from `last_status`. The internal value
 *  stays 'working' — only the human-facing label changed — so every class
 *  name, test seam and caller keeps its meaning. */
export type AgentTurnState = 'working' | 'queued' | 'compacting' | 'idle'

export function deriveTurnState(node: {
  busy?: boolean
  waiting?: boolean
  phase?: string | null
}): AgentTurnState {
  if (node.phase === 'compacting') return 'compacting'
  if (node.waiting) return 'queued'
  if (node.busy) return 'working'
  return 'idle'
}

/** Presentation precedence only: never change execution/lifecycle or reported state. */
export function isUsageFrozen(node: {
  state?: string; frozen?: TreeFrozen | null; limit_locked?: boolean
}): boolean {
  return node.state === 'live' && !!node.frozen
    && freezeKind(node.frozen, node.limit_locked) === 'limit'
}

/** Capacity reset is not a promise to resume. Only a new server record clears Frozen. */
export function UsageFreezeStatus({ frozen, variant = 'card' }: {
  frozen: TreeFrozen; variant?: 'card' | 'banner' | 'tray' | 'map'
}) {
  const stamp = frozen.until_ts
  const deadline = typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0
    ? stamp * 1000 : null
  const left = useCountdown(deadline)
  const time = left === null ? null : left <= 0 ? 'reset due' : countdownText(left)
  const title = left === null
    ? `Frozen: ${frozen.until || 'reset time unknown'}`
    : left <= 0 ? 'Frozen: recorded reset reached; awaiting server release'
      : `Frozen: capacity reset in ${countdownText(left)}; release is controlled by the server`
  return <span className={'usage-freeze-status ' + (variant === 'banner'
    ? 'turn-status-banner frozen' : variant === 'tray' ? 'tray-status' : '')}
    title={title} aria-label={title}>
    <span className={variant === 'banner' ? 'turn-status-label' : 'sq-idle frozen'}>{stateLabel('frozen')}</span>
    {time && <span className={variant === 'banner' ? 'turn-status-time' : 'sq-idle-time'}>{time}</span>}
  </span>
}

/** Unified workstate presentation for NodeSquare. Subscribes to ageClockSecond
 * so active turn elapsed time and idle time tick every second without props/SSE updates. */
export function AgentWorkstate({ node, turn, live = true }: {
  node: CanvasNode; turn?: TurnStat | null; live?: boolean
}) {
  useSyncExternalStore(subscribeAgeClock, () => ageClockSecond,
    () => ageClockSecond)
  const state = deriveTurnState(node)
  if (isUsageFrozen(node) && node.frozen) return <UsageFreezeStatus frozen={node.frozen} />
  if (state === 'working') {
    return (
      <>
        <DestinationBusy tier={node.tier} />
        <span className="sq-idle working active"
          title={node.inflight_at ? `active for ${ago(node.inflight_at)}` : 'active'}>
          {stateLabel('active')}
        </span>
        <span className="sq-idle-time">
          {node.inflight_at ? ago(node.inflight_at) : '—'}
        </span>
      </>
    )
  }
  if (state === 'queued') {
    return (
      <>
        <span className="statusdot waiting" title="queued — waiting for a free turn slot" />
        <span className="sq-idle waiting" title="queued">
          {stateLabel('queued')}
        </span>
        <span className="sq-idle-time">
          {node.inflight_at ? ago(node.inflight_at) : '—'}
        </span>
      </>
    )
  }
  if (state === 'compacting') {
    return (
      <>
        <span className="sq-idle compacting" title="compacting">
          {stateLabel('compacting')}
        </span>
        <span className="sq-idle-time">
          {node.inflight_at ? ago(node.inflight_at) : '—'}
        </span>
      </>
    )
  }
  const recorded = node.last_status?.status ?? (live ? 'idle' : node.state)
  return (
    <>
      <span className={'sq-idle ' + recorded}
        title={node.last_status?.summary ?? undefined}>
        {stateLabel(recorded)}
      </span>
      {turn && (
        <span className="sq-idle-time"
          title={'last turn ended ' + fmtStamp(turn.at) + (turn.killed ? ' (killed)' : '')}>
          {ago(turn.at)}
        </span>
      )}
    </>
  )
}

/** Unified tray status presentation for bottom-left tray rows and mobile sheet header.
 * Subscribes to ageClockSecond so turn and idle times tick every second. */
export function TrayStatus({ node, turn, live = true }: {
  node: CanvasNode; turn?: TurnStat | null; live?: boolean
}) {
  useSyncExternalStore(subscribeAgeClock, () => ageClockSecond,
    () => ageClockSecond)
  const state = deriveTurnState(node)
  if (isUsageFrozen(node) && node.frozen) return <UsageFreezeStatus frozen={node.frozen} variant="tray" />
  if (state === 'working') {
    return (
      <span className="tray-status">
        <DestinationBusy tier={node.tier} />
        <span className="tray-status-label working active"
          title={node.inflight_at ? `active for ${ago(node.inflight_at)}` : 'active'}>
          {stateLabel('active')}
        </span>
        <span className="tray-status-time">
          {node.inflight_at ? ago(node.inflight_at) : '—'}
        </span>
      </span>
    )
  }
  if (state === 'queued') {
    return (
      <span className="tray-status">
        <span className="statusdot waiting"
          title="queued — waiting for a free turn slot" />
        <span className="tray-status-label waiting" title="queued">
          {stateLabel('queued')}
        </span>
        <span className="tray-status-time">
          {node.inflight_at ? ago(node.inflight_at) : '—'}
        </span>
      </span>
    )
  }
  if (state === 'compacting') {
    return (
      <span className="tray-status">
        <span className="tray-status-label compacting" title="compacting">
          {stateLabel('compacting')}
        </span>
        <span className="tray-status-time">
          {node.inflight_at ? ago(node.inflight_at) : '—'}
        </span>
      </span>
    )
  }
  if (node.frozen) {
    return <FrozenIcon fontSize="inherit" className="tray-frozen" />
  }
  if (node.state !== 'live') {
    return <span className="dim">{node.state}</span>
  }
  const recorded = node.last_status?.status ?? 'idle'
  return (
    <span className="tray-status">
      <span className={'statusdot ' + recorded}
        title={node.last_status?.summary ?? undefined} />
      <span className={'tray-status-label ' + recorded}>
        {stateLabel(recorded)}
      </span>
      {turn && (
        <span className="tray-status-time"
          title={'last turn ended ' + fmtStamp(turn.at) + (turn.killed ? ' (killed)' : '')}>
          {ago(turn.at)}
        </span>
      )}
    </span>
  )
}

/** Unified indicator dot for mapMode. */
export function MapModeIndicator({ node }: { node: CanvasNode }) {
  const state = deriveTurnState(node)
  if (isUsageFrozen(node)) return <FrozenIcon fontSize="inherit" className="tray-frozen" titleAccess="Frozen" />
  if (state === 'working') {
    return (
      <span title={node.inflight_at ? `active for ${ago(node.inflight_at)}` : 'active'}>
        <DestinationBusy tier={node.tier} />
      </span>
    )
  }
  if (state === 'queued') {
    return <span className="statusdot waiting" title="queued — waiting for a free turn slot" />
  }
  if (state === 'compacting') {
    return <span className="statusdot compacting" title="compacting" />
  }
  if (node.frozen) {
    return <FrozenIcon fontSize="inherit" className="tray-frozen" />
  }
  if (node.state !== 'live') {
    return <span className="map-off">{node.state}</span>
  }
  return (
    <span className={'statusdot ' + (node.last_status?.status ?? 'idle')}
      title={node.last_status?.summary ?? undefined} />
  )
}

/** Unified mapMode age chip subscribing to ageClockSecond. */
export function MapTurnAge({ node, turn }: { node: CanvasNode; turn?: TurnStat | null }) {
  useSyncExternalStore(subscribeAgeClock, () => ageClockSecond,
    () => ageClockSecond)
  const state = deriveTurnState(node)
  if (isUsageFrozen(node) && node.frozen) return <UsageFreezeStatus frozen={node.frozen} variant="map" />
  if (state !== 'idle') {
    return (
      <span className="map-ago"
        title={node.inflight_at ? `running for ${ago(node.inflight_at)}` : state}>
        {node.inflight_at ? ago(node.inflight_at) : '—'}
      </span>
    )
  }
  if (!turn) return null
  return (
    <span className="map-ago"
      title={'last turn ended ' + fmtStamp(turn.at) + (turn.killed ? ' (killed)' : '')}>
      {ago(turn.at)}
    </span>
  )
}

export type TurnBannerState = 'idle' | 'working' | 'queued' | 'compacting'

/** One persistent desk-header status/time seat. Its label and clock change
 * together at a turn boundary: active states measure the current admission,
 * while Idle measures the last completed turn. Canvas cards continue to use
 * LastTurnAge; the focused desk deliberately has no second age chip. */
export function TurnStatusBanner({ state, turn, inflightAt, tasks = 0,
  reportedSummary, recordedState, tier, frozen }: {
  frozen?: TreeFrozen | null;
  state: TurnBannerState; turn?: TurnStat | null; inflightAt?: string | null;
  tasks?: number | null; reportedSummary?: string | null; recordedState?: string | null;
  tier?: string | null
}) {
  useSyncExternalStore(subscribeAgeClock, () => ageClockSecond,
    () => ageClockSecond)
  if (frozen) return <UsageFreezeStatus frozen={frozen} variant="banner" />
  const active = state !== 'idle'
  const reference = active ? inflightAt : turn?.at
  const elapsed = reference ? ago(reference) : '—'
  const outOfTurnState = (!active && recordedState && recordedState !== 'idle') ? recordedState : null
  const displayClass = outOfTurnState || (state === 'working' ? 'working active' : state)
  const label = active
    ? (state === 'working' ? 'Active'
      : state === 'queued' ? 'Queued' : 'Compacting')
    : outOfTurnState
      ? (outOfTurnState.charAt(0).toUpperCase() + outOfTurnState.slice(1))
      : 'Idle'
  const taskText = (tasks ?? 0) > 0
    ? `${tasks} task${tasks === 1 ? '' : 's'}` : ''
  const title = !active
    ? (turn
      ? `${label} · last turn ended ${fmtStamp(turn.at)}`
        + (turn.killed ? ' (killed)' : '')
      : `${label} · no completed turn yet`)
        + (reportedSummary ? ` · ${reportedSummary}` : '')
    : [label, reference ? `active for ${elapsed}` : 'start time unavailable',
        taskText, reportedSummary].filter(Boolean).join(' · ')
  return <span className={`turn-status-banner ${displayClass}`} title={title}
    aria-label={title}>
    {state === 'working' &&
      <DestinationBusy tier={tier} />}
    {state === 'queued' &&
      <span className="statusdot waiting" />}
    <span className="turn-status-label">{label}</span>
    <span className="turn-status-time">{elapsed}</span>
  </span>
}

/** One compact process cue. Shape/glyph and text carry the state so colour is
 * never the only distinction; backend live/warm fields remain independent. */
export function ProcessLifecycleMark({ warm, live, relaunch, reason, busy,
  paused = false, controlEnabled = false, controlAction, controlReason,
  onToggle, tier }: {
  warm: boolean; live?: boolean; relaunch?: boolean; reason?: string | null;
  busy?: boolean; paused?: boolean; controlEnabled?: boolean
  controlAction?: 'start' | 'stop' | null; controlReason?: string | null
  onToggle?: () => void; tier?: string | null
}) {
  const isLive = live ?? warm
  // Colour answers use, not mere process existence: a claimed process takes
  // its provider theme even during the brief warm-to-claimed handoff; every
  // other live process is neutral standby. Relaunch keeps its warning state.
  const state = !isLive ? 'off' : busy ? 'active' : relaunch ? 'relaunch' : 'standby'
  const lifecycleTitle = isLive
    ? busy
      ? 'CLI process live — serving the current turn'
        + (relaunch ? `; will relaunch afterward: ${reason || 'reason unavailable'}` : '')
      : relaunch
        ? `CLI process live — will relaunch before its next turn: ${reason || 'reason unavailable'}`
        : warm
          ? 'CLI process live — parked on standby and ready for its next turn'
          : 'CLI process live — spawning or initializing; not ready yet'
    : paused
      ? onToggle
        ? 'CLI process manually stopped — click to enable pre-warming again'
        : 'CLI process manually stopped — enable pre-warming from the admin desk'
      : 'no CLI process live — starts normally on its next turn'
  const controlTitle = onToggle
    ? controlEnabled
      ? controlAction === 'stop'
        ? 'click to stop this parked CLI process'
        : 'click to start pre-warming for this agent'
      : `process control unavailable — ${controlReason || 'the agent is not idle'}`
    : ''
  const title = [lifecycleTitle, controlTitle].filter(Boolean).join('\n')
  const providerClass = tier ? ` prov-${providerOf(tier)}` : ''
  const cls = `proc-state ${state}${providerClass}${paused ? ' paused' : ''}${onToggle ? ' proc-toggle' : ''}`
  const mark = <>
    <span className="proc-one-mark" aria-hidden="true" />
    {relaunch && <AutorenewIcon fontSize="inherit" className="proc-relaunch" />}
  </>
  if (!onToggle) {
    return <span className={cls} title={title} aria-label={title}>{mark}</span>
  }
  return <button type="button" className={cls} title={title} aria-label={title}
    aria-pressed={paused} disabled={!controlEnabled} onClick={onToggle}>
    {mark}
  </button>
}

export function McpToolCountMark({ count, last, provider, source, reason,
  readinessState, readinessReason }: {
  count?: number | null; last?: number | null; provider?: string | null;
  source?: string | null; reason?: string | null;
  readinessState?: string | null; readinessReason?: string | null
}) {
  const known = typeof count === 'number'
  const hasLast = typeof last === 'number'
  const same = !hasLast || (known && count === last)
  // №21: an UNRESOLVED count is not an unknown NODE. The live count is null
  // for every window in which no provider process has published — the seconds
  // between a spawn and its `system/init`, and every idle stretch after a cold
  // process retires — which on a mostly-idle agent is most of the time. The
  // chip was rendering '—' through all of it while holding
  // `last_turn_mcp_tool_count` and showing it only on hover, so a node whose
  // surface we know perfectly well read as "unknown" (user report 2026-09-01,
  // measured: every one of five live nodes had a known last-turn count).
  //
  // So fall back to it, marked as what it is: `~27` means "27 last turn, not
  // resolved right now", never "27 right now". Only a node that has never
  // completed a turn — nothing measured, ever — still reads '—'.
  const stale = !known && hasLast
  const title = [
    known ? `current callable MCP tools: ${count}`
      : `current callable MCP tools: unknown${reason ? ` — ${reason}` : ''}`,
    hasLast ? `last successful turn: ${last}` : 'last successful turn: none',
    `provider/source: ${provider || 'unknown'} / ${source || 'unavailable'}`,
    readinessState
      ? `readiness: ${readinessState}${readinessReason ? ` — ${readinessReason}` : ''}`
      : '',
  ].filter(Boolean).join('\n')
  return <span className={'mcp-tool-count '
    + (!known ? (stale ? 'unknown stale' : 'unknown') : same ? 'same' : 'changed')}
    title={title} aria-label={title}>
    <span aria-hidden="true">MCP</span> {known ? count : stale ? `~${last}` : '—'}
  </span>
}

export function TurnStartingMark({ mcpWaiting, reason }: {
  mcpWaiting?: boolean; reason?: string | null
}) {
  const text = mcpWaiting ? 'Waiting for MCP tools…' : 'starting…'
  return <div className="msg live thinking sealed"
    title={mcpWaiting ? reason || 'Waiting for the prior MCP tool surface' : undefined}>
    <AutorenewIcon fontSize="inherit" className="cc-spin" /> {text}
  </div>
}

/** D-226. The badge renders READINESS and nothing else.
 *
 * ⚠ THIS REPLACES `defaultCompatibleForecast`, WHICH WAS D-214'S GREEN. That
 * helper turned `no_completed_fingerprint` on a supported lane green, arguing
 * that with no completed turn there is nothing to conflict with. The user
 * overruled it: green now requires AFFIRMATIVE evidence of compatibility, and
 * the absence of all evidence is not that. Do not reintroduce it — the case is
 * red now, and `test_cache_readiness` pins it.
 *
 * ⚠ AND AN UNREADABLE PAYLOAD IS NOT GREEN. A readiness value the badge does
 * not recognise, or a verdict that arrives without its cause, resolves to the
 * named `internal_error` diagnostic, because a badge that fails open is the
 * single most expensive lie this component can tell.
 *
 * ⚠ BUT A PAYLOAD WITH NO TRIPLE AT ALL IS A PRE-D-226 ROW, NOT A FAULT. A
 * backend older than this UI (the deployed build lagging a rebuilt `dist/`,
 * which is how this was first seen) sends `state`/`source`/`lane` and nothing
 * else. INV-002 says such a row "must not render grey": a schema migration is
 * not a fault, and labelling every idle node `internal_error` buried the one
 * grey that would have been a real incident. So the badge re-derives the
 * verdict exactly the way `cachecontinuity.legacy_readiness` does on the
 * server (same table, same expiry decay, same red-not-grey residue), and says
 * in the tooltip that it did so and why. `internal_error` is now reserved for
 * a payload that genuinely cannot be read: an unrecognised readiness value, a
 * verdict with no cause, or a row with neither a triple nor a known state.
 */
interface ReadinessVerdict { readiness: Readiness; cause: string; detail: string }

const READINESS_VALUES: ReadonlySet<string> = new Set(['ready', 'not_ready', 'diagnostic', 'none'])
const LEGACY_STATES: ReadonlySet<string> = new Set([
  'known_incompatible', 'expired_known_entry', 'uncertain', 'compatible_observed'])

/** Mirror of `cachecontinuity._LEGACY_CAUSE` — (state, source) → verdict for
 * a forecast persisted before D-226. Keep the two in step: the server applies
 * this to rows it healed itself; the badge applies it only when the server
 * sent no verdict at all. */
const LEGACY_CAUSE: Readonly<Record<string, readonly [Readiness, string]>> = {
  'compatible_observed/authoritative_receipt': ['ready', 'receipt_valid'],
  'compatible_observed/codex_subscription_fixed_estimate':
    ['ready', 'receipt_valid_codex_estimate'],
  'expired_known_entry/authoritative_receipt': ['not_ready', 'receipt_expired'],
  'expired_known_entry/codex_subscription_fixed_estimate':
    ['not_ready', 'receipt_expired'],
  'uncertain/no_completed_fingerprint': ['none', 'no_completed_fingerprint'],
  'uncertain/no_completed_turn': ['none', 'no_completed_fingerprint'],
  'uncertain/history_unobserved': ['not_ready', 'history_unobserved'],
  'uncertain/no_positive_receipt': ['not_ready', 'no_positive_receipt'],
  'uncertain/receipt_prefix_unobserved': ['not_ready', 'receipt_prefix_unobserved'],
  'uncertain/capability_unsupported': ['diagnostic', 'unsupported_capability'],
  'uncertain/clock_skew': ['diagnostic', 'clock_anomaly'],
}

const legacyReadiness = (forecast: CacheForecast): ReadinessVerdict => {
  let state: string = forecast.state
  // A persisted `compatible_observed` is a past tense and decays (D-B7): an
  // entry that was live when the row was written may have died since, and
  // healing it straight to green would invent the one thing this badge must
  // never invent. Equality is the boundary, as on the server.
  if (state === 'compatible_observed' && forecast.expires_at) {
    const at = Date.parse(forecast.expires_at)
    if (Number.isFinite(at) && Date.now() >= at) state = 'expired_known_entry'
  }
  const source = forecast.source || ''
  const lane = forecast.lane || ''
  let verdict = LEGACY_CAUSE[`${state}/${source}`]
  if (!verdict && source === 'ttl_unobserved') {
    // The one ambiguous source; the lane resolves its two unambiguous ends.
    if (lane === 'provider_unsupported') verdict = ['diagnostic', 'unsupported_capability']
    else if (lane === 'unobserved') verdict = ['not_ready', 'lane_unobserved']
  }
  if (!verdict && state === 'known_incompatible') verdict = ['not_ready', 'prefix_changed']
  // Residue is RED, never green and never a guessed grey: readiness is not
  // established, and the row says so instead of inventing a fault.
  if (!verdict) verdict = ['not_ready', 'legacy_forecast_unmigrated']
  const [readiness, cause] = verdict
  return {
    readiness, cause,
    detail: `Re-derived in the UI from a pre-D-226 forecast persisted as state `
      + `'${forecast.state}', source '${source || 'unobserved'}', lane `
      + `'${lane || 'unobserved'}': the backend sent no readiness verdict, so it `
      + 'predates D-226 — redeploy it to get server-side verdicts.',
  }
}

const internalError = (evidence: string): ReadinessVerdict => ({
  readiness: 'diagnostic', cause: 'internal_error',
  detail: `The badge could not read this forecast's readiness. ${evidence}`,
})

const readinessVerdict = (forecast: CacheForecast): ReadinessVerdict => {
  const raw: unknown = forecast.readiness
  if (raw === undefined || raw === null) {
    return LEGACY_STATES.has(String(forecast.state))
      ? legacyReadiness(forecast)
      : internalError('The payload carries neither a readiness verdict nor a '
        + `recognised state (state ${JSON.stringify(forecast.state)}).`)
  }
  if (typeof raw !== 'string' || !READINESS_VALUES.has(raw)) {
    return internalError(`Unrecognised readiness value ${JSON.stringify(raw)}.`)
  }
  if (!forecast.readiness_cause) {
    return internalError(`A '${raw}' verdict arrived with no readiness_cause.`)
  }
  return { readiness: raw as Readiness, cause: forecast.readiness_cause,
    detail: forecast.readiness_detail || '' }
}

const readinessOf = (forecast: CacheForecast): Readiness =>
  readinessVerdict(forecast).readiness

const readinessCause = (forecast: CacheForecast): string =>
  readinessVerdict(forecast).cause

const cacheForecastTitle = (forecast: CacheForecast, midTurn = false): string => {
  const ttl = typeof forecast.ttl_seconds === 'number'
    ? forecast.ttl_seconds === 3600 ? '60 minutes (subscription authentication)'
      : forecast.ttl_seconds === 1800 ? '30 minutes (Codex subscription estimate)'
      : forecast.ttl_seconds === 300 ? '5 minutes (API-key inference)'
        : `${forecast.ttl_seconds} seconds (derived from inference lane)`
    : 'unavailable'
  const readiness = readinessOf(forecast)
  const compatibility = readiness === 'ready'
    ? 'compatibility-ready — a positive receipt for this exact prefix is still inside its window (provider hit not guaranteed)'
    : readiness === 'not_ready'
      ? 'NOT compatibility-ready — compatibility is not established for the next turn'
      : readiness === 'none'
        ? 'no cache established — no completed turn has been observed yet'
        : `no verdict — ${readinessCause(forecast).replace(/_/g, ' ')}`
  const changed = forecast.changed_inputs?.length
    ? `changed components:\n${forecast.changed_inputs.map((v) => `• ${v}`).join('\n')}`
    : 'changed components: none reported'
  return [
    // Mid-turn the badge survives only for a claim the running turn cannot
    // change (see CacheForecastMark); say so, so the reader knows why this
    // one is still here while the countdown and the rest are not.
    midTurn ? 'a turn is running — the prefix has moved since it was sent: a message that '
      + 'steers into this turn is unaffected; one that misses the steer window lands cold' : '',
    `next-turn cache compatibility: ${compatibility}`,
    // D-226: a grey badge must ALWAYS be able to say why it is grey, and the
    // cause is machine-readable so a screenshot is still triage-able.
    `readiness: ${readiness} (${readinessCause(forecast)})`,
    // The server's detail when it sent one; the UI's account of a re-derived
    // or unreadable verdict otherwise — a grey must never arrive unexplained.
    readinessVerdict(forecast).detail,
    `reason: ${forecast.reason || 'unavailable'}`,
    changed,
    `lane/source: ${forecast.lane || 'unknown'} / ${forecast.source || 'unknown'}`,
    // Local time with the zone said out loud (user rule: no visible UTC). These
    // two lines predate timefmt.ts and were the last raw `Z` instants a desk
    // could show — found by LOOKING at the deployed build, 2026-09-05.
    `last authoritative inference receipt: ${fmtFull(forecast.last_receipt_at) || 'none'}`,
    `derived expiry: ${ttl}`,
    `expires at: ${fmtFull(forecast.expires_at) || 'not authoritatively known'}`,
    // The policy line describes a send that STARTS a turn. Mid-turn a send
    // steers into the turn already running, so the line is vacuous there and
    // is dropped rather than left to imply a cost that cannot occur.
    forecast.precompact_reason && !midTurn
      ? `pre-turn compaction: ${forecast.precompact_reason}` : '',
  ].filter(Boolean).join('\n')
}

/** The one claim that survives on the badge while a turn is running.
 *
 * User ruling 2026-09-03 (10:31Z and 10:34Z): the card answers "will the next
 * full turn cause a cache miss or an auto-compact?". Idle, the card always
 * shows, because the answer takes effect the instant a turn starts. Mid-turn
 * the answer can be given in advance ONLY when a miss is known for a fact;
 * anything else is predicting how the running turn ends, which the UI must
 * not try to do, so it shows no card at all — the yellow steer-window
 * warning or nothing. (Red mid-turn was the interim state; D-235 replaced it,
 * because red is a GUARANTEE of a miss and a steered message never pays one.)
 *
 *   · `not_ready` / `prefix_changed` is the fact. It compares the prefix that
 *     would be sent now against the one already sent (the backend takes it
 *     against the request in flight, D-235); whatever entry the running turn
 *     leaves behind belongs to the old prefix, so a message that misses the
 *     steer window lands cold regardless. It is the same fact the process
 *     mark's yellow relaunch icon shows from the lifecycle side.
 *   · `ready` and its countdown compare against the previous receipt, whose
 *     entry the running turn's own calls are refreshing — the countdown would
 *     reach zero and go red on an entry that is not dead. `receipt_expired`,
 *     `no_positive_receipt` and the unobserved causes describe the launch of
 *     the turn in flight, and its receipt settles them. A `diagnostic` says
 *     "cannot tell", which mid-turn is the default, not a card. None renders,
 *     and none leaves a placeholder in the slot.
 *
 * A backend that already projects mid-turn rows (`turn_in_flight`, readiness
 * `none`) makes this gate redundant; it stays for a backend older than the
 * UI, which still sends the idle verdict while a turn runs. */
const midTurnRenderable = (forecast: CacheForecast): boolean => {
  const { readiness, cause } = readinessVerdict(forecast)
  return readiness === 'not_ready' && cause === 'prefix_changed'
}

/** Epoch ms of an authoritative expiry, or null when there is not one.
 *
 * ⚠ ONLY `compatible_observed` QUALIFIES. `expires_at` is written beside a
 * POSITIVE receipt — the backend stamps it from the lane's real TTL when a
 * turn reported cache reads or writes — so it means "this observed entry dies
 * at T". A forecast that is merely *not known to be broken* has no entry and
 * no T, and counting down to one would invent confidence the backend never
 * claimed.
 *
 * ⚠ D-226 ADDS A SECOND LOCK: the countdown is GREEN-ONLY. Requiring
 * `readiness === 'ready'` as well as `compatible_observed` means a row whose
 * observational state and readiness ever disagree cannot produce a ticking
 * clock — it falls back to the readiness verdict, which is the one the user
 * ruled the badge must show.
 */
const cacheExpiryAt = (forecast: CacheForecast): number | null => {
  if (readinessOf(forecast) !== 'ready') return null
  if (forecast.state !== 'compatible_observed') return null
  if (typeof forecast.ttl_seconds !== 'number'
    || !Number.isFinite(forecast.ttl_seconds)
    || forecast.ttl_seconds <= 0) return null       // lane has no TTL semantics
  if (!forecast.expires_at) return null
  const at = Date.parse(forecast.expires_at)
  return Number.isFinite(at) ? at : null
}

/** `4:07`, or `1:02:59` once it passes an hour. Never negative: an expiry in
 * the past is `0:00`, which the caller stops rendering as green anyway. */
const countdownText = (msLeft: number): string => {
  const total = Math.max(0, Math.floor(msLeft / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}

/** Ticks once a second while an authoritative expiry is in the future.
 *
 * ⚠ THE STATE IS LOCAL AND STAYS LOCAL. This component owns its own interval
 * and its own `useState`; nothing above it re-renders on a tick. Lifting the
 * clock into the desk (or into a context) would re-render every card on the
 * canvas once a second, which on a large org is the whole point of the
 * measurement work this shipped alongside — a per-second full-canvas render is
 * far more expensive than the thing it would be reporting on.
 *
 * ⚠ AND IT RE-ARMS ON `expiresAt`, not on a mount. A resumed session, a new
 * receipt, or a provider/account/model namespace change all produce a NEW
 * `expires_at` from the backend; keying the effect on that value makes every
 * one of them reset the countdown for free, and makes a replacement receipt
 * indistinguishable from a fresh one — which is what it is.
 */
const noAgeClock = () => () => {}

function useCountdown(expiresAt: number | null): number | null {
  // ⚠ THE SHARED CLOCK, NOT A NEW ONE. `desk.tsx` is allowed exactly one
  // `setInterval` and a drift guard in `derived.test.mjs` counts them — the
  // deliberate design is one module-level pulse that every mounted badge
  // subscribes to, rather than one timer per agent. Adding a second timer here
  // was caught by that guard, which is the guard doing its job: on a large
  // canvas the per-card version is exactly the kind of cost the work this
  // shipped alongside exists to remove.
  //
  // A card with no countdown subscribes to nothing, so the common case does
  // not re-render once a second to display an unchanging glyph. Both subscribe
  // functions are module-level constants, so swapping between them is a real
  // re-subscribe and never a render-loop.
  useSyncExternalStore(expiresAt === null ? noAgeClock : subscribeAgeClock,
    () => ageClockSecond, () => ageClockSecond)
  // Derived from the wall clock on every pulse rather than decremented, so a
  // throttled background tab, a sleeping machine or a stepped clock lands on
  // the truth at the next pulse instead of drifting by however long it was
  // away. It also means a NEW `expires_at` — a replacement receipt, a resumed
  // session, a provider/account/model namespace change — takes effect on the
  // very next render with no reset logic to get wrong.
  return expiresAt === null ? null : expiresAt - Date.now()
}

/** User-selected three-state cache forecast: compatible green, known cold
 * red, unknown grey. Glyphs keep every state distinct without colour.
 *
 * The green card carries a LIVE COUNTDOWN to the observed entry's expiry in
 * place of the ✓ (user spec 2026-09-02) — never both, and never a countdown
 * without an authoritative expiry to count to. When the countdown reaches zero
 * the card stops being green on its own, without waiting for the backend to
 * re-forecast: the entry it was counting down to has expired, and continuing
 * to show green until the next poll would be the one lie this badge exists to
 * prevent.
 *
 * While a turn is running (`busy`) only the claim in `midTurnRenderable`
 * survives; the rest render nothing, and the countdown does not even subscribe
 * to the clock, because it is never shown mid-turn. */
export function CacheForecastMark({ forecast, busy }: {
  forecast?: CacheForecast | null
  busy?: boolean
}) {
  const expiresAt = forecast && !busy ? cacheExpiryAt(forecast) : null
  const left = useCountdown(expiresAt)
  // Hooks run before every early return on purpose — a null forecast must not
  // change the hook order.
  if (!forecast) return null
  const readiness = readinessOf(forecast)
  if (readiness === 'none'
      || forecast.readiness_cause === 'no_completed_fingerprint'
      || forecast.readiness_cause === 'no_completed_turn'
      || forecast.source === 'no_completed_fingerprint'
      || forecast.source === 'no_completed_turn') {
    return null
  }
  if (busy && !midTurnRenderable(forecast)) return null
  const live = left !== null && left > 0
  // ⚠ AN ELAPSED COUNTDOWN IS `expired_known_entry`, AND RENDERS AS ONE.
  // The backend already has a name and a colour for "a known entry passed the
  // derived boundary", and it is red, not grey. Demoting to grey here would
  // have the same fact wearing two different colours depending on which side
  // of a poll it was observed from. Grey is a named fault; this is not one.
  const expired = expiresAt !== null && !live
  // D-226: three outcomes, decided by readiness alone. An elapsed countdown
  // overrides `ready` locally rather than waiting for the next poll — the
  // whole point of counting down is to stop being green on time.
  const compatible = readiness === 'ready' && !expired
  const diagnostic = readiness === 'diagnostic' && !expired
  // Mid-turn the only card is the steer-window WARNING (user ruling
  // 2026-09-03 10:36Z, D-235): red and green are guarantees about the next
  // message sent — it will miss, it will hit — while this is conditional on
  // missing the window, so it wears the composer banner's yellow and a "!"
  // rather than the red × that would promise a miss a steered message never
  // pays. `midTurnRenderable` has already ensured this is `prefix_changed`.
  const steer = Boolean(busy)
  const cls = steer ? 'steer'
    : compatible ? 'compatible' : diagnostic ? 'uncertain' : 'cold'
  const body = steer ? '!'
    : compatible && live ? countdownText(left)
      : compatible ? '✓' : diagnostic ? '?' : '×'
  const title = steer
    ? cacheForecastTitle(forecast, true)
    : compatible && live
      ? `${cacheForecastTitle(forecast)}\nexpires in ${countdownText(left)}`
      : expired
        ? `${cacheForecastTitle(forecast)}\nthe observed cache entry has passed `
          + 'its derived expiry'
        : cacheForecastTitle(forecast)
  return <span className={`cache-forecast ${cls}`} title={title} aria-label={title}>
    <span aria-hidden="true">cache {body}</span>
  </span>
}

/** Send-time cache warnings. TWO independent cases, not one with extra gates.
 *
 * ── CASE 1 (checked first, and it OVERRIDES case 2): the mid-turn window ──
 * Fires on mid-turn AND confirmed-invalid readiness AND a focused composer.
 *
 * The reasoning is about a race the user cannot see. While a turn is running,
 * a message normally STEERS into it — it joins the turn in flight, costing no
 * new prefix and no compaction. But that window closes when the turn ends, and
 * a message that arrives just after it lands as a fresh turn instead, against
 * a prefix this forecast already says is not compatibility-ready. So the honest
 * warning here is conditional, not predictive: it is about what happens IF the
 * steer window is missed, which is why it says "if" and why it is always
 * YELLOW. Red is reserved for a cost that is actually expected; this one may
 * well cost nothing at all.
 *
 * ⚠ IT IS THRESHOLD-GATED ON MEASURED CONTEXT (user ruling 2026-09-02 19:19Z,
 * reversing 2dc8cbb's "deliberately not gated" stance): the same policy
 * `_cache_precompact_decision` applies to case 2, computed here from the
 * node's own numbers. Compactor OFF → only above the fixed 25% floor
 * (strict). Compactor ON → only at or above the compactor's own configured
 * threshold (`cheap_compact_occ`, inclusive — the destructive gate's
 * minimum). Unmeasured or estimated context never passes: neither policy
 * warns on a number it does not have. See `steerWarningGateOpen`.
 *
 * ⚠ "CONFIRMED INVALID" MID-TURN IS `prefix_changed` AND ONLY `prefix_changed`
 * (user ruling 2026-09-03, narrowing 2dc8cbb, which fired on every `not_ready`
 * cause). The banner's claim is that a message missing the steer window lands
 * COLD. That is settled only when the prefix has MOVED since the running turn
 * was sent — nothing the running turn does can undo it. Every other red cause
 * compares against an entry the running turn is about to write or refresh:
 * `receipt_expired` (the turn's own calls refresh it), `no_positive_receipt`
 * (the turn's receipt is what establishes it), and the unobserved causes. For
 * those a message that misses the window lands WARM, so warning about it was
 * a false alarm. `midTurnRenderable` applies the same rule to the badge.
 *
 * It is NOT gated on `precompact_action`: that field describes a send that
 * STARTS a turn, and the backend reports it `not_applicable` mid-turn.
 * `cheapCompactOn` reads the compactor's own `enabled` flag.
 *
 * ⚠ `cheapCompactOn` IS TRI-STATE. `true`/`false` are the backend's verdict on
 * this node's compactor; `undefined` means the backend did not report one (a
 * backend older than 2dc8cbb has no `cheap_compact_on` field at all). Absence
 * is not "off" (D-226): the "cache miss could occur" sentence asserts that
 * auto-compact is disabled, and rendering it on a missing field said exactly
 * that to a user whose compactor was on (user report 2026-09-02 19:13Z). So
 * the miss sentence is rendered ONLY on an explicit `false`; `undefined` gets
 * a sentence that names the cold turn without claiming what it will cost.
 *
 * ⚠ `midTurn` IS THE NARROW PREDICATE (an actually-running turn), not the
 * desk's broader `turnActive`. A queued or compacting agent has no steer
 * window to miss, so promising one would be fiction.
 *
 * ── CASE 2: the original past-threshold warning, unchanged ──
 * Cold, actionable, and reached only when case 1 does not apply.
 *
 * The gating props are REQUIRED. Defaulting them would let a future call site
 * silently get the old behaviour back, and a missing gate here is invisible:
 * the banner looks identical whether it was reasoned about or forgotten.
 */
/** The mid-turn banner's occupancy gate (see CacheForecastWarning). `ratio`
 * is measured context as a fraction of the window, or null when there is no
 * trustworthy measurement (empty, unmeasured, or a post-compaction estimate).
 *
 * Compactor ON without a reported threshold cannot come from a backend that
 * emits `cheap_compact_on` at all — api.py sets both fields from one config
 * read — so the 0.5 there is `_auto_cheap_cfg`'s own default, not a guess.
 * An UNREPORTED compactor (older backend) gets the 25% floor: it is the lower
 * of the two bars, and both policies agree nothing shows beneath it. */
const steerWarningGateOpen = (ratio: number | null, on: boolean | undefined,
  occ: number | null | undefined): boolean => {
  if (ratio == null || !Number.isFinite(ratio)) return false
  if (on === true) return ratio >= (typeof occ === 'number' ? occ : 0.5)
  return ratio > 0.25
}

export function CacheForecastWarning({ forecast, midTurn, composerFocused,
  cheapCompactOn, cheapCompactOcc, contextRatio }: {
  forecast?: CacheForecast | null
  midTurn: boolean
  composerFocused: boolean
  cheapCompactOn: boolean | undefined
  /** the compactor's threshold fraction; null = off, undefined = unreported */
  cheapCompactOcc: number | null | undefined
  /** measured context / window, or null when unmeasured or estimated */
  contextRatio: number | null
}) {
  // Mid-turn, "confirmed invalid" is `not_ready` WITH cause `prefix_changed` —
  // see the header comment. A grey diagnostic is the absence of a verdict, not
  // a negative one (D-226), and warning on it would be asserting something the
  // backend declined to say.
  const verdict = forecast ? readinessVerdict(forecast) : null
  const invalid = verdict?.readiness === 'not_ready'
    && verdict.cause === 'prefix_changed'
  if (forecast && midTurn && invalid && composerFocused
      && steerWarningGateOpen(contextRatio, cheapCompactOn, cheapCompactOcc)) {
    const title = cacheForecastTitle(forecast)
    return <div className="cache-send-warning midturn" role="status" title={title}>
      <WarnIcon fontSize="inherit" />
      <span>{cheapCompactOn === true
        ? 'Cache warning — if this message misses the mid-turn steer window, '
          + 'it will trigger a cheap-compact before delivery.'
        : cheapCompactOn === false
          ? 'Cache warning — a cache miss could occur before delivery if this '
            + 'message misses the mid-turn steer window (automatic cheap '
            + 'compaction is off).'
          : 'Cache warning — if this message misses the mid-turn steer window, '
            + 'it will start a fresh turn against a cold prefix (this backend '
            + 'does not report whether cheap-compact is on).'}</span>
    </div>
  }
  // ⚠ MID-TURN ENDS HERE, FOCUSED OR NOT. Case 2's whole sentence — "sending
  // will cheap-compact this session first" / "cache miss expected" — describes
  // a send that STARTS a turn. Mid-turn a send steers into the turn already
  // running, so that cost cannot occur and the banner is a false positive in
  // every mid-turn state, not merely the focused one. The focused case has
  // already been answered above by case 1; the unfocused case gets silence.
  if (midTurn) return null
  const cold = forecast?.state === 'known_incompatible'
    || forecast?.state === 'expired_known_entry'
  const actionable = forecast?.precompact_action === 'will_compact'
    || forecast?.precompact_action === 'miss_expected'
  if (!forecast || !cold || !actionable) return null
  const compacts = forecast.precompact_action === 'will_compact'
  const title = cacheForecastTitle(forecast)
  return <div className={`cache-send-warning ${compacts ? 'compact' : 'miss'}`}
    role="status" title={title}>
    <WarnIcon fontSize="inherit" />
    <span>{compacts
      ? 'Cache warning — sending will cheap-compact this session first.'
      : 'Cache miss expected — this session is known cold and automatic cheap compaction is off.'}</span>
  </div>
}

/* click-to-copy for the React-rendered pres (filepre/respre/diffpre) — same
   .codewrap/.code-copy contract as the md() pipeline, so the one delegated
   click listener in shared.ts serves both. The listener swaps the button's
   innerHTML for the transient ✓; React never re-renders past the
   dangerouslySetInnerHTML, so the two don't fight. */
function CopyablePre({ children }: { children: ReactNode }) {
  return (
    <div className="codewrap">
      {children}
      <button type="button" className="code-copy" title="Copy code"
        aria-label="Copy code" dangerouslySetInnerHTML={{ __html: CopyIcon }} />
    </div>
  )
}

const shortTool = (t: string | null | undefined) => (t || 'tool').replace(/^mcp__([^_]+)__/, '$1: ')

export function Activity({ act, dotOnly, tier }: { act?: ActivityInfo; dotOnly?: boolean; tier?: string | null }) {
  if (dotOnly) {
    return <DestinationBusy tier={tier} />
  }
  return (
    <div className="actlabel" title="active">
      <DestinationBusy tier={tier} />
      <span className="actlabel-text">{stateLabel('active')}</span>
    </div>
  )
}
// The desk is styled as a miniature Claude Code chat window (design ruling):
// compact one-line chrome, plain assistant text, boxed user turns, ⏺ tool
// lines, and a bordered composer with the model name in its footer row.
// №21: memoized — the spring engine re-renders the whole canvas every
// animation frame, and each open desk re-parsed its full transcript each
// time. The comparator checks the DATA props only; the callback props close
// over stable setters, so their per-render identities are ignorable.
export const DeskChat = DeskSlot
export const OwnedDeskChat = memo(DeskChatInner, (p, n) =>
  p.node === n.node && p.map === n.map && p.slug === n.slug
  && p.staleIdentity === n.staleIdentity && p.pub === n.pub && p.bare === n.bare && p.compact === n.compact
  && p.compactAt === n.compactAt && p.maxTop === n.maxTop && p.pxc === n.pxc)

export interface DeskChatProps {
  staleIdentity?: boolean
  node: CanvasNode
  map: Map<string, CanvasNode>
  op: OpFn
  slug: string
  toast: ToastFn
  onLineage?: () => void
  onConfig?: () => void
  onRecenter?: () => void
  /** camera move to a related agent (F-01 nav chips) — the same glide as
   *  clicking its card. USER as the id targets the eye/switchboard. */
  onJump?: (id: string) => void
  /** F-05: the org's top-level grant cap — the ask card's bar ceiling */
  maxTop?: number
  /** the org's px-per-credit (orgPxc) — the ask bar's scale */
  pxc?: number
  pub: boolean
  bare?: boolean
  compact?: boolean
  compactAt?: number
  onMailLink?: MailLinkFn
  /** open the docket at the item a work write acted on (user 2026-09-05) */
  onWorkLink?: WorkLinkFn
  /** FR-03: open a presented document in the in-page reader */
  onOpenDoc?: (id: string) => void
  /** card action requests the desk's Presented view after it opens */
  openPresentedRequest?: number
  /** FR-3: pin this desk to screenspace as a window (pins.tsx). Only the
   *  CANVAS desk passes it; absent hides the button — a switchboard panel,
   *  the mobile sheet and a pinned window itself have no pin to offer. */
  onPin?: () => void
}

/** F-01: one small clickable card pointing at a related agent — superior at
 *  the top of the desk, one per direct report at the bottom. Carries live
 *  state (busy spinner, unread mail count) because the data is already in
 *  `map`; an inert chip would be a lie of omission next to a busy agent. */
export function NavChip({ n, dir, onJump }:
{ n: CanvasNode; dir: 'up' | 'down'; onJump: (id: string) => void }) {
  const eye = n.id === USER
  // the chip's accent and unread count belong to the DESTINATION agent, not
  // to whichever provider's themed desk this chip happens to render inside
  const prov = !eye && n.tier ? ' prov-' + providerOf(n.tier) : ''
  return <span className="desk-nav-entry">
    <button className={'desk-nav-chip' + (!eye && n.state !== 'live' ? ' dim' : '') + prov}
        title={eye ? 'jump to the switchboard'
          : `jump to ${n.id}${n.state !== 'live' ? ` (${n.state})` : ''}`}
        onClick={() => onJump(n.id)}>
        {dir === 'up' ? <ArrowUpIcon fontSize="inherit" /> : <ArrowDownIcon fontSize="inherit" />}
        {eye
          ? <><EyeIcon fontSize="inherit" /> switchboard</>
          : <><span className={'tier t-' + n.tier}>{TIER_LETTER[n.tier!] ?? '?'}</span>
              {n.id}</>}
        {n.busy && <DestinationBusy tier={n.tier} />}
        {(n.mail_pending ?? 0) > 0 &&
          <b className={'eye-count' + prov}>{n.mail_pending}</b>}
      </button>

  </span>
}

/** the slice of a card the spend badge reads — CanvasNode does not declare
 *  every additive TreeNode field, and synthetic cards carry a subset */
type SpendNode = {
  cost_usd?: number | null
  cost_usd_unknown?: boolean
  turns?: TurnStat[] | null
  last_denials?: Denial[] | null
  last_approvals?: Denial[] | null
}

/** The header's $ badge — the per-turn ring in its tooltip (№15) and, under
 *  it, the ⚙-rights rows behind the ring's counts.
 *
 *  ⚠ THE GATE IS THE BEHAVIOUR (exported for `rightsbadge.test.tsx`): spend
 *  alone must not decide it, because a complete SUBSCRIPTION turn costs a
 *  real, known $0.00 and would hide the rights rows with the badge. Rights
 *  open it on their own, off the SAME five turns the tooltip renders, so a
 *  badge opened for rights always has rights in it. A known zero prints as
 *  $0.00, never as an estimate.
 *
 *  ⚠ AND THE SAME TRAP CLAIMED THE REPORTED METADATA (2026-09-05, caught in
 *  review before it shipped). A free or known-zero OpenRouter turn with no
 *  denials and no approvals passed the gate at `false` — and this tooltip is
 *  the ONLY place the reported upstream is rendered, so the whole surface
 *  vanished on exactly the turns a free model is used for. It opens the
 *  badge on the same terms as rights: presence over the SAME five turns, so
 *  a badge opened for metadata always has that metadata in it. */
export function SpendBadge({ node }: { node: SpendNode }) {
  const cost = node.cost_usd ?? 0
  const costUnknown = node.cost_usd_unknown === true
  const turns = (node.turns ?? []).slice(-5).reverse()
  /* the rows behind those counts, for the LAST turn only (all the node
     carries). "approved" means the seam said yes to a sandbox-blocked
     request — never that the command ran. */
  const rights = [
    ...(node.last_denials ?? []).map((d) =>
      `denied · ${d.tool}${d.arg ? ` · ${d.arg}` : ''}`
      + (d.cwd ? ` · in ${d.cwd}` : '')),
    ...(node.last_approvals ?? []).map((d) =>
      `approved · ${d.tool}${d.arg ? ` · ${d.arg}` : ''}`
      + (d.cwd ? ` · in ${d.cwd}` : '')),
  ]
  const anyRights = rights.length > 0
    || turns.some((t) => (t.denials ?? 0) > 0 || (t.approvals ?? 0) > 0)
  /* …the same test for the reported upstream, over the same five turns */
  const anyReported = turns.some((t) => reportedLabel(t.reported) !== '')
  if (!(cost > 0 || costUnknown || anyRights || anyReported)) return null
  return (
    <span className="badge dim"
      title={[
        turns.map((t) =>
          `${fmtShort(t.at)} · $${(t.cost ?? 0).toFixed(2)}`
          + (t.estimated ? ' est.' : '')
          + (t.cost_source ? ` · ${t.cost_source}` : '')
          + (reportedLabel(t.reported) ? ` · ${reportedLabel(t.reported)}` : '')
          + (t.cost_unknown_fields?.length
            ? ` · unresolved: ${t.cost_unknown_fields.join(', ')}` : '')
          + (t.ms ? ` · ${Math.round(t.ms / 1000)}s` : '')
          + (t.denials ? ` · ${t.denials} denied` : '')
          + (t.approvals ? ` · ${t.approvals} approved` : '')
          + (t.killed ? ' · killed' : '')).join('\n')
          || 'per-turn detail appears after the next turn',
        ...rights,
      ].join('\n')}>
      {costUnknown
        ? (cost > 0 ? `$${cost.toFixed(2)} estimated/incomplete` : '$?')
        : `$${cost.toFixed(2)}`}</span>
  )
}

// how long the send receipt (§№11) stays up — long enough to read a routing
// word you were not expecting, short enough that it never describes a message
// that has already been answered
const SENDMODE_MS = 6000

function DeskChatInner({ node, map, op, slug, toast, onLineage, onConfig,
  onRecenter, onJump, maxTop, pxc, pub, bare = false, compact = false,
  compactAt, onMailLink, onWorkLink, onOpenDoc, onPin, openPresentedRequest,
  staleIdentity = false }: DeskChatProps) {
  // THE CONVERSATION IS NOT THIS COMPONENT'S. It lives in one per-node store
  // (convo.ts) that every view of this node subscribes to, because a node can
  // be on screen twice — its card and its switchboard panel — and two private
  // copies of one conversation diverge by construction (user bug 2026-08-02:
  // "the switchboard desk going out of sync with the individual agent desks").
  // What stays local below is only what is genuinely per-VIEW: this desk's
  // scroll position, its open tab, its composer draft.
  const surface = useSurface()
  const surfaceDocument = useSurfaceDocument()
  const convo = useConvo(slug, node.id)
  const providerClass = node.tier ? ' prov-' + providerOf(node.tier) : ''
  const processClass = node.state === 'live'
    ? (node.proc_warm ? ' proc-warm' : ' proc-cold') : ''
  const { chat, live_feed, draft, thinking, thinkSecs, pending } = {
    chat: convo.chat, live_feed: convo.live, draft: convo.draft,
    thinking: convo.thinking, thinkSecs: convo.thinkSecs, pending: convo.pending }
  // №2: the draft survives the camera — persisted per node on every keystroke
  // (clicking a sibling card unmounts this whole component)
  const draftKey = `orgtree-draft-v2-${JSON.stringify([slug, node.id, node.generation])}`
  const [text, setTextRaw] = useState(() => {
    try { return localStorage.getItem(draftKey) || '' } catch { return '' }
  })
  const setText = useCallback((v: string | ((prev: string) => string)) => setTextRaw((prev) => {
    const next = typeof v === 'function' ? v(prev) : v
    try {
      if (next) localStorage.setItem(draftKey, next)
      else localStorage.removeItem(draftKey)
    } catch { /* private mode */ }
    return next
  }), [draftKey])
  const [reply, setReplyRaw] = useState<ReplyContext | null>(() => readReply(draftKey))
  const setReply = (next: ReplyContext | null) => { setReplyRaw(next); storeReply(draftKey, next) }
  const replyMenu = useContextMenu()
  const openReply = (e: ReplyMouseEvent, row: { event_id?: string }) => {
    const target = (e.target as Element).closest?.<HTMLElement>('[data-reply-event]')
    const exact = target && e.currentTarget.contains(target) ? target : e.currentTarget
    const quote = exact.getAttribute('data-reply-quote') ?? exact.textContent?.trim() ?? ''
    const event_id = exact.hasAttribute('data-reply-event') ? exact.getAttribute('data-reply-event') ?? undefined : row.event_id
    const source = replyFromRow(slug, node.id, node.generation ?? 0, { event_id }, quote)
    replyMenu.open(e, [{ label: 'Reply', disabled: !source || staleIdentity,
      title: source ? 'Reply to this exact chat event' : 'This event has no durable source reference yet',
      onSelect: () => { if (source) {
        setReply(source); setView('chat')
        // show-reply-context-on-sent-user-messages (user spec, 2026-09-09
        // 14:16:54): starting a reply must land the cursor in the message
        // box, not just open it. `setView` may still be mounting the chat
        // tab's own textarea this same tick (switching FROM another tab —
        // files, history — the composer is not in the DOM yet), so a
        // synchronous `taRef.current?.focus()` here would silently do
        // nothing on that path; defer one frame so React has committed
        // the tab switch first. `taRef` is declared later in this same
        // component body, but closures resolve free variables at CALL
        // time, not definition time, and this only ever runs from a later
        // click — never during the render that defines it.
        requestAnimationFrame(() => taRef.current?.focus())
      } } }])
  }
  const sameReplyIdentity = (r: ReplyContext) => r.org === slug && r.agent === node.id && r.generation === (node.generation ?? 0)
  const sourceIds = new Set([
    ...(chat?.messages ?? []).flatMap(m => [m.event_id, m.thinking_event_id,
      ...(m.tools ?? []).flatMap(t => [t.event_id, t.result_event_id])]),
    ...live_feed.map(r => r.event_id), ...(chat?.pending_mail ?? []).map(r => r.event_id),
  ].filter(Boolean))
  const transient = (chat?.transient ?? []).filter(r => {
    if (!r.event_id || sourceIds.has(r.event_id)) return false
    // A poll can precede the latest immutable stream revision. Never let its
    // older snapshot hide the text and source received since that request.
    if (['draft', 'delta'].includes(r.kind) && convo.draft && convo.draftEventId
      && r.event_id !== convo.draftEventId) return false
    if (['thinking', 'thinking_start', 'thought'].includes(r.kind) && convo.thinking && convo.thinkingEventId
      && r.event_id !== convo.thinkingEventId) return false
    return true
  })
  const transientThinking = transient.some(r => ['thinking', 'thinking_start', 'thought'].includes(r.kind))
  const transientDraft = transient.some(r => ['draft', 'delta'].includes(r.kind))
  const replyAvailable = (r: ReplyContext) => sameReplyIdentity(r) &&
    (sourceIds.has(r.eventId) || transient.some(row => row.event_id === r.eventId)
      || r.eventId === convo.draftEventId || r.eventId === convo.thinkingEventId)
  const locateReply = (r: ReplyContext) => {
    if (!sameReplyIdentity(r)) return
    const element = [...surfaceDocument.querySelectorAll<HTMLElement>('[data-reply-event]')]
      .find(el => el.dataset.replyEvent === r.eventId)
    element?.scrollIntoView?.({ block: 'center' })
  }
  const renderReply = (wire: unknown) => {
    const context = replyContext(wire)
    return context && <ReplyPreview reply={context} available={replyAvailable(context)} onLocate={() => locateReply(context)} />
  }
  const [recoveryRevision, setRecoveryRevision] = useState(0)
  const recoveryDrafts = useMemo(() => recoverableDrafts(slug, node.id, node.generation),
    [slug, node.id, node.generation, recoveryRevision])
  const [legacyDraft, setLegacyDraft] = useState(() => {
    try { return localStorage.getItem(`orgtree-draft-${slug}-${node.id}`) || '' } catch { return '' }
  })
  // №11: which door the last send went through. It is a RECEIPT, not a state —
  // it answers "where did that message just go", and that answer goes stale the
  // moment the queue drains. It had no clear at all (user bug 2026-08-02: the
  // "delivering" line sat under the composer forever), so it expires. Anything
  // durable has its own surface: the per-message "delivering mid-task…" tag,
  // the frozen badge, the mail count.
  const [sendMode, setSendMode] = useState('')
  const modeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashMode = useCallback((m: string) => {
    setSendMode(m)
    if (modeTimer.current) clearTimeout(modeTimer.current)
    modeTimer.current = m ? setTimeout(() => setSendMode(''), SENDMODE_MS) : null
  }, [])
  useEffect(() => () => { if (modeTimer.current) clearTimeout(modeTimer.current) }, [])
  // 'dissolve' | 'retire' — retire JOINED this (user bug 2026-08-09: "retire
  // on desk view has no confirmation"). It sat alone as the one seat-freeing
  // action that fired straight off the click, next to a dissolve button that
  // asks; a mis-click stopped an agent mid-work and the undo lived in a toast
  // that scrolls away.
  const [asking, setAsking] = useState<'dissolve' | 'retire' | null>(null)
  const [askCompact, setAskCompact] = useState(false)
  // F-01 footer: retired reports collapsed behind one chip (user ruling)
  const [showRetired, setShowRetired] = useState(false)
  // The process control is a server-side CAS. This local latch only prevents
  // a double-click while the request is in flight; the response/WS tree state
  // remains authoritative if another desk wins the race.
  const [processToggleBusy, setProcessToggleBusy] = useState(false)
  const [view, setView] = useState<'chat' | 'history' | 'files' | 'inbox' | 'docket' | 'presented'>('chat')     // chat | history | files | inbox | docket | presented
  useEffect(() => {
    if (openPresentedRequest !== undefined) setView('presented')
  }, [openPresentedRequest])
  // THE AGENT'S OWN DOCKET (user ruling 2026-09-05 21:07). It replaced the
  // derived task-progress model that used to live in this tab — the user
  // called that content irrelevant, and what an agent is answerable for is
  // recorded work, not a reading of its transcript.
  //
  // ⚠ ONE POLL, OWNED HERE. The tab and the header chip must count the same
  // rows, so the desk fetches and `agentItems` selects; two independent polls
  // would eventually disagree on screen. It is the same endpoint the Work
  // panel uses, at a slower interval — this is a summary, not the panel.
  const [workBump, setWorkBump] = useState(0)
  const [showArchivedDocket, setShowArchivedDocket] = useState(false)
  const work = usePolled(() => getWorkItems(slug, true, true),
                         [slug], 15000, `${workBump}`)
  const myWork = useMemo(() => agentItems(work, node.id, showArchivedDocket),
    [work, node.id, showArchivedDocket])
  const docketCount = useMemo(() => agentItems(work, node.id, true)?.filter(item =>
    !['done', 'dropped', 'superseded'].includes(item.status) && !item.superseded_by).length ?? 0,
    [work, node.id])
  const tabCount = (tab: string) => tab === 'inbox' ? chat?.mail_pending ?? 0
    : tab === 'docket' ? docketCount
      : tab === 'presented' ? node.documents_count ?? node.documents?.length ?? 0 : 0
  // the identity facts the docket rows read (which model an owner ran under,
  // whether that seat is still live) — the same shape the Work panel builds,
  // from the canvas map this desk already holds rather than a second fetch
  const workFacts = useMemo(
    () => new Map([...map].map(([id, n]) => [id, {
      tier: n.tier ?? '',
      generation: Number(n.generation ?? 0),
      live: n.state === 'live',
    }])), [map])
  // №7's denials banner and its dismissal state are gone (user bug
  // 2026-08-02): a denial already renders inline as an errored ToolChip where
  // it happened, so the banner was a duplicate that also sorted a past event
  // below undelivered mail. Nothing needs dismissing that lives in sequence.
  // (live_feed / draft / thinking / thinkSecs / pending all come from the
  // store above — they were seven local cells and a pair of refs here, which
  // is exactly how two views of one node ended up with two different answers.)
  const scroller = useRef<HTMLDivElement | null>(null)
  const loadedRef = useRef(false)     // first load always lands at the bottom
  const live = node.state === 'live'
  // sticky-bottom, in one place. `stuck` is maintained by the SCROLL EVENT
  // rather than recomputed at each update: growing content does not move
  // scrollTop, so a reader sitting at the bottom stays "stuck" and a reader who
  // scrolled up stays free until they come back down. 40px of slack keeps it
  // from unsticking on a stray pixel.
  const stickRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const nearBottom = () => {
    const el = scroller.current
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }
  const setStuck = (v: boolean) => {
    stickRef.current = v
    setShowJump((s) => (s === !v ? s : !v))   // only re-render on a real flip
  }
  const pin = () => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }
  // AFTER the DOM commit, before paint: a bare requestAnimationFrame scheduled
  // during an event handler can fire BEFORE React commits the new rows, so it
  // read the OLD scrollHeight and landed short — that was the "gets left
  // behind" bug. A layout effect measures post-commit, so it cannot miss.
  // Windowed transcript: only the newest CHAT_WINDOW rows are fetched and
  // rendered; scrolling to the top loads another page. A long-lived agent's
  // transcript is unbounded, and the cost that actually bites is DOM size —
  // every row carries markdown and tool chips. The server stamps `seq` as the
  // PRE-slice ordinal, so messages[0].seq > 0 means older rows exist.
  const loadingOlder = convo.loadingOlder
  // distance-from-bottom is invariant when older rows are PREPENDED, so it is
  // the anchor that keeps the reader's place instead of jumping them down
  const growAnchor = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = scroller.current
    if (stickRef.current) { pin(); calcPin(); return }
    if (el && growAnchor.current != null) {
      el.scrollTop = el.scrollHeight - growAnchor.current
      growAnchor.current = null
    }
    calcPin()   // FR-20: content growth moves the target without a scroll event
  })
  // seq is the PRE-slice ordinal, so a non-zero first seq means older rows exist
  const hasOlder = (chat?.messages[0]?.seq ?? 0) > 0
  const toBottom = () => { setStuck(true); pin() }
  // Only explicit canonical actors establish authorship; legacy text stays readable.
  const userTurns = useMemo(() => {
    const out: { seq: number, label: string }[] = []
    for (const m of chat?.messages ?? []) {
      if (m.role !== 'user' || m.seq == null) continue
      const label = authoredUserLabel(m.segments, BASE ? 'public' : 'operator')
      if (label !== null) out.push({ seq: m.seq, label })
    }
    return out
  }, [chat])
  const userSeqs = useMemo(() => new Set(userTurns.map((u) => u.seq)), [userTurns])
  const userRowEls = useRef(new Map<number, HTMLDivElement>())
  const [pinSeq, setPinSeq] = useState<number | null>(null)
  // The chip's text is clamped to three lines and faded where it is cut.
  // Whether it IS cut is a measurement, never a guess: the same label wraps
  // to one line in a wide panel and to five in a narrow one, and a fade over
  // text that ended on its own reads as lost content. Measured in calcPin,
  // so it is re-checked on exactly the occasions the wrap can change — a
  // render (new label), a scroll, and a resize (the ResizeObserver below).
  // Safe from the resize observer's own feedback path by construction: the
  // flag adds a MASK, which paints and never lays out, so a measurement here
  // can never move the box the observer is watching.
  const pinRef = useRef<HTMLButtonElement | null>(null)
  const pinTextRef = useRef<HTMLSpanElement | null>(null)
  const [pinClip, setPinClip] = useState(false)
  // rect-based, not offsetTop: the row's offsetParent is not reliably the
  // scroller. Only a row fully above the scrollport can be the target — a
  // reader who scrolled UP past every user turn has them all BELOW, and a
  // chip that points the wrong way is jumpbottom's territory, not this one's.
  const calcPin = () => {
    const el = scroller.current
    let v: number | null = null
    if (el) {
      // The chip is an overlay outside this scroller, so this threshold is in
      // a stable coordinate system. Earlier code compensated by the chip's
      // height, but missed the flex gap (and any future margins): the row still
      // moved farther than the threshold and #185 survived in that band.
      const top = el.getBoundingClientRect().top + 4
      // newest→oldest: the LAST user turn above the scrollport is the nearest
      // one, i.e. the row "↑" actually points at from where the reader stands
      for (let i = userTurns.length - 1; i >= 0; i--) {
        const u = userTurns[i]
        const t = u && userRowEls.current.get(u.seq)
        if (u && t && t.getBoundingClientRect().bottom < top) { v = u.seq; break }
      }
    }
    setPinSeq((s) => (s === v ? s : v))   // only re-render on a real flip
    const t = pinTextRef.current
    const cut = !!t && t.scrollHeight - t.clientHeight > 1
    setPinClip((c) => (c === cut ? c : cut))
  }
  // ⚠ A RESIZE IS NOT A RENDER. The switchboard lays its panels out with flex
  // (`.eye-panel { flex: 1 }`), so opening or closing ONE tab re-widths every
  // OTHER panel with no prop change at all — and DeskChat is memoized (№21),
  // so those panels neither re-render nor run the layout effect above. The
  // narrower column re-wraps its markdown, scrollHeight moves, scrollTop does
  // not, and a reader who was stuck at the bottom silently ends up above it
  // with the new messages arriving off-screen (user bug 2026-08-19). The same
  // hole swallows every other non-React size change: the window resizing (it
  // moves `eyeW`, hence every panel's width), the tab strip wrapping to a
  // second line and stealing height from the panel row, the composer's
  // `grow()` writing `style.height` imperatively as a draft gets longer, the
  // mobile keyboard resizing the sheet, a font finishing its load. (NOT the
  // eye cell's .35s width transition — `.eye-inner` is sized from the
  // VIEWPORT via `eyeW`, so its interior width is constant while the cell
  // animates, and `.desk-over` clips rather than re-lays-out.) What keeps this
  // off the spring engine's per-frame path is stronger than that argument
  // though: a ResizeObserver reports the PRE-TRANSFORM box, so neither
  // `.desk-inner`'s `scale()` nor any camera zoom can ever fire it. A ResizeObserver is the only hook that sees all of them; its
  // callback runs after layout and before paint, so scrollHeight is already
  // the post-reflow value, and setting scrollTop inside it cannot re-trigger
  // it (scroll position is not size).
  //
  // It rides the scroller's REF CALLBACK rather than an effect with a dep
  // list: an observer left watching a detached element never fires again and
  // says nothing about it, which is the same silent class of failure as the
  // bug itself. React hands this the element on attach and null on detach, so
  // the observer cannot outlive or lag behind the node it watches.
  // `calcPin` goes through a ref because the observer outlives the render that
  // created it and the pin target depends on the latest render's userTurns.
  const calcPinRef = useRef(calcPin)
  calcPinRef.current = calcPin
  const roRef = useRef<ResizeObserver | null>(null)
  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    scroller.current = el
    // no ResizeObserver (a pre-2020 browser) degrades to the old behaviour:
    // the layout effect above still covers every React-driven growth
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      // ⚠ The else branch is not symmetry for its own sake. A panel that gets
      // WIDER re-wraps SHORTER, so the browser clamps a scrolled-up reader's
      // scrollTop — and can deposit them at the bottom without them ever
      // scrolling. `stickRef` would stay false, the ⇩ chip would sit there
      // over an already-bottomed view, and the next agent message would not
      // pin: the exact silent failure this whole observer exists to prevent,
      // reached through its own path. Browsers do fire a scroll event on a
      // clamp, which would heal it — but a fix that depends on that is an
      // argument, and this is a guard. `nearBottom()` is the same 40px
      // predicate onScroll uses, so this can only ever agree with it.
      if (stickRef.current) pin()
      else setStuck(nearBottom())
      calcPinRef.current()
    })
    ro.observe(el)
    roRef.current = ro
  }, [])
  const pinTarget = pinSeq == null ? null
    : userTurns.find((u) => u.seq === pinSeq) ?? null
  const loadOlder = () => {
    const el = scroller.current
    if (!el) return
    growAnchor.current = el.scrollHeight - el.scrollTop
    if (!storeLoadOlder(slug, node.id)) growAnchor.current = null
  }

  // Ingestion of stream/pulse events, the transcript fetch, the live/durable
  // reconciliation and the busy poller ALL moved into convo.ts. They used to
  // live here, which meant every mounted view ran its own copy of each — the
  // divergence the store exists to make impossible. What is left is this
  // view's business: ask for a first load, and re-stick the scroll when the
  // store hands back a payload this view has not seen yet.
  const refresh = useCallback((force = false) => {
    if (force) setStuck(true)
    return refreshConvo(slug, node.id, { force })
  }, [slug, node.id])
  // ⭐ WHERE A PENDING BUBBLE BELONGS IS A QUESTION ABOUT WHOSE TURN IT IS.
  // `delivering` + `via:'turn'` means the mailbox has already handed this
  // message to the turn that is running now: it is that turn's QUESTION, and
  // everything live below is that turn's answer, so it sorts above them. Every
  // other pending entry is still waiting for a turn that has not started, so it
  // sorts after the running turn's output — which is where they all used to
  // sit, question and all (user report 2026-09-01).
  // Steered mail (`delivering`, no `via`) stays below too: it arrived DURING
  // the turn, so the live rows above it really did happen first.
  // ── MESSAGE-VISIBILITY INVARIANT (user ruling 2026-09-10 13:22Z, canonical
  // in message-visibility-invariant.md): every message is visible EXACTLY
  // ONCE across pending → arriving → sent. For a submitted ask answer the
  // QUESTION PANEL is the pending representation: it stays pinned — never
  // also a pending bubble — until the answer mail actually RENDERS in the
  // transcript, and the handoff is atomic because both facts (the transcript
  // row and the pending row) come out of the SAME chat payload the desk is
  // rendering. Server acceptance, the tree payload flipping ask.status, or a
  // planned refresh are explicitly NOT enough to unpin.
  const ask = node.ask
  const askLive = !!ask && (ask.status === 'open' || ask.status === 'pending')
  // the mail the answer travelled as (stamped by the backend at resolution)
  const answerMail = !askLive ? ask?.answer_mail : undefined
  const rawPendMail = chat?.pending_mail ?? []
  const answerInTranscript = useMemo(() => {
    if (!answerMail || !chat) return false
    for (const row of [...chat.messages, ...(chat.live ?? [])]) {
      const segs = (row as { segments?: unknown }).segments
      if (!Array.isArray(segs)) continue
      for (const seg of segs as { kind?: string; rows?: { id?: string | null }[] }[]) {
        if (seg?.kind === 'mail' && (seg.rows ?? []).some(r => r?.id === answerMail)) return true
      }
    }
    return false
  }, [answerMail, chat])
  // "was ever listed as pending, and no longer is" — the answer scrolled into
  // (or past) the transcript window; latched per mail id so the check cannot
  // fire in the gap BEFORE the first payload lists the freshly-posted mail
  const answerSeenPending = useRef<string | null>(null)
  if (answerMail && rawPendMail.some(m => m.id === answerMail)) answerSeenPending.current = answerMail
  const answerHandedOff = !answerMail ? true
    : answerInTranscript || (answerSeenPending.current === answerMail
      && convo.loaded && !rawPendMail.some(m => m.id === answerMail))
  // never a separate pending bubble for a message the panel represents: the
  // resolved answer by its stamped id, and — race-proof, straight from the
  // payload — any answer-decision event that references THIS card, which
  // covers the window before the tree payload delivers the stamp
  const askAnswerRow = (m: PendingMail): boolean => {
    if (!ask) return false
    if (answerMail && m.id === answerMail) return true
    const d = decodeEventRow(m, BASE ? 'public' : 'operator')
    if (d.kind !== 'known') return false
    const ev = d.event as { variant: string; object?: { kind?: string; id?: string } | null }
    return (ev.variant === 'answer.ask' || ev.variant === 'answer.batch')
      && String(ev.object?.id ?? '') === String(ask.id)
  }
  const pendMail = rawPendMail.filter((m) => !askAnswerRow(m))
  const pendNow = pendMail.filter((m) => m.delivering && m.via === 'turn')
  const pendLater = pendMail.filter((m) => !(m.delivering && m.via === 'turn'))
  // ONE renderer, two places (it is the same bubble; only its position says
  // something different) — the shared PendingMailRow, so the browser parity
  // probe measures exactly what this desk mounts.
  const pendBubble = (m: PendingMail) => (
    <PendingMailRow key={m.id ?? m.at} m={m} slug={slug} nid={node.id}
      world={deskRefs.world} onOpen={deskRefs.onOpen}
      replyAvailable={replyAvailable} onLocateReply={locateReply}
      onContext={e => openReply(e, m)}
      onRetract={() => retractMail(slug, node.id, m.id!)
        .then(() => refresh(true))
        .catch((e: Error) => toast([`error: ${e.message}`]))} />
  )
  useEffect(() => {
    if (!convo.loaded) void refreshConvo(slug, node.id)
  }, [slug, node.id, convo.loaded])
  useEffect(() => {
    // the FIRST payload this view sees lands it at the bottom, whether the
    // store fetched it for us or another view had already loaded it
    if (convo.loaded && !loadedRef.current) { loadedRef.current = true; setStuck(true) }
  }, [convo.loaded])   // eslint-disable-line react-hooks/exhaustive-deps
  // (the busy-gated poller that lived here is gone. Liveness is now driven by
  // SUBSCRIPTION inside convo.ts: if a view is watching a node, that node is
  // polled. Gating it on chat.busy meant the refresh loop depended on a field
  // that arrives in the payload the loop fetches — so a view that started out
  // believing "not busy" could never learn otherwise. See convo.beat().)

  // an archived agent still RECEIVES mail (user ruling) — it queues in its
  // inbox and gets acted on at rehire; only unrecoverable nodes refuse
  const canMail = !staleIdentity && (live || node.state === 'archived')
  const send = () => {
    let t = text.trim()
    if ((!t && !attached.length) || !canMail) return
    if (!t) t = '(file attached)'
    const paths = attached.map((a) => a.path)
    const sentReply = reply
    setReply(null)
    setText('')
    setAttached([])
    // optimistic ghost only until the server confirms — the durable copy
    // then renders from chat.pending_mail (№11); a failed send clears the
    // ghost instead of leaving a dimmed bubble forever
    const ghostId = addPending(slug, node.id, t, sentReply, attached)
    if (live) markBusy(slug, node.id)
    flashMode('')   // the previous send's receipt must not outlive this one
    toBottom()
    sendMessage(slug, node.id, t, paths, sentReply ? replyWire(sentReply) : undefined)
      .then((r) => {
        bindPendingMail(slug, node.id, ghostId, r)
        // review C3: name every real outcome — "delivering" as the fallback
        // lied for frozen nodes (mail waits durably; nothing delivers now)
        flashMode(r.compacting ? 'compacting — the org way (§8)'
          : r.command ? 'command sent'
            : r.steering ? 'steering in mid-task'
              : r.frozen ? 'frozen — mail waits for ▶ resume'
                : r.deferred ? 'deferred — delivers at rehire'
                  : (r.queued ?? 0) > 0 ? `queued (${r.queued} ahead)` : 'delivering')
        if (r.warnings?.length) toast(r.warnings)
        // A command is not correspondence — it never enters pending_mail — so
        // the question for its ghost is only ever "will a transcript row ever
        // appear?". THREE shapes answer differently, and this used to drop the
        // ghost for all of them on the `command` flag alone (user bug
        // 2026-08-09: "messages sent to an idle chat appear immediately,
        // commands don't appear until the turn starts"):
        //   immediate  — a throwaway session fork; the output rides the live
        //                feed and no row is ever written. Nothing to graduate
        //                against, so the ghost must go or it sits forever.
        //   compacting — /compact runs the org split; likewise never a row.
        //   otherwise  — the command is delivered VERBATIM as its own user
        //                event, so a row IS coming: on an idle node the turn
        //                starts at once, and behind a busy one it waits. KEEP
        //                the ghost; it graduates on the row, exactly like a
        //                message, and until then the dimmed bubble is the
        //                truth (this is queued).
        if (r.immediate || r.compacting) dropPending(slug, node.id, t)
        // …and the third shape, which used to have no exit at all (user bug
        // 2026-09-03). An ordinary command's ghost is still KEPT — a row is
        // coming if the command was real — but the store now knows it is a
        // command, so when the turn ends without writing anything it can say
        // so instead of waiting forever. See convo.ts CMD_GRACE.
        else if (r.command) markGhostCommand(slug, node.id, t)
        return refresh(true)
      })
      .catch((e: Error) => {
        failPending(slug, node.id, ghostId, e.message)
        toast([`error: ${e.message}`])
      })
  }

  // file uploads (user spec 2026-07-31): the file lands in the agent's own
  // uploads/ scratch folder — same relative path sandboxed or not, and it
  // works through the public kiosk gateway from the outside internet
  const fileRef = useRef<HTMLInputElement | null>(null)
  // attachments STAGE onto the next message (user spec 2026-07-31: mail
  // carries files) — the bytes upload immediately, the mail links them
  // Whether the composer textarea currently holds focus. Local to the desk on
  // purpose: it gates one banner and nothing above it should re-render when
  // focus moves. Tracked rather than read from `document.activeElement` so the
  // render stays a pure function of state.
  const [composerFocused, setComposerFocused] = useState(false)
  const [attached, setAttachedRaw] = useState(() => readAttachments(draftKey))
  const setAttached = useCallback((next: { name: string; path: string; bytes: number }[] | ((previous: { name: string; path: string; bytes: number }[]) => { name: string; path: string; bytes: number }[])) => {
    setAttachedRaw((previous) => {
      const value = typeof next === 'function' ? next(previous) : next
      storeAttachments(draftKey, value)
      return value
    })
  }, [draftKey])
  const uploadIdentity = useRef({ draftKey, staleIdentity }); uploadIdentity.current = { draftKey, staleIdentity }
  const attach = (file: File) => {
    if (staleIdentity) return
    uploadFile(slug, node.id, file)
      .then((r) => {
        if (uploadIdentity.current.staleIdentity || uploadIdentity.current.draftKey !== draftKey) return
        setAttached((a) => [...a, { name: file.name, path: r.path, bytes: r.bytes }])
      })
      .catch((e: Error) => toast([`upload error: ${e.message}`]))
  }
  // №13: the composer grows with the draft (2 → ~8 rows); the desk interior
  // is a fixed 900px virtual panel, so .msgs absorbs the difference
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const grow = useCallback(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [])
  // the height follows the TEXT, not the keystroke. onChange was the only
  // caller, so every other way the value changes left the inline height
  // stale: SENDING cleared the draft and the box stayed tall until the desk
  // remounted (user bug 2026-08-02), a draft restored from localStorage
  // opened at two rows however long it was, and picking a slash hint did not
  // resize either. A layout effect measures POST-COMMIT, so the new value is
  // already in the DOM when this reads scrollHeight — reading it inside the
  // handler would measure the outgoing text.
  useLayoutEffect(grow, [text, grow])
  // №6: dropping a file anywhere on the desk uploads it (and prevents the
  // browser's default navigate-away, which would also eat the draft)
  const dropProps = {
    onDragOver: (e: React.DragEvent<HTMLDivElement>) => e.preventDefault(),
    onDrop: (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      if (e.dataTransfer?.files?.length) {
        [...e.dataTransfer.files].forEach(attach)
      }
    },
  }

  const liveKids = node.children.some((c) => c.state === 'live')
  const lastTurn = node.turns?.[node.turns.length - 1]
  const contextOccupancy = chat?.occupancy ?? node.occupancy
  const contextEstimated = chat?.occupancy != null
    ? chat.occupancy_estimated : node.occupancy_est
  // measured fill as a fraction of the window, for the mid-turn banner's
  // gate; null (not 0) when there is nothing trustworthy to gate on, so the
  // gate stays shut rather than reading "empty" as "below the floor"
  const contextRatio = (!contextEstimated
    && typeof contextOccupancy === 'number' && contextOccupancy > 0
    && typeof node.context_window === 'number' && node.context_window > 0)
    ? contextOccupancy / node.context_window : null
  const turnBannerState: TurnBannerState = deriveTurnState({
    ...node,
    busy: Boolean(node.busy || chat?.busy),
  })
  const turnActive = turnBannerState !== 'idle'
  // Waiting for a slot and compacting are desk activity, but neither proves
  // this CLI is claimed. The process cue lights only for an actual busy turn.
  const processActive = Boolean(node.busy || chat?.busy)
  const bannerDuplicatesStatus = Boolean(!isUsageFrozen(node) && node.last_status
    && node.last_status.status === turnBannerState)
  const processAction = node.proc_control_action
  const toggleProcess = useCallback(() => {
    const action = processAction
    if (pub || !live || !action || !node.proc_control_enabled
        || processToggleBusy) return
    setProcessToggleBusy(true)
    processControl(slug, node.id, action)
      .then((r) => {
        toast([r.already
          ? `${node.id} process setting was already ${r.paused ? 'stopped' : 'enabled'}`
          : action === 'stop'
            ? `${node.id} parked CLI process stopped`
            : `${node.id} process pre-warming enabled`])
      })
      .catch((e: Error) => toast([`error: ${e.message}`]))
      .finally(() => setProcessToggleBusy(false))
  }, [live, node.id, node.proc_control_enabled, processAction,
    processToggleBusy, pub, slug, toast])
  // A fresh/empty seat now keeps its truthful hollow wheel, but it must not
  // acquire a dead compact button: the endpoint still requires real context.
  const canCompactContext = live && !node.bearer_state && !node.compacted_unrun
    && typeof contextOccupancy === 'number' && contextOccupancy > 0
    && typeof node.context_window === 'number' && node.context_window > 0
  // The tree copy is patched directly by the node-stream event. Chat is a
  // slower reconciliation payload and must not mask a newer gate transition.
  const mcpReadinessWaiting = Boolean(node.mcp_readiness_waiting)
  const mcpReadinessState = node.mcp_readiness_state
  const mcpReadinessReason = node.mcp_readiness_reason
  // A card is a claim about something assumed to exist. `scope.tools.mcp` is
  // the CONFIGURED grant — a static scope fact, known the instant the node
  // exists, unlike the runtime `mcp_tool_count` snapshot it can lag behind.
  // Empty means no MCP server was ever granted, so there is nothing for the
  // badge to claim; this is not the "not yet known" case (that stays a
  // runtime concern for McpToolCountMark's own '—'/'~N' fallback below).
  const mcpConfigured = (node.scope?.tools.mcp?.length ?? 0) > 0
  // held-audience badges: retired grantor-agents fold behind one chip (user
  // feature 2026-08-17) — USER/EXTERN are pseudo-peers, always "live"
  const held = node.audiences_held ?? []
  const heldRet = held.filter((g) => g !== USER && g !== EXTERN
    && map.get(g)?.state !== 'live')
  const heldChip = (g: string, dim = false) => (
    <span key={g} className={'badge ' + (g === USER ? 'free aud-user' : dim ? 'dim' : '')}>
      <HearingIcon fontSize="inherit" />
      {g === USER ? 'user' : g === EXTERN ? 'org inbox' : g}
      <button className="chip-x"
        onClick={() => audienceAction(slug, 'revoke', node.id, g)
          .then(() => toast([`audience ${node.id}→${g} rescinded`]))
          .catch((e: Error) => toast([`error: ${e.message}`]))}><CloseIcon fontSize="inherit" /></button>
    </span>
  )
  // The desk's own tree, handed to the transcript's mail cards. The lookup
  // reads a ref so a rebuilt-but-identical `map` does not churn the value;
  // the memo keys on `agentFactsSig` because an id or tier change must reach
  // the memo'd rows and a ref write reaches nobody. `onFocus` is OMITTED, not
  // stubbed, when there is no route — a dead control is worse than none.
  // `destination` is the header's own `!bare` test: only the focused desk is
  // somewhere you already are.
  const mapRef = useRef(map); mapRef.current = map
  const jumpRef = useRef(onJump); jumpRef.current = onJump
  const canJump = Boolean(onJump)
  const destination = bare ? null : node.id
  const facts = agentFactsSig(map)
  const agentDir = useMemo<AgentDirectory>(() => ({
    resolve: (id: string) => mapRef.current.get(id),
    onFocus: canJump ? (id: string) => jumpRef.current?.(id) : undefined,
    destination,
  }), [canJump, destination, facts])
  // CANONICAL REFERENCES IN THE CHAT'S PROSE, rendered as things you can click.
  //
  // Built here rather than threaded down: the desk already holds `map` — the
  // map the canvas answers "is there an agent by this id?" with — and all four
  // routes. `onMailLink` takes exactly the shape `mailRefTarget` returns, so
  // the token-to-router translation stays the one in reflinks.tsx.
  //
  // ⚠ EACH ROUTE IS OMITTED WHEN ITS PROP IS, never stubbed. pins.tsx and
  // cards.tsx mount this component with different subsets, and a desk without
  // a route must say "not opened from this panel" rather than draw a chip that
  // eats the click.
  //
  // ⚠ EACH ADAPTS ITS ARITY EXPLICITLY. `onJump` is `centerOn(id, z)`, whose
  // `z ?? fit` default is defeated by any non-null second argument, so a bare
  // handoff type-checks and poisons the camera.
  //
  // ⚠ LATCHED, NOT REBUILT EACH RENDER. `Msg` is memoized and the composer's
  // text lives in this component, so a value that changed identity every
  // render would re-render — and re-`md()` — every transcript row on every
  // keystroke. Same shape as `agentDir`: live values behind refs, the memo
  // keyed on what can change the answers.
  const workRef = useRef(onWorkLink); workRef.current = onWorkLink
  const docRef = useRef(onOpenDoc); docRef.current = onOpenDoc
  const mailLinkRef = useRef(onMailLink); mailLinkRef.current = onMailLink
  const agentIds = [...map.keys()].join('|')
  const agentIndex = useMemo(
    () => new Map([...mapRef.current.keys()].map((id) => [id, id])),
    [agentIds])
  const routeSig = `${!!onWorkLink}|${canJump}|${!!onOpenDoc}|${!!onMailLink}`
  const deskRoutes = useMemo(() => ({
    onOpenItem: workRef.current
      ? (s: string) => workRef.current!({ slug: s }) : undefined,
    onFocusAgent: jumpRef.current
      ? (id: string) => jumpRef.current!(id) : undefined,
    onOpenDoc: docRef.current
      ? (id: string) => docRef.current!(id) : undefined,
    onOpenMail: mailLinkRef.current
      ? (r: TypedRef) => mailLinkRef.current!(mailRefTarget(r)) : undefined,
    // the SAME `destination` the header's own name uses: only the focused
    // desk is somewhere you already are, so a pinned window and a switchboard
    // panel both still navigate
    destination,
    tierOf: (id: string) => mapRef.current.get(id)?.tier,
  }), [routeSig, destination])
  const deskRefs = useRefRoutes(slug, agentIndex, deskRoutes)
  const content = (
    <AgentDirectoryProvider value={agentDir}>
      <div className="cc-head">
        <div className="cc-head-top">
        <span className="cc-head-left">
          {/* ⚠ `bare` IS THE DESTINATION TEST, which is why this reads
              `atDestination={!bare}` and never compares ids. A switchboard
              panel and a pinned window BOTH show this agent's own name, and
              both must still navigate — the click takes you to its focused
              desk, somewhere you are not. Only the focused desk itself
              (`bare === false`) is where the click would be a no-op.
              (user feature 2026-08-17; the tab strip's ⌖ button stays.) */}
          {/* ⚠ `onFocus` GETS THE ID ALONE — see mail.tsx's defaultIdentity for
              what handing the callback over whole costs. No reachable path
              corrupts here today: a pinned window's header names the PINNED
              agent, and centerOn short-circuits to showPin before it ever
              reads the zoom, while the switchboard panel and the mobile sheet
              wrap at their own source. That is precisely why the bare handoff
              would be a quiet trap for the next caller to pass centerOn
              straight in. */}
          <AgentName id={node.id} tier={node.tier} atDestination={!bare}
            why={bare ? undefined
              : (node.charter || '').split('\n')[0] || node.id}
            onFocus={onJump ? (id: string) => onJump(id) : undefined} />
          {node.pending_switch &&
            <span className="queued-mark" title={queuedSwitchTitle(node)}>
              →{TIER_LETTER[node.pending_switch.tier] ?? '?'}</span>}
          <span className="cc-context-seat">
            <ContextWheel occ={contextOccupancy} cw={node.context_window}
              est={contextEstimated} compactAt={compactAt} persistent
              onCompact={canCompactContext ? () => setAskCompact(true) : undefined} />
          </span>
          <span className="cc-process-seat">
            <ProcessLifecycleMark warm={Boolean(node.proc_warm)}
              live={live ? node.proc_live : false} relaunch={node.proc_relaunch}
              reason={node.proc_relaunch_reason} busy={processActive} tier={node.tier}
              paused={Boolean(node.proc_paused)}
              controlEnabled={Boolean(node.proc_control_enabled)
                && !processToggleBusy}
              controlAction={processAction}
              controlReason={processToggleBusy
                ? 'process control is in progress'
                : node.proc_control_reason}
              onToggle={!pub && live && processAction ? toggleProcess : undefined} />
          </span>
          <TurnStatusBanner state={turnBannerState} turn={lastTurn}
            frozen={isUsageFrozen(node) ? node.frozen : null}
            inflightAt={node.inflight_at} tasks={node.tasks}
            recordedState={node.last_status?.status}
            reportedSummary={bannerDuplicatesStatus ? node.last_status?.summary : undefined}
            tier={node.tier} />
        </span>
        <span className="spacer" aria-hidden="true" />
        <span className="cc-head-right">
          <span className="cc-actions">
            {live && !liveKids &&
              <button className="danger" onClick={() => setAsking('retire')}>
                retire · {fmtCredits(node.seat! + node.grant!)}</button>}
            {live && liveKids &&
              <button className="danger" onClick={() => setAsking('dissolve')}>
                dissolve · {fmtCredits(node.seat! + node.grant!)}</button>}
            {!live && <button onClick={() => op({ op: 'rehire', node: node.id })}>rehire</button>}
          </span>
          <span className="cc-tabs">
            {(['chat', 'inbox', 'docket', 'presented', 'history', 'files'] as const).map((v) => (
              <button key={v} data-tab={v} className={view === v ? 'on' : ''}
                onClick={() => setView(v)}>
                {v}{tabCount(v) > 0
                  ? <>{' '}<span className={'tab-count prov-'
                      + providerOf(node.tier ?? '')}>
                      {tabCount(v)}</span></>
                  : ''}
              </button>
            ))}
          </span>
          {/* FR-3: pin this desk to screenspace as a draggable window */}
          <PopoutButton />
          {onPin && !surface?.detached &&
            <button className="cc-icon cc-pin" aria-label={`pin ${node.id}'s desk as a window`}
              title="pin as a window — it stays put while the canvas moves"
              onClick={onPin}>
              <PushPinIcon fontSize="inherit" />
            </button>}
          <button className="cc-icon" aria-label={`settings for ${node.id}`}
            title={`settings for ${node.id}`} onClick={onConfig}>
            <SettingsIcon fontSize="inherit" />
          </button>
        </span>
        </div>
        <div className="cc-head-meta">
        {mcpConfigured && <McpToolCountMark count={node.mcp_tool_count}
          last={node.last_turn_mcp_tool_count}
          provider={node.mcp_tool_count_provider}
          source={node.mcp_tool_count_source}
          reason={node.mcp_tool_count_reason}
          readinessState={mcpReadinessState}
          readinessReason={mcpReadinessReason} />}
        <CacheForecastMark forecast={node.cache_forecast} busy={processActive} />
        {node.last_status && !bannerDuplicatesStatus &&
          <span className={'statuschip ' + node.last_status.status}
            title={node.last_status.summary}>{isUsageFrozen(node) ? 'Reported ' : ''}{stateLabel(node.last_status.status)}</span>}
        {node.frozen &&
          <span className="badge frozen" title={node.frozen.error ?? undefined}>
            <FrozenIcon fontSize="inherit" />{' '}
            {/* a limit_locked node's freeze clock can never fire (the
                resume path skips locked nodes) — say HALTED, never a
                reset time that is a lie (redteam 2026-08-06) */}
            {FREEZE_LABEL[freezeKind(node.frozen, node.limit_locked) ?? 'limit']}
            {/* ⚠ "resumes X" is a LIMIT's phrasing — there X is a reset time
                and something does resume at it. A connection freeze's label
                is a statement of fact ("network interruption — attempt 1/4"),
                because whether anything retries depends on the org's
                auto-resume toggle, which the org banner knows and a node
                badge does not. Saying "resumes" here promised a retry that,
                with the toggle off, nobody performs (2026-08-10). */}
            {!node.limit_locked && node.frozen.until
              ? ` · ${localizeFreezeUntil(node.frozen.connection
                ? node.frozen.until.replace(/^network interruption — /, '')
                // an auth freeze's `until` says what to DO ("credential
                // rejected — replace it, then resume"); the label above
                // already carries the first half, so strip it exactly as the
                // connection branch does rather than say it twice
                : node.frozen.cause === 'auth'
                ? node.frozen.until.replace(/^credential rejected — /, '')
                // a balance freeze's `until` likewise opens with the label's
                // own words ("balance refused — …"); strip them the same way
                : node.frozen.cause === 'balance'
                ? node.frozen.until.replace(/^balance refused /, '')
                // ⚠ NO VERB. The backend re-derives this string from the live
                // account roster and it already says what it means ("capacity
                // resets 3:10pm" / "capacity available — ▶ to resume" /
                // "reset time unknown"). It used to read `resumes ${until}`,
                // which promised a wake that never comes on an org with
                // auto_resume off — the default. Reporting capacity is the
                // whole point; do not put "resumes" back.
                : node.frozen.until, node.frozen.until_ts)}` : ''}</span>}
        {node.limit_locked &&
          <span className="badge dim"><LockIcon fontSize="inherit" /> limit</span>}
        {/* ⭐ the user's per-node override (ruling 2026-08-06): one click
            releases EVERY lock holding this agent and re-drives it —
            pub (visitor) views never get it */}
        {!pub && (node.frozen || node.limit_locked) &&
          <button className="badge unstick"
            title="release every lock holding this agent (user override) and resume it"
            onClick={() => unstickNode(slug, node.id)
              .then((r) => toast([r.released?.length
                ? `${node.id} unstuck (${r.released.join(', ')})`
                : (r.status ?? 'nothing to release'),
                ...(r.warnings ?? [])]))
              .catch((e: Error) => toast([`error: ${e.message}`]))}>
            unstick</button>}
        {/* the switchboard panels mirror this header IDENTICALLY (user spec
            2026-08-19) — nothing below is compact-gated anymore; a panel and
            the agent's own desk show the same chips, actions, tabs and gear */}
        {(node.generation ?? 0) > 0 &&
          <button className="badge stackbadge"
            onClick={onLineage}>gen {node.generation} <LayersIcon fontSize="inherit" /></button>}
        {node.bearer_state &&
          <span className={'badge ' + (node.bearer_state === 'preserving' ? 'dim' : '')}>
            {node.bearer_state}</span>}
        {held.filter((g) => !heldRet.includes(g))
          .map((g) => heldChip(g))}
        <RetiredFold ids={heldRet}
          render={(g) => heldChip(g, true)} />
        <SpendBadge node={node} />
        {(chat?.queued ?? 0) > 0 && <span className="badge">{chat!.queued} queued</span>}
        {/* WHICH POOL A LUNA IS ON (item 12; user spec 2026-09-04: a token on
            the header's second row when Luna runs on reserve). Same slot and
            same contract as the "ran as" badge beside it: it describes what
            the turn was SENT as, not what routing prefers — the backend
            composes `label` from the route receipt, and prefixes "last:"
            when it describes the previous turn rather than a live one, so
            a stale state is never worn as a current one. */}
        <RouteBadge route={node.codex_route} />
        </div>
      </div>
      {/* F-01: superior chip at the TOP. For a top-level agent the superior is
          the user, so the chip targets the switchboard (map carries the eye
          root under USER) — unless this desk IS a switchboard panel (bare),
          where a jump-to-switchboard chip points at where you already are
          (user report 2026-08-04). Bearer pseudo-cards float beside a
          successor and have no meaningful parent chip. */}
      {onJump && !node.isBearerOf && node.parent && map.has(node.parent)
        && !(bare && node.parent === USER) && (
        <div className="desk-nav">
          <NavChip n={map.get(node.parent)!} dir="up" onJump={onJump} />
        </div>
      )}
      {/* FR-03: presented documents on their OWN strip under the header.
          They used to sit inline in .cc-head, where long titles starved the
          name of width (it ellipsized to nothing) and shoved the action/tab
          chrome off the edge (user report 2026-08-19). Zoomed-in visibility —
          the original FR-03 point — only needs them ON the desk, not in the
          identity row. Still shown in compact/switchboard panels: D-100
          restricts presenting to direct-user-audience agents, which is
          exactly who the switchboard shows. */}
      {onOpenDoc && (node.documents?.length ?? 0) > 0 && (
        <div className="desk-docs">
          {node.documents!.slice(-4).map((d) => (
            <PresentationCard key={d.id} slug={slug} doc={d} toast={toast}
              className="doc-badge" onOpen={onOpenDoc}>
              <DocIcon fontSize="inherit" /><span>{d.title}</span>
            </PresentationCard>
          ))}
        </div>
      )}
      {asking === 'dissolve' && (
        <ConfirmModal title={`dissolve ${node.id}?`}
          body="Its entire suborganization is retired with it. Context is kept; rehire brings nodes back."
          confirmLabel="dissolve"
          onConfirm={() => op({ op: 'dissolve', node: node.id })}
          close={() => setAsking(null)} />
      )}
      {asking === 'retire' && (
        <ConfirmModal title={`retire ${node.id}?`}
          body={`It stops working and frees ${fmtCredits((node.seat ?? 0) + (node.grant ?? 0))} credit(s) back to its superior. Its context is KEPT — rehire brings it back exactly as it was.`
            + (node.busy || chat?.busy
              ? ' ⚠ It is mid-turn right now; that turn is cut off.' : '')}
          confirmLabel="retire"
          // the undo toast stays: the confirm stops the mis-click, the toast
          // catches the changed mind a moment later
          onConfirm={() => op({ op: 'retire', node: node.id }).then(() =>
            toast([`${node.id} retired`],
              () => op({ op: 'rehire', node: node.id }).catch(() => {})))
            .catch(() => {})}
          close={() => setAsking(null)} />
      )}
      {askCompact && (() => {
        // FR-24: only backend evidence may call the next turn known-cold.
        // Generic UI idle / last-turn age is neither an authoritative cache
        // receipt nor a provider-lane TTL and must never manufacture expiry.
        const forecast = node.cache_forecast
        const cold = forecast?.state === 'known_incompatible'
          || forecast?.state === 'expired_known_entry'
        const coldLabel = forecast?.state === 'known_incompatible'
          ? 'incompatible with the last observed cache entry'
          : 'past the derived cache TTL'
        return <ConfirmModal title={`compact ${node.id} now?`}
          body={'Same as the automatic split: the session forks and compacts — '
            + 'the successor carries on under this name; the pre-compaction '
            + 'self is archived in place as a consultable knowledge bearer.'
            + (cold ? ` ⚠ The next-turn cache forecast is ${coldLabel}`
              + (forecast?.reason ? `: ${forecast.reason}` : '')
              + '. This fork re-reads the whole transcript at near-full price. CHEAP '
              + 'COMPACT instead retires the agent and hires a fresh '
              + 'replacement (same tier/grant/charter) that reads the old '
              + 'transcript selectively, read-only, only as needed.'
              : ' Cheap compact is the fresh-replacement alternative: zero '
              + 'starting context, the old transcript granted read-only.')}
          confirmLabel="compact"
          onConfirm={() => compactNode(slug, node.id)
            .then(() => toast([`compaction of ${node.id} started`]))
            .catch((e: Error) => toast([`error: ${e.message}`]))}
          altLabel="cheap compact"
          onAlt={() => op({ op: 'cheap_compact', node: node.id })
            .then(() => {
              // the session just changed under this desk — ask for the chat
              // NOW rather than letting the old transcript sit until the
              // next heartbeat (user report 2026-08-12; the 89fecd9 class:
              // the client must refetch the thing it is actually rendering)
              void refresh(true)
              toast([`${node.id} cheap-compacted — fresh session; its old `
                + 'self is consultable in its lineage'])
            })
            .catch((e: Error) => toast([`error: ${e.message}`]))}
          close={() => setAskCompact(false)} />
      })()}
      {/* last_error moved INTO the chat stream (it renders at the end, where
          it actually occurred). On the non-chat tabs it would otherwise be the
          only surface showing a failed turn, so it still renders here for
          those — never on the chat tab, which owns it chronologically. */}
      {chat?.last_error && view !== 'chat' && (
        <div className="desk-error"><WarnIcon fontSize="inherit" /> {chat.last_error}</div>)}
      {view === 'chat' && (
        <div className="msgs-wrap">
          {/* The pin is an overlay, not a transcript row. Keeping it outside
              `.msgs` makes mounting it unable to move the row whose geometry
              decides whether it mounts — no height/gap arithmetic and no
              render/layout feedback loop at the boundary. */}
          {pinTarget && (
            <button className={'pinuser' + (pinClip ? ' clipped' : '')}
              ref={pinRef}
              title="jump to your message"
              onClick={(e) => {
                const el = scroller.current
                const tr = pinSeq == null ? null : userRowEls.current.get(pinSeq)
                if (!el || !tr) return
                const pad = e.currentTarget.offsetHeight + 12
                const target = () => el.scrollTop + tr.getBoundingClientRect().top
                  - el.getBoundingClientRect().top - pad
                el.scrollTo({ top: target(), behavior: 'smooth' })
                let last = -1, still = 0, hops = 0
                const settle = () => {
                  if (!el.isConnected || !tr.isConnected || ++hops > 300) return
                  if (el.scrollTop === last) {
                    if (++still >= 3) {
                      const d = target()
                      if (Math.abs(d - el.scrollTop) > 4) el.scrollTop = d
                      return
                    }
                  } else { last = el.scrollTop; still = 0 }
                  requestAnimationFrame(settle)
                }
                requestAnimationFrame(settle)
              }}>
              <span className="pinuser-t" ref={pinTextRef}>
                ↑ you: {pinTarget.label || 'your message'}
              </span>
            </button>)}
        <div className="msgs" ref={attachScroller}
          onScroll={(e) => {
            setStuck(nearBottom())
            calcPin()
            // within a screen of the top: page in the previous window
            if (e.currentTarget.scrollTop < 240 && hasOlder) loadOlder()
          }}>
          {/* paging is automatic (the onScroll above pages in within a screen
              of the top) — this is a status line, not a control. It still
              earns its place: it reserves height so the list does not jump as
              rows prepend, and at the API's window cap it is the ONLY thing
              that explains why scrolling up stopped producing messages. */}
          {hasOlder && (
            <div className={'dim pad loadolder-status' + (loadingOlder ? ' on' : '')}>
              {loadingOlder ? 'loading earlier messages…'
                : convo.win >= MAX_WINDOW
                  ? `${chat?.messages[0]?.seq ?? 0} earlier messages — beyond the window`
                  : `${chat?.messages[0]?.seq ?? 0} earlier messages`}
            </div>)}
          {!hasOlder && convo.win > CHAT_WINDOW && chat?.messages.length
            ? <div className="dim pad loadolder-end">— start of the conversation —</div> : null}
          {!chat && <div className="dim pad">loading…</div>}
          {chat && !chat.messages.length && !live_feed.length &&
            <div className="dim pad">no conversation yet</div>}
          {/* a FRESH session under a seat that has history (cheap compact,
              cross-provider switch): say where the earlier conversation
              went. A bare "no conversation yet" over an agent with hours of
              history reads as a broken desk (user report 2026-09-03 — and
              it WAS broken, for a reason fixed in the ledger; the honest
              empty state names the bearer either way). Same lineage the
              panel below reads; newest consultable generation first. */}
          {chat && !chat.messages.length && !live_feed.length && (() => {
            const prior = [...(node.lineage ?? [])]
              .filter((b) => b.state === 'archived' && b.bearer_state !== 'lost')
              .sort((a, b) => (b.generation ?? 0) - (a.generation ?? 0))[0]
            return prior ? (
              <div className="dim pad">
                this session is fresh — the earlier conversation is archived as{' '}
                <b className="mono">{prior.id}</b> (read it from the lineage panel)
              </div>) : null
          })()}
          {chat?.messages.map((m, i) => {
            // №15: one dim divider per idle gap — never per-message timestamps
            const prev = chat.messages[i - 1]
            const gapMs = prev?.ts && m.ts
              ? Date.parse(m.ts) - Date.parse(prev.ts) : 0
            return (
              // seq = the server's pre-slice ordinal: index keys over the
              // sliding CHAT_WINDOW-row window remounted every row (and collapsed
              // every open ToolChip) each time one message scrolled off
              <div key={m.event_id ?? m.seq ?? i}
                data-reply-event={m.event_id} data-reply-quote={m.reply_quote ?? (m.text || m.cmd_out || '')} onContextMenu={e => openReply(e, m)}
                // FR-20: scroll-to anchors — every user turn is a potential
                // chip target now that scrolling past one retargets to the
                // next up the chain, so each keeps its row in the seq→el map
                // (deleted on unmount: the window slides rows out mid-list)
                ref={m.seq != null && userSeqs.has(m.seq)
                  ? (el) => {
                    const seq = m.seq!
                    if (el) userRowEls.current.set(seq, el)
                    else userRowEls.current.delete(seq)
                  } : undefined}>
                {gapMs > 5 * 60e3 && (
                  <div className="msg sys" data-reply-event="">— {gapMs > 5400e3
                    ? `${Math.round(gapMs / 3600e3)} h`
                    : `${Math.round(gapMs / 60e3)} min`} later —</div>)}
                {renderReply(m.reply_to)}
                <Msg m={m} slug={slug} nid={node.id} onMailLink={onMailLink}
                  onWorkLink={onWorkLink} refs={deskRefs}
                  replyAvailable={replyAvailable} onLocateReply={locateReply} />
              </div>
            )
          })}
          {/* ⭐ THE QUESTION, ABOVE ITS OWN ANSWER (user report 2026-09-01:
              "the message appears to still be mid-transit, but the streamed
              response begins appearing before it enters the transcript").
              A `delivering · via:turn` entry is not queued mail — it is the
              message the RUNNING turn was started to answer, drained out of
              the mailbox and not yet echoed into the transcript (D-54 keeps
              the handover inside one payload). Everything below this line
              belongs to that turn, so the bubble belongs above it; drawn at
              the bottom, it put the answer above the question for as long as
              the provider took to write the user row — measured on the live
              codex coordinator at 0.6 s warm, and the whole of a cold
              app-server's start otherwise.
              The remaining pending mail is genuinely still waiting and stays
              at the bottom, after the live tail, where it is true. */}
          {pendNow.map(pendBubble)}
          {/* keyed on the server's row id (`n`), never the index: rows retire
              from the MIDDLE of this list as the transcript catches up, and an
              index key would rename every row below the one that left */}
          {live_feed.map((f, i) => (
            <div key={f.event_id ?? f.n ?? 'f' + i} className="reply-event" data-reply-event={f.event_id} data-reply-quote={f.text} onContextMenu={e => openReply(e, f)}>
            {f.kind === 'thought'
              ? <div key={f.n ?? 'f' + i} className="msg assistant live">
                  <ThoughtLine text={f.text} secs={f.secs} /></div>
              : f.kind === 'tool'
                ? <div key={f.n ?? 'f' + i} className="msg live tools"><DotIcon fontSize="inherit" className="tooldot" /> {f.text}</div>
                : f.kind === 'steered'
                  ? <LiveSteerRow segments={f.segments} key={f.n ?? 'f' + i} text={f.text}
                      truncated={f.truncated} slug={slug} nid={node.id}
                      refs={deskRefs} />
                  : <div key={f.n ?? 'f' + i} className="msg assistant live">
                      {/* render-inline-html-custom-responses: a POSITIVE
                          allowlist, not "everything not excluded" — this
                          default branch is reached by any `f.kind` the three
                          cases above don't name, and coordinator-astra's
                          ruling (after redteam-opus found slash-command
                          stdout reachable here, sharing `kind: "text"` with
                          a genuine agent reply) is that a FUTURE unnamed
                          kind must fail closed, not open. `kind === 'text'`
                          is the only value the backend ever uses for actual
                          agent prose in this branch (Codex message/plan
                          text, Claude message content); `cmd_output` is the
                          two `local_command` live_row calls' own marker for
                          the one non-prose case that also uses it. Anything
                          else reaching this branch — a kind added next
                          month, say — renders exactly as today, just never
                          executable. */}
                      <RefMdBody className="md" world={deskRefs.world}
                        onOpen={deskRefs.onOpen}
                        html={md(f.text, fileBase(slug, node.id),
                          f.kind === 'text' && !f.cmd_output)} />
                      {/* the live copy is capped at 2000 chars server-side —
                          declare the cut; the transcript row that replaces
                          this one carries the whole text */}
                      {f.truncated && <div className="trunc-note">
                        ✂ shown truncated — the full text follows shortly</div>}
                    </div>
            }</div>
          ))}
          {transient.map(row => <div key={row.event_id} data-reply-event={row.event_id} data-reply-quote={row.reply_quote}
            onContextMenu={e => openReply(e, row)} className={['thinking', 'thinking_start', 'thought'].includes(row.kind)
              ? 'reply-event' : 'msg live ' + (row.kind === 'error' ? 'desk-error' : row.role === 'user' ? 'user' : 'assistant')}>
            {['thinking', 'thinking_start', 'thought'].includes(row.kind)
              ? (row.event_id === convo.thinkingEventId && thinking || row.text
                ? <div className="msg live thinking">{row.event_id === convo.thinkingEventId && thinking ? thinking : row.text}</div>
                : <div className="msg live thinking sealed"><PsychologyIcon fontSize="inherit" />{' '}thinking…
                    {thinkSecs !== null && thinkSecs > 0 ? ` for ${thinkSecs}s` : ''}</div>)
              // render-inline-html-custom-responses: these transient rows are
              // always 'system' (starting/error) or 'assistant' (draft/delta)
              // — capture_reply_stream never produces 'user' here — but the
              // grant still names the agent-response case explicitly rather
              // than defaulting open on "not user".
              : <RefMdBody className="md" world={deskRefs.world} onOpen={deskRefs.onOpen}
                  html={md(row.event_id === convo.draftEventId && draft ? draft : row.text,
                    fileBase(slug, node.id), row.role === 'assistant')} />}
          </div>)}
          {!transientThinking && thinkSecs !== null && chat?.busy && <div className="reply-event"
            data-reply-event={convo.thinkingEventId ?? ''} data-reply-quote={convo.thinkingReplyQuote} onContextMenu={e => openReply(e, { event_id: convo.thinkingEventId })}>{(thinking
            // haiku streams its reasoning: the text IS the indicator
            ? <div className="msg live thinking">{thinking}</div>
            // opus/sonnet seal it: nothing to show but the fact and the clock,
            // which beats the blank panel this replaces
            : <div className="msg live thinking sealed">
                <PsychologyIcon fontSize="inherit" />{' '}thinking…
                {thinkSecs > 0 ? ` for ${thinkSecs}s` : ''}
              </div>)}</div>}
          {!transientDraft && draft && <div className="reply-event" data-reply-event={convo.draftEventId ?? ''} data-reply-quote={convo.draftReplyQuote}
            onContextMenu={e => openReply(e, { event_id: convo.draftEventId })}><RefMdBody className="msg assistant live md draft"
            world={deskRefs.world} onOpen={deskRefs.onOpen}
            html={md(draft, fileBase(slug, node.id), true)} /></div>}
          {/* D-29: the turn has begun but the CLI has not produced anything
              yet — process launch, hooks, `init`, roughly six seconds during
              which the panel showed nothing but a spinner in the chrome. This
              is derived from busy plus the server's per-turn activity latch.
              The latch matters after the first event: the live row is swept
              when its transcript twin lands, and that ordinary caught-up gap
              is NOT the CLI starting again. */}
          {!transient.some(r => r.kind === 'starting') && chat?.busy && !chat.turn_activity && !live_feed.length
            && thinkSecs === null && !draft
            && !pending.length && (
            <div className="reply-event" data-reply-event="" onContextMenu={e => openReply(e, {})}><TurnStartingMark mcpWaiting={mcpReadinessWaiting}
              reason={mcpReadinessReason} /></div>)}
          {/* №11: pending bubbles render from the DURABLE server copy, each
              retractable until delivery (№17).
              ⚠ Only the ones that are still WAITING render here, at the
              bottom. The one being delivered INTO the running turn was hoisted
              above the live tail — see pendNow. */}
          {pendLater.map(pendBubble)}
          {/* №17 for GHOSTS (user bug 2026-09-03: "i sent an invalid command
              and it got stuck as a permanently undelivered message that i
              cant cancel"). The durable pending bubbles above have carried a
              retract ✕ since №17; these — the optimistic ones — carried
              nothing, so the one bubble the user could not get rid of was the
              one with no server record behind it.
              ⚠ The ✕ is DISMISS, not retract: there is nothing on the server
              to take back (a ghost has no id because nothing was filed), so
              it says so rather than implying a retraction it cannot perform.
              A failed one also offers ↩ to put the text back in the composer,
              and only when the composer is empty — the user's typing is not
              ours to overwrite. */}
          {pending.map((p) => (
            <PendingGhostRow key={'q' + p.id} p={p} slug={slug} nid={node.id}
              world={deskRefs.world} onOpen={deskRefs.onOpen}
              replyAvailable={replyAvailable} onLocateReply={locateReply}
              onContext={e => openReply(e, {})}
              onRestore={p.failed && !text.trim()
                ? () => { setText(p.text); setReply(p.reply ?? null); setAttached(p.attachments ?? []); dismissPending(slug, node.id, p.id) }
                : undefined}
              onDismiss={() => dismissPending(slug, node.id, p.id)} />
          ))}
          {/* the turn's own failure is the LAST thing that happened, so it
              reads at the end of the stream. It used to render above the whole
              transcript, which put the newest event first (user bug
              2026-08-02: events must appear in the order they occurred). */}
          {chat?.last_error && !transient.some(r => r.kind === 'error') && (
            <div className="desk-error" data-reply-event="" onContextMenu={e => openReply(e, {})}><WarnIcon fontSize="inherit" /> {chat.last_error}</div>)}
          {/* №7's denials banner is GONE (user bug 2026-08-02). A headless
              auto-deny already writes a tool_result with is_error, so the
              denial renders inline as an errored ToolChip at the point it
              happened — verified in a live transcript ("Claude requested
              permissions to write to …, but you haven't granted it yet").
              The banner restated that, pinned below even undelivered pending
              mail, so a past event sorted under a future one. */}
          {/* sticky INSIDE the scroller (not a wrapper): the desk's flex chain
              is documented as fragile, and sticky needs no new layout box. It
              is the last child, so it rides the bottom edge of the scrollport
              while the reader is up in the scrollback. */}
          {showJump && (
            <button className="jumpbottom" onClick={toBottom}
              title="jump to the newest message">
              ↓ jump to bottom
            </button>)}
        </div></div>
      )}
      {view === 'history' && <HistoryView slug={slug} nid={node.id} refs={deskRefs} />}
      {view === 'files' && <FilesView slug={slug} nid={node.id} />}
      {/* ⚠ THE SAME `deskRefs` THE CHAT AND THE INBOX USE. This tab was
          building its own narrower world, which left a `@doc:` or `@mail:`
          token live in the message above and inert in the docket below — one
          desk, two answers. It is handed the world whole and overrides only
          what an ITEM click does, because it holds the rows itself. */}
      {view === 'docket' && <AgentDocketView slug={slug} nid={node.id}
        mine={myWork} facts={workFacts} toast={toast} onFocusAgent={onJump}
        showArchived={showArchivedDocket}
        onShowArchived={setShowArchivedDocket}
        refs={deskRefs}
        onChanged={() => setWorkBump((n) => n + 1)} />}
      {view === 'presented' && (
        <AgentGalleryView slug={slug} nid={node.id} node={node} toast={toast}
          onFocusAgent={onJump} refs={deskRefs}
          onChanged={() => refresh(true)} />
      )}
      {/* the mailbox is a name surface too (user request 2026-09-05: the inbox
          was named explicitly). `onJump` is the SAME callback NavChip and the
          header already use here, so no new route is invented — and it is
          passed through undefined when this desk has none, which makes the row
          omit the control rather than draw a dead one. `hasAgent` still decides
          WHICH names route; `tierOf` is a separate fact, so a real agent whose
          model is unknown navigates without a chip. */}
      {view === 'inbox' && <InboxView slug={slug} nid={node.id} tier={node.tier}
        toast={toast}
        tierOf={(id) => map.get(id)?.tier}
        hasAgent={(id) => map.has(id)}
        refs={deskRefs}
        onFocusAgent={onJump}
        onRetract={(m) => retractMail(slug, node.id, m.id)
          .then(() => refresh(true))
          // rethrow: InboxView's optimistic hide rolls back on rejection
          .catch((e: Error) => { toast([`error: ${e.message}`]); throw e })} />}
      {/* F-04/F-05: the ask card — pinned above the composer while the ask is
          open ("a question answering ui should appear on the agent"), AND —
          message-visibility invariant, user 2026-09-10, superseding the
          2026-08-04 "answered leaves the pin immediately" — while its
          submitted answer has not yet RENDERED in the transcript: the
          resolved panel is the answer's one representation for exactly that
          window (the separate pending bubble is suppressed above), and it
          unpins in the same render that shows the transcript row. Once handed
          off it leaves the pin as before — the answer IS in the scroll now —
          and nulled/interrupted states stay visible on the inbox rows. */}
      {ask && (askLive || (!!answerMail && !answerHandedOff)) && (
        <AskCard ask={ask} slug={slug} toast={toast}
          seat={node.seat ?? 0}
          committed={(node.grant ?? 0) - (node.free ?? 0)}
          segments={node.children.filter((c) => c.state === 'live' && !c.isBearerOf)
            .map((c) => ({ seat: c.seat ?? 0, grant: c.grant ?? 0 }))}
          pxc={pxc}
          maxTop={maxTop} />
      )}
      {/* F-01: subordinate chips at the BOTTOM — one per direct report. Drafts
          are not agents yet; bearer pseudo-cards are consultable stack layers,
          not reports. Retired reports collapse behind one expandable chip
          (user ruling 2026-08-04) — a long-lived team's footer is otherwise
          mostly graves. */}
      {(() => {
        if (!onJump) return null
        const reports = node.children.filter((c) => c.state !== 'draft' && !c.isBearerOf)
        const alive = reports.filter((c) => c.state === 'live')
        const retired = reports.filter((c) => c.state !== 'live')
        if (!reports.length) return null
        return (
          <div className="desk-nav">
            {alive.map((c) => <NavChip key={c.id} n={c} dir="down" onJump={onJump} />)}
            {retired.length > 0 && (
              <button className="desk-nav-chip dim"
                title={showRetired ? 'collapse the retired reports'
                  : retired.map((c) => c.id).join(', ')}
                onClick={() => setShowRetired((v) => !v)}>
                {showRetired ? 'hide retired'
                  : `show ${retired.length} retired`}
              </button>
            )}
            {showRetired && retired.map((c) =>
                <NavChip key={c.id} n={c} dir="down" onJump={onJump} />)}
          </div>
        )
      })()}
      {/* №13: the composer is present under EVERY tab — finding a wrong number
          on the files tab shouldn't cost your place to say so */}
      {replyMenu.node}
      {reply && <ReplyPreview reply={reply} available={replyAvailable(reply)}
        onLocate={() => locateReply(reply)} onRemove={() => setReply(null)} />}
      {sendMode && <div className="sendmode dim">{sendMode}</div>}
      {legacyDraft && !staleIdentity && <div className="popout-error">
        An older saved draft is available. Its generation was not recorded.
        <button onClick={() => {
          setText((previous) => previous ? previous + '\n' + legacyDraft : legacyDraft)
          try { localStorage.removeItem(`orgtree-draft-${slug}-${node.id}`) } catch { /* unavailable */ }
          setLegacyDraft('')
        }}>Restore draft</button>
      </div>}
      {!staleIdentity && recoveryDrafts.length > 0 && <details className="popout-draft-recovery">
        <summary>Older unsent drafts ({recoveryDrafts.length})</summary>
        <button type="button" onClick={() => {
          discardAllRecoverableDrafts(slug, node.id, recoveryDrafts.map(d => d.generation), node.generation)
          setRecoveryRevision((v) => v + 1)
        }}>Dismiss all</button>
        {recoveryDrafts.map(d => <div key={d.key}>
          <p>Generation {d.generation} draft <button type="button" onClick={() => {
            discardRecoverableDraft(slug, node.id, d.generation, node.generation)
            setRecoveryRevision((v) => v + 1)
          }}>Discard</button></p><pre>{d.text}</pre>
          {d.reply && <ReplyPreview reply={d.reply} available={replyAvailable(d.reply)} onLocate={() => locateReply(d.reply!)} />}
          {d.attachments.map(a => <p key={a.path}>{a.name} ({a.bytes} bytes) {a.path}</p>)}
        </div>)}
      </details>}
      {/* staged attachments ride the NEXT message as mail attachments */}
      {attached.length > 0 && (
        <div className="attach-row">
          {/* the bytes are already up in uploads/ (attach() uploads first),
              so a staged image can show itself rather than a filename */}
          {attached.map((a, i) => (isImg(a.name)
            ? <AttachThumb key={a.path + i} href={fileUrl(slug, node.id, a.path)}
                name={a.name} meta={fmtBytes(a.bytes)}
                onRemove={() => setAttached((x) => x.filter((_, j) => j !== i))} />
            : <span key={a.path + i} className="attach-chip">
                <FileIcon fontSize="inherit" /> {a.name}
                <span className="dim"> {fmtBytes(a.bytes)}</span>
                <button className="chip-x" title="remove from this message"
                  onClick={() => setAttached((x) => x.filter((_, j) => j !== i))}>
                  <CloseIcon fontSize="inherit" /></button>
              </span>
          ))}
        </div>
      )}
      {text.trimStart().startsWith('/') && canMail && (
        <SlashHints text={text} setText={setText} />)}
      {/* `processActive`, not `turnActive`: the mid-turn banner is about a
          STEER WINDOW, which only exists while a turn is genuinely running.
          A queued or compacting agent has no window to miss. */}
      <CacheForecastWarning forecast={node.cache_forecast}
        midTurn={processActive} composerFocused={composerFocused}
        cheapCompactOn={node.cheap_compact_on}
        cheapCompactOcc={node.cheap_compact_occ} contextRatio={contextRatio} />
      <div className={'cc-composer' + (canMail ? '' : ' off')}>
        <button className="cc-attach" disabled={!canMail}
          title="attach a file — it lands in the agent's uploads/ folder"
          onClick={() => fileRef.current?.click()}>
          <FileIcon fontSize="inherit" /></button>
        <input type="file" ref={fileRef} style={{ display: 'none' }} multiple
          onChange={(e) => {
            [...e.target.files!].forEach(attach)
            e.target.value = ''
          }} />
        <textarea rows={2} value={text} disabled={!canMail}
          ref={(el) => {
            taRef.current = el
            // autofocus single-desk only, and never let focus scroll the
            // transform-panned viewport (same hazard as the draft input)
            if (el && !bare && !compact && !el.dataset.f) {
              el.dataset.f = '1'
              el.focus({ preventScroll: true })
            }
          }}
          placeholder={live ? `message ${node.id}…`
            : node.state === 'archived'
              ? `message ${node.id} — queued until rehire…` : node.state}
          onChange={(e) => { flashMode(''); setText(e.target.value); grow() }}
          onFocus={() => setComposerFocused(true)}
          onBlur={() => setComposerFocused(false)}
          onPaste={(e) => {
            // №6: Ctrl+V of an image/file auto-bridges to a real upload
            if (e.clipboardData?.files?.length) {
              e.preventDefault()
              ;[...e.clipboardData.files].forEach(attach)
            }
          }}
          onKeyDown={(e) => {
            // mobile: soft keyboards emit Enter with shiftKey:false and no
            // gesture recovers the newline — send is the button's job there
            if (e.key === 'Enter' && !e.shiftKey && !isMobile) { e.preventDefault(); send() }
          }} />
        {!pub && (
          <EffortButton value={node.scope?.effort ?? ''}
            effective={node.effort_effective ?? ''}
            onSet={(lvl) => saveScope(slug, node.id, { effort: lvl })
              .then(() => toast([lvl
                ? `${node.id} thinking effort: ${lvl}`
                : `${node.id} thinking effort: back to the org default`]))
              .catch((e: Error) => toast([`error: ${e.message}`]))} />
        )}
        {/* №3: STOP renders only when an interrupt can actually land —
            pressing the one red control must never error. Gate on the CHAT
            payload's responding (refreshed every pulse + 5 s poll): the tree
            copy goes stale during a turn and the STOP never appeared while a
            long command ran (user bug 2026-07-31). Enter still queues. */}
        {(chat?.responding ?? node.responding)
          ? <button className="cc-send stop" title="interrupt the current response — Enter still queues your message"
              onClick={() => interruptNode(slug, node.id)
                .then((r) => { if (!r.interrupted) toast([`error: ${r.reason}`]) })
                .catch((e: Error) => toast([`error: ${e.message}`]))}><StopIcon fontSize="inherit" /></button>
          : <button className="cc-send" disabled={!canMail || !text.trim()}
              onClick={send}><ArrowUpIcon fontSize="inherit" /></button>}
      </div>
    </AgentDirectoryProvider>
  )
  // bare: the switchboard hosts many chats inside ONE counter-scaled surface —
  // no overlay wrapper, no second scale (that would double-scale), no
  // recenter-on-click
  return (
    <fieldset disabled={staleIdentity} className="desk-control-scope"><div className={bare || surface?.detached ? "desk-bare" : "desk-over"} onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        // ROOT CAUSE (user bug 2026-09-03: "after the first drag finishes,
        // all subsequent drags immediately fail" / "focusing a node allows
        // it to work again once"). A focused desk fills most or all of the
        // viewport, so once ANY node ends up focused — an explicit click, or
        // just proximity to screen-centre past Z_DESK, which a pan itself
        // can trigger — every later canvas-pan gesture starts with its
        // pointerdown landing somewhere inside this div. Unconditionally
        // stopping propagation here ate that pointerdown before it could
        // ever reach NodeSquare/UserNode's own handlers, which already
        // special-case this: UserNode explicitly bypasses its own
        // stopPropagation via `.closest('.desk-over')` and NodeSquare skips
        // onDragStart `if (!focused)` — both exist ONLY to let a focused
        // desk's background bubble up into the viewport's pan machinery.
        // That bubbling never actually happened; this div ate the gesture
        // one level below where those checks run. Only claim the gesture
        // for real content/controls (typing, clicking, selecting message
        // text must never also drag the map) — a bare press on the desk's
        // own chrome must reach the canvas so the pan can restart.
        if ((e.target as Element).closest(
          'button, input, textarea, select, a, label, .msgs, .mailrow, .eff-pop')) {
          e.stopPropagation()
        }
      }} {...dropProps}
      onClick={(e) => {
        // clicking the desk's non-interactive space recenters the camera on
        // it (user ruling) — but never steal clicks meant for controls, and
        // never fight an in-progress text selection
        if ((e.target as Element).closest('button, input, textarea, select, a, label, .mailrow, .eff-pop')) return
        if (bare || surface?.detached || surfaceDocument.defaultView?.getSelection()?.toString()) return
        onRecenter?.()
      }}>
      <div className={(bare || surface?.detached ? 'desk-body eye-chat' : 'desk-inner desk-body') + providerClass + processClass}>{content}</div>
    </div></fieldset>
  )
}
export function HistoryView({ slug, nid, refs }: { slug: string; nid: string; refs?: RefRoutes }) {
  // G5: the agent keeps acting while this tab is open — a fetch-once list is
  // a photograph of the moment the tab was clicked
  const items = usePolled(() => getHistory(slug, nid).then((r) => r.items), [slug, nid])
  const profile = BASE ? 'public' : 'operator'
  return (
    <div className="msgs">
      {items == null && <div className="dim pad">loading…</div>}
      {items?.length === 0 && <div className="dim pad">nothing recorded yet</div>}
      {items?.map((it, i) => {
        const text = String(it.detail.gist ?? it.detail.text ?? Object.entries(it.detail)
          .filter(([k]) => k !== 'gist').map(([k, v]) => `${k}=${v}`).join(' · '))
        const row = {...it, text}
        const decoded = decodeEventRow(row, profile)
        return <div key={i} {...eventSurface(row, profile)} className={decoded.kind === 'legacy' ? 'hist-row' : 'hist-event ' + eventSurface(row, profile).className}>
          {decoded.kind === 'legacy' ? <span className="dim">{fmtFull(it.at)}</span>
            : <header className="event-head"><span className="dim">{fmtFull(it.at)}</span>
              <EventCard part="header" row={row} profile={profile} org={slug}
                world={refs?.world} onOpen={refs?.onOpen} actor={id => <MailFrom from={id}/>} /></header>}
          {decoded.kind === 'legacy' ? <><b>{it.kind}</b><span className="dim"><MailFrom from={it.actor}/></span><span>{text}</span></>
            : <EventCard part="body" row={row} profile={profile} org={slug} world={refs?.world} onOpen={refs?.onOpen}
                actor={id => <MailFrom from={id}/>} imgBase={fileBase(slug,nid)}/>}
        </div>
      })}
    </div>
  )
}

function FilesView({ slug, nid }: { slug: string; nid: string }) {
  const [path, setPath] = useState('')
  // G5: same — the agent writes into this very directory while you browse it
  const data = usePolled(() => getScratch(slug, nid, path), [slug, nid, path])
  const up = () => setPath(path.split('/').slice(0, -1).join('/'))
  // union split (type-only narrowing): a scratch payload is a dir listing OR
  // a file body — the two reads below each see only their variant
  const entries = data && 'entries' in data ? data.entries : null
  const content = data && 'content' in data ? data.content : null
  return (
    <div className="msgs files">
      <div className="hist-row">
        <button onClick={() => setPath('')}>scratch</button>
        {path && <button onClick={up}><ArrowUpIcon fontSize="inherit" /> up</button>}
        <span className="dim mono">/{path}</span>
      </div>
      {!data && <div className="dim pad">loading…</div>}
      {entries && !entries.length && <div className="dim pad">empty</div>}
      {entries?.map((e) => (
        <div key={e.name} className="hist-row">
          {e.dir
            ? <button onClick={() => setPath(path ? `${path}/${e.name}` : e.name)}><FolderIcon fontSize="inherit" /> {e.name}</button>
            : <button onClick={() => setPath(path ? `${path}/${e.name}` : e.name)}><FileIcon fontSize="inherit" /> {e.name}</button>}
          {!e.dir && <span className="dim">{fmtBytes(e.size)}</span>}
          {!e.dir && (
            <a className="fdl" title="download"
              href={fileUrl(slug, nid, path ? `${path}/${e.name}` : e.name)}
              download={e.name}><DownloadIcon fontSize="inherit" /></a>)}
        </div>
      ))}
      {content != null && <CopyablePre><pre className="filepre">{content}</pre></CopyablePre>}
    </div>
  )
}
interface LineagePanelProps {
  node: CanvasNode
  op: OpFn
  slug: string
  /** D-202: which provider families this machine has at all. Absent = the
   *  optimistic default (everything) — see `providerShown`. */
  presence?: ProviderPresence
  /** D-203: distinct from presence. An absent provider and one the user
   *  deliberately turned off both disappear elsewhere, but only the latter
   *  should disable this archived bearer's otherwise valid rehire path with
   *  a Settings-specific explanation. */
  userDisabled?: ProviderPresence
  /** the tree on screen, so an archived generation's transcript can identify
   *  the agents that wrote to it. This panel reads a REAL transcript through
   *  the same `Msg` the desk uses, mail cards and all — without these two it
   *  would be the one place a mail card silently drew a bare name again. */
  map?: Map<string, CanvasNode>
  onFocusAgent?: (id: string) => void
  close: () => void
}

export function LineagePanel({ node, op, slug, presence = ALL_PRESENT,
  userDisabled = { claude: false, openai: false, google: false, openrouter: false },
  map, onFocusAgent, close }: LineagePanelProps) {
  // spitshined (user request): generation cards in the app's current visual
  // language — tier token, per-generation consult-tier picker (№16: a bearer
  // answers from context, so any tier serves), live bearers marked green
  const [tiers, setTiers] = useState<Record<string, string>>({})       // per-generation tier override
  // №12: READING an archived bearer's transcript is free — rehiring is for
  // asking it questions, not for looking at what it holds
  const [reading, setReading] = useState<string | null>(null)     // bearer id being read
  // the identity facts for the archived transcripts read below. ⚠ Focusing an
  // agent from a MODAL closes the modal first, or the camera glides to a desk
  // behind this overlay. `onFocus` is omitted when the caller gave no route.
  // NO `destination`: a modal is nobody's focused desk, so every resolved name
  // navigates — the bearer's own self-mail included. Memoised on
  // `agentFactsSig` for the reason at DeskChatInner's copy.
  const mapRef = useRef(map); mapRef.current = map
  const focusRef = useRef(onFocusAgent); focusRef.current = onFocusAgent
  const closeRef = useRef(close); closeRef.current = close
  const canFocus = Boolean(onFocusAgent)
  const lineageFacts = agentFactsSig(map)
  const lineageDir = useMemo<AgentDirectory>(() => ({
    resolve: (id: string) => mapRef.current?.get(id),
    onFocus: canFocus
      ? (id: string) => { closeIfCentred('lineage', closeRef.current, slug); focusRef.current?.(id) }
      : undefined,
  }), [canFocus, lineageFacts])
  // retiring a knowledge bearer asks too (user bug 2026-08-09) — every other
  // seat-freeing button in the app confirms, and this one drops a whole
  // consultable generation off the end of the lineage
  const [retiring, setRetiring] = useState<string | null>(null)
  const [readChat, setReadChat] = useState<Pick<ChatPayload, 'messages'> | null>(null)
  const readingRef = useRef<string | null>(null)
  const openRead = (bid: string) => {
    if (reading === bid) { setReading(null); readingRef.current = null; return }
    setReading(bid); setReadChat(null)
    readingRef.current = bid
    // request guard (review): read_chat parses the whole transcript, so a
    // slow gen-3 landing after a fast gen-1 rendered under the wrong header
    getChat(slug, bid)
      .then((c) => { if (readingRef.current === bid) setReadChat(c) })
      .catch(() => {
        if (readingRef.current === bid) setReadChat({ messages: [] })
      })
  }
  // D-197: seats for EVERY provider's tiers. This was `TIER_SEAT` alone —
  // the claude-only table — so a codex or antigravity bearer rendered "as sol ·
  // seat undefined" and "retire · frees undefined" in its own lineage panel.
  const SEAT = (t: string) => anyTierSeat(t)
  // D-197: which tiers a generation may be rehired at. A bearer is rehired to
  // be CONSULTED, and a consult resumes the transcript it holds — but a
  // transcript cannot cross providers, so the offer is every tier of the
  // bearer's OWN provider, cheapest first (№16: consulting at a cheaper tier
  // is the whole point of the override).
  //
  // The cross-provider tiers are still LISTED, disabled, each carrying its
  // own reason. That is deliberate: this list used to be the literal
  // `['haiku','sonnet','opus']`, written before fable, codex and antigravity
  // existed, and silently omitting the rest read to the user as a system
  // quirk rather than a rule — which is exactly how it was reported. A gap
  // explains nothing; a disabled row with a reason does. Same semantics as
  // the model-switch dropdown in modals.tsx.
  //
  // ⚠ D-202 NARROWS THAT, and it is worth being precise about how, because
  // the paragraph above is still right about the case it was written for.
  // "A gap explains nothing" holds for a provider the user HAS — being told
  // why terra is unavailable is information. It does not hold for a provider
  // they have never installed: there the whole family is absent from the
  // product (user ruling 2026-08-30), and a disabled row would be the first
  // and only place the app mentions Codex exists. So: families that are
  // INSTALLED are listed, disabled, with their reason exactly as before;
  // families that are ABSENT are not listed at all. The bearer's own family
  // is always kept — it is the tier it is rehired AS.
  // an OpenRouter favorite runs on the Claude Code harness, but its session
  // is a different NAMESPACE (another endpoint, another key — D-196 /
  // INV-003), so for resume purposes it is its own family
  const famOf = (t: string) => CODEX_TIERS.includes(t) ? 'codex'
    : ANTIGRAVITY_TIERS.includes(t) ? 'antigravity'
      : isOpenRouterTier(t) ? 'openrouter' : 'claude'
  const providerKey = (t: string): keyof ProviderPresence => providerOf(t)
  const providerName = (t: string): string => PROVIDER_LABEL[providerOf(t)] ?? 'Claude'
  const rehireWhy = (t: string, bearerTier: string): string | null =>
    famOf(t) === famOf(bearerTier) ? null
      : `its transcript is a ${famOf(bearerTier)} session — ${famOf(t)} `
        + 'cannot resume it'
  const gens = [...(node.lineage ?? [])].sort(
    (a, b) => (b.generation ?? 0) - (a.generation ?? 0))
  return (
    <PinFrame kind="lineage" restore={{ agent: node.id, generation: node.generation }} title={`${node.id} — lineage`}
      panel="settings lineage-panel" close={close}>
        <h3><LayersIcon fontSize="inherit" /> {node.id} — lineage</h3>
        <div className="dim lin-blurb">
          Every generation is this agent's pre-compaction self, archived in
          place with its full context. Rehire one as a consultable knowledge
          bearer — it answers questions beside its successor; any tier of its
          own provider works, and cheaper tiers consult for fewer credits.
        </div>
        {gens.map((b) => (
          <div key={b.id}>
            <div className={'lin-row' + (b.state === 'archived' ? '' : ' live')}>
              <span className={'tier t-' + b.tier}>{TIER_LETTER[b.tier] ?? '?'}</span>
              <div className="lin-id">
                <b className="mono">{b.id}</b>
                <span className="dim">
                  generation {b.generation}
                  {b.bearer_state ? ` · ${b.bearer_state} bearer` : ''}
                </span>
              </div>
              {b.bearer_state !== 'lost' && (
                <button className={reading === b.id ? 'on' : ''}
                  title="read this generation's transcript — free, no seat"
                  onClick={() => openRead(b.id)}>read</button>)}
              {b.state === 'archived' && b.bearer_state !== 'lost' ? (
                userDisabled[providerKey(b.tier)] ? (
                  <span className="lin-provider-off">
                    {providerName(b.tier)} is off · App settings → Providers
                  </span>
                ) : <>
                  <select value={tiers[b.id] ?? ''} onChange={(e) =>
                    setTiers((t) => ({ ...t, [b.id]: e.target.value }))}>
                    <option value="">as {tierLabel(b.tier)} · seat {fmtCredits(SEAT(b.tier))}</option>
                    {[...ALL_TIERS, ...openrouterTierIds()]
                      .filter((t) => t !== b.tier
                        && tierShown(presence, t, b.tier))
                      .map((t) => {
                      const why = rehireWhy(t, b.tier)
                      // same one formatter as every other tier surface —
                      // all three declarations (unit C, 2026-09-05)
                      const tools = tierCapabilityNotes(t)
                      return (
                        <option key={t} value={t} disabled={!!why}>
                          as {tierLabel(t)} · seat {fmtCredits(SEAT(t))}{tools ? ` · ${tools}` : ''}{why ? ` — ${why}` : ''}
                        </option>
                      )
                    })}
                  </select>
                  <button className="primary" onClick={() =>
                    op({ op: 'rehire', node: b.id, grant: 0,
                         ...(tiers[b.id] ? { tier: tiers[b.id] } : {}) })
                      .then(close).catch(() => {})}>
                    <PlayIcon fontSize="inherit" /> rehire</button>
                </>
              ) : b.bearer_state === 'lost' ? (
                <span className="badge dim"
                  title="its session was lost — kept for the record, not consultable">
                  lost generation</span>
              ) : (
                <>
                  <span className="badge free">consultable</span>
                  <button className="danger" onClick={() => setRetiring(b.id)}>
                    retire · frees {SEAT(b.tier)}</button>
                </>
              )}
            </div>
            {reading === b.id && (
              <div className="lin-read">
                {readChat == null
                  ? <div className="dim pad">loading transcript…</div>
                  : readChat.messages.length
                    ? (
                      // the SAME identity facts the live desk supplies: an
                      // archived generation's mail cards would otherwise be
                      // the one place a sender fell back to a bare name.
                      // ⚠ `nid` here is the BEARER, used for file links only.
                      // It is NOT a destination — see `lineageDir`.
                      <AgentDirectoryProvider value={lineageDir}>
                        {readChat.messages.slice(-80).map((m, i) => (
                          <Msg key={i} m={m} slug={slug} nid={b.id} />))}
                      </AgentDirectoryProvider>
                    )
                    : <div className="dim pad">no transcript found</div>}
              </div>)}
          </div>
        ))}
        {!gens.length &&
          <div className="dim pad">no prior generations — this agent has never compacted</div>}
        <div className="row"><button onClick={close}>close</button></div>
      {/* ⚠ A CHILD OF THE FRAME IS NOT ENOUGH, and the earlier comment here
          was wrong: `position: fixed` fills the screen but does NOT escape the
          host's stacking context, so a confirmation nested inside a pinned
          panel is confined to that panel's z band and any window raised above
          the host paints over it (measured by codex-delivery). ModalOverPins
          portals it to <body>, above the whole band — the same fix compose
          needed for the mirror-image symptom. */}
      {retiring && (
        <ModalOverPins><ConfirmModal title={`retire generation ${retiring}?`}
          body="It stops being consultable and frees its seat. Its transcript is kept and rehire brings it back — but reading a bearer's transcript is free and needs no rehire at all."
          confirmLabel="retire"
          onConfirm={() => op({ op: 'retire', node: retiring })
            .then(close).catch(() => {})}
          close={() => setRetiring(null)} /></ModalOverPins>
      )}
    </PinFrame>
  )
}
/** The pending bubble's delivery RECEIPT (D-229). `stage` is where the server
 *  says the drained message is right now; the two legacy labels are kept
 *  byte-for-byte for rows from a backend that does not send one. A message no
 *  turn owns must never wear "delivering…" — that label was the whole of what
 *  the user saw while a stranded message sat in RAM (2026-09-02). */
export const pendTag = (m: PendingMail): string =>
  // ⚠ not "resend it": the batch is still durable and a restart re-presents
  // it, so a resend would deliver the message twice (review round 1)
  m.stage === 'stranded'
    ? '⚠ stuck — no turn owns this message; report it (an orgtree restart re-presents it)'
    : m.stage === 'queued'
      ? 'queued — delivers at the next turn boundary…'
    // D1: past the steer store. `claimed` does NOT mean the hook has it (a
    // lost response leaves a claim with nothing delivered); `acked` means the
    // hook said it received it; only the CLI's record makes it delivered
    : m.stage === 'claimed'
      ? 'claimed for the hook — awaiting its receipt…'
    : m.stage === 'acked'
      ? 'received by the hook — awaiting the CLI’s record…'
      : m.stage === 'turn' || (!m.stage && m.via === 'turn')
        ? 'delivering…'
        : 'delivering mid-task…'

/** One pending (undelivered) mail row: the SAME MailMessage card a settled
 *  transcript row draws — full width, identical cascade — with the
 *  pending-only chrome (the delivery receipt or the retract ✕) riding the
 *  card's own metadata strip, right-aligned at the top where the user asked
 *  the receipt to stay. It used to sit in a flex column BESIDE the card,
 *  which left every pending card ~200px narrower than its settled twin —
 *  the "still visually unlike the transcript" report (2026-09-10); the
 *  parity probe (pendparity_probe.py) now measures the two paths equal.
 *  Exported so that probe renders exactly what the desk mounts.
 *
 *  Journal-riding mail (drained for a mid-task delivery) shows as queued but
 *  is past the point of retraction. The tag is the message's delivery
 *  RECEIPT (D-229): it names where the message is, and a message no turn
 *  owns is said out loud instead of wearing the same "delivering…" as one
 *  that is genuinely on its way. */
export function PendingMailRow({ m, slug, nid, world, onOpen, replyAvailable,
  onLocateReply, onContext, onRetract }: {
  m: PendingMail; slug: string; nid: string
  world?: RefWorld; onOpen?: (r: ResolvedRef) => void
  replyAvailable?: (r: ReplyContext) => boolean
  onLocateReply?: (r: ReplyContext) => void
  onContext?: (e: React.MouseEvent) => void
  onRetract?: () => void
}) {
  // ⚠ PRESENT THE ROW AS THE TRANSCRIPT WILL. The user's own before/after
  // captures (2026-09-10, image-34/35) showed the same message wearing two
  // different cards one second apart: the pending copy carried a typed `ev`
  // and drew the event dress (dark event-surface, left accent, family
  // header) while the settled transcript row carries none and draws the
  // plain mail card (time · sender · kind chip). Visual identity means the
  // pending copy renders the SAME branch as the row it settles into, so the
  // typed-event keys are set aside for display — everything else about the
  // row (body, attachments, reply, receipt) is untouched.
  const { ev: _ev, ev_public: _evp, ev_raw: _evr, ev_error: _eve, ...presented } = m
  return (
    <div data-reply-event={m.event_id} data-reply-quote={m.body}
      onContextMenu={onContext} className="pending pendrow">
      <MailMessage row={presented} profile={BASE ? 'public' : 'operator'} slug={slug} nid={nid}
        world={world} onOpen={onOpen} actor={id => <MailFrom from={id} />}
        replyAvailable={replyAvailable} onLocateReply={onLocateReply}
        meta={m.delivering
          ? <span className={'dim pend-tag' + (m.stage === 'stranded' ? ' warn' : '')}>
              {pendTag(m)}</span>
          : m.id && onRetract
            ? <button className="chip-x pend-x" title="retract (undelivered)" onClick={onRetract}>
                <CloseIcon fontSize="inherit" /></button>
            : undefined} />
    </div>
  )
}

/** №17 for GHOSTS (user bug 2026-09-03: "i sent an invalid command and it got
 *  stuck as a permanently undelivered message that i cant cancel"). The
 *  durable pending bubbles have carried a retract ✕ since №17; these — the
 *  optimistic ones — carried nothing, so the one bubble the user could not
 *  get rid of was the one with no server record behind it.
 *  ⚠ The ✕ is DISMISS, not retract: there is nothing on the server to take
 *  back (a ghost has no id because nothing was filed), so it says so rather
 *  than implying a retraction it cannot perform. A failed one also offers ↩
 *  (onRestore, supplied only when the composer is empty — the user's typing
 *  is not ours to overwrite). Exported for the browser parity probe. */
export function PendingGhostRow({ p, slug, nid, world, onOpen, replyAvailable,
  onLocateReply, onContext, onRestore, onDismiss }: {
  p: PendingGhost; slug: string; nid: string
  world?: RefWorld; onOpen?: (r: ResolvedRef) => void
  replyAvailable?: (r: ReplyContext) => boolean
  onLocateReply?: (r: ReplyContext) => void
  onContext?: (e: React.MouseEvent) => void
  onRestore?: () => void
  onDismiss?: () => void
}) {
  // ⚠ no `.msg` on this wrapper: `.msg`'s `white-space: pre-wrap` and
  // `overflow-wrap: anywhere` leaked into the whole card, so a ghost's
  // markdown kept its source line breaks while the delivered copy reflowed —
  // measured by pendparity_probe.py. The card carries its own typography.
  // The reply excerpt travels INSIDE the card via the same reply_to wire a
  // settled row uses, not as a second block above it.
  return (
    <div data-reply-event="" onContextMenu={onContext}
      className={'pending pendghost' + (p.failed
        ? ' failed event-surface event-runtime_recovery' : '')}>
      <MailMessage
        row={{from: USER, kind: 'message', body: p.text, at: new Date(p.at).toISOString(),
          attachments: p.attachments, ...(p.reply ? { reply_to: replyWire(p.reply) } : {})}}
        profile={BASE ? 'public' : 'operator'} slug={slug} nid={nid}
        world={world} onOpen={onOpen} actor={id => <MailFrom from={id} />}
        replyAvailable={replyAvailable} onLocateReply={onLocateReply}
        meta={<span className="ghost-acts">
          {onRestore && (
            <button className="chip-x" title="put this text back in the composer"
              onClick={onRestore}>↩</button>)}
          <button className="chip-x"
            title={p.failed ? 'dismiss' : 'dismiss (removes it from your '
              + 'screen — nothing was filed on the server to retract)'}
            onClick={onDismiss}>
            <CloseIcon fontSize="inherit" /></button>
        </span>} />
      {p.failed && (
        <div className="ghost-why" role="status">
          <WarnIcon fontSize="inherit" /> {p.error
            ? `Send was not confirmed: ${p.error}. Delivery is unknown; check before retrying.`
            : <>not delivered — the turn ended without running it. If that was a slash command,
              nothing here or in the CLI answers to that name.</>}
        </div>)}
    </div>
  )
}

/** A mail sender's identity: its model chip and the route to its desk, or the
 *  plain name when this surface cannot vouch for it. Facts by context — see
 *  `AgentDirectory`.
 *
 *  ⚠ ELIGIBILITY IS TWO FACTS, and neither is the name matching:
 *  NAMESPACE — every party from outside the org enters with an `@ns:` prefix
 *  (`@mcp:`/`@org:`/`@net:`, the three call sites of `post_external_mail`)
 *  plus the `@user`/`@system` sentinels, so the '@' test excludes outsiders by
 *  ORIGIN; and EXISTENCE — the tree on screen must hold the node.
 *  `test_external_mail.py §5` is the check on the boundary half. */
function MailFrom({ from, nameClass }: { from: string; nameClass?: string }) {
  const dir = useAgentDirectory()
  const agent = from && !from.startsWith('@') ? dir?.resolve(from) : undefined
  // keyed on DESTINATION, supplied by the surface — never `from === nid`.
  // A pinned window and a switchboard panel show an agent's own self-mail
  // and must still navigate; only its focused desk is where the click
  // would go nowhere.
  const atDest = Boolean(dir?.destination) && dir!.destination === from
  if (!agent) return <b>{from}</b>
  // ⚠ THE CHIP IS THE SENDER'S CURRENT MODEL AND SAYS SO. The envelope
  // records no generation, so it cannot mean "the model that wrote this" the
  // way a docket actor line's does — same ruling and the same sentence as a
  // prose mention (workrefs.tsx). An unknown current tier draws NO chip
  // rather than a guess; TierChip already refuses a null.
  const why = (agent.tier ? `${from} — current model, ${agent.tier}.`
    : `${from} — current model not known.`)
    + (atDest ? ' This is its own desk.'
      : dir?.onFocus ? ' Go to its desk.' : '')
  return <AgentName id={from} tier={agent.tier} nameClass={nameClass}
    why={why} atDestination={atDest}
    onFocus={dir?.onFocus ? (id) => dir.onFocus!(id) : undefined} />
}

/** Live and settled inputs use the same validated composition. */
function LiveSteerRow({ text, segments, slug, nid, truncated, refs }:
  { text: string; segments?: unknown; slug: string; nid: string; truncated?: boolean; refs?: RefRoutes }) {
  const profile = BASE ? 'public' : 'operator'
  return <div className={isSegments(segments, profile) ? "typed-input live" : "msg user live"}>
    {isSegments(segments, profile)
      ? <SegmentList segments={segments} profile={profile} slug={slug} nid={nid}
          world={refs?.world} onOpen={refs?.onOpen} actor={id => <MailFrom from={id} />} />
      : <RefMdBody className="md" world={refs?.world} onOpen={refs?.onOpen} html={md(text, fileBase(slug, nid))} />}
    {truncated && <div className="trunc-note">Shown truncated ? the full text follows shortly</div>}
  </div>
}

// Parity №1/№9/№10: the tool line says what it did — argument on the chip, a
// red bit + first error line on failure, and the RESULT collapsed behind a
// click (never inline: an always-expanded stream turns the desk into a log
// tail). Edits expand to their pre-computed hunk.
interface ToolChipProps {
  t: ToolChipData
  slug: string
  nid: string
  onMailLink?: MailLinkFn
  onWorkLink?: WorkLinkFn
  onOpenDoc?: (id: string) => void
}

function ToolChip({ t, slug, nid, onMailLink, onWorkLink, onOpenDoc }: ToolChipProps) {
  const [open, setOpen] = useState(false)
  const expandable = Boolean(t.result || t.diff || t.images)
  if (t.presentation && !t.error && onOpenDoc) return <PresentationCard slug={slug}
    doc={t.presentation} className="presentation-chat-card" onOpen={onOpenDoc}>
    <DocIcon fontSize="inherit" /><span>{t.presentation.title}</span>
  </PresentationCard>
  // orgtree_send_file → a DOWNLOAD CARD in place of the chip (user spec
  // 2026-07-31: files flow back — the card sits where the agent sent it).
  // An IMAGE file renders as the picture itself (user spec 2026-08-25:
  // agents present images as a response): bounded inline, click = full-size
  // viewer, the download link rides the caption.
  if (t.file) {
    const file = t.file
    const href = fileUrl(slug, nid, file.path!)
    if (isImg(file.name)) {
      return (
        <div className="filecard imgcard" data-reply-event={t.result_event_id ?? ''} data-reply-quote={String(t.result_reply_quote ?? t.result ?? '')}>
          <img className="imgcard-img" src={href} alt={file.name}
            loading="lazy" title={`${file.name} — click to view`}
            onClick={() => openLightbox(href, { name: file.name, download: href })} />
          <ImgCardCaption name={file.name} bytes={file.bytes} href={href}
            note={file.note} />
        </div>
      )
    }
    return (
      <a className="filecard" data-reply-event={t.result_event_id ?? ''} data-reply-quote={String(t.result_reply_quote ?? t.result ?? '')} href={href}
        download={file.name} title="download">
        <DownloadIcon fontSize="inherit" className="fc-ico" />
        <span className="fc-body">
          <span className="fc-name">{file.name}</span>
          <span className="dim"> · {fmtBytes(file.bytes)}</span>
          {file.note && <span className="fc-note">{file.note}</span>}
        </span>
      </a>
    )
  }
  return (
    <div className={'tools tchip' + (t.error ? ' terr' : '')}>
      <span data-reply-event={t.event_id ?? ''} data-reply-quote={String(t.reply_quote ?? `${t.name} ${t.arg ?? ''}`)} className={'tline' + (expandable ? ' click' : '')}
        onClick={expandable ? () => setOpen((o) => !o) : undefined}
        title={expandable ? (open ? 'collapse' : 'expand') : undefined}>
        <DotIcon fontSize="inherit" className="tooldot" />
        {' '}{shortTool(t.name)}
        {t.arg ? <span className="targ"> {t.arg}</span> : null}
        {t.diff && <span className="tdiffn"> +{t.diff.plus} −{t.diff.minus}</span>}
        {!t.diff && !t.error && (t.result_lines ?? 0) > 0 && (
          <span className="dim"> · {t.result_lines} line{t.result_lines === 1 ? '' : 's'}</span>)}
        {t.task && (
          <span className="dim"> · {t.task.tools ?? '?'} tools
            {t.task.ms ? ` · ${Math.round(t.task.ms / 1000)}s` : ''}
            {t.task.tokens ? ` · ${Math.round(t.task.tokens / 1000)}k tok` : ''}</span>)}
        {(t.images ?? 0) > 0 && <span className="dim"> · {t.images} image{t.images === 1 ? '' : 's'}</span>}
        {t.error && <span className="terrtxt"> ⊘ {t.error}</span>}
        {/* mail sends carry the inline "open in mailbox" link (user spec):
            straight to the exact mail in whichever box holds it */}
        {t.mail && onMailLink && (
          <button className="maillink"
            title={t.mail.to === 'user_inbox'
              ? 'open this mail in your inbox'
              : `open this mail in ${String(t.mail.to).startsWith('@')
                ? 'the org inbox' : `${t.mail.to}'s inbox`}`}
            onClick={(e) => { e.stopPropagation(); onMailLink!(t.mail) }}>
            <MailIcon fontSize="inherit" /> open</button>)}
        {/* a DOCKET WRITE carries the same affordance (user 2026-09-05): the
            item the write acted on, opened and selected in the docket. `t.work`
            is set from the tool RESULT, so a failed call and the read actions
            simply do not have one — there is no "which item did they mean"
            guess anywhere in this path. */}
        {t.work && onWorkLink && (
          <button className="maillink worklink"
            title={`open ${t.work.slug} in the work docket`}
            onClick={(e) => { e.stopPropagation(); onWorkLink!(t.work) }}>
            <DocketIcon fontSize="inherit" /> open</button>)}
      </span>
      {open && t.diff && (
        <CopyablePre><pre className="filepre diffpre" data-reply-event={t.result_event_id ?? ''} data-reply-quote={String(t.result_reply_quote ?? t.result ?? '')}>
          {t.diff.lines.map((l, i) => (
            <div key={i} className={l.startsWith('@@') ? 'dhunk'
              : l.startsWith('+') ? 'dplus'
              : l.startsWith('-') ? 'dminus' : ''}>{l}</div>))}
          {t.diff.truncated && <div className="dim">… truncated</div>}
        </pre></CopyablePre>)}
      {open && !t.diff && t.result && (
        <CopyablePre><pre className="filepre respre" data-reply-event={t.result_event_id ?? ''} data-reply-quote={String(t.result_reply_quote ?? t.result ?? '')}>
          {t.result}{t.truncated ? '\n… truncated' : ''}
        </pre></CopyablePre>)}
      {open && (t.images ?? 0) > 0 && t.id && Array.from({ length: t.images! }).map((_, i) => (
        <img key={i} className="toolimg" data-reply-event={t.result_event_id ?? ''} data-reply-quote={String(t.result_reply_quote ?? t.result ?? '')} alt="tool result"
          src={`${BASE}/api/orgs/${slug}/nodes/${nid}/toolimg/${t.id}?idx=${i}`} />))}
    </div>
  )
}

// №21: memoized — rows are static once fetched; only identity changes matter
export const Msg = memo(function Msg({ m, slug, nid, onMailLink, onWorkLink, refs,
  replyAvailable, onLocateReply }: {
  m: ChatMessage; slug: string; nid: string
  onMailLink?: MailLinkFn; onWorkLink?: WorkLinkFn
  /** canonical references in this row's prose. Omitted = plain text, which is
   *  what a surface with nowhere to send anybody should render. */
  refs?: RefRoutes
  /** show-reply-context-on-sent-user-messages: whether/where a settled row's
   *  OWN reply reference can be located — see SegmentProps for the full
   *  contract. Omitted = the reference/excerpt still render, just inert. */
  replyAvailable?: (r: ReplyContext) => boolean
  onLocateReply?: (r: ReplyContext) => void
}) {
  if (m.role === 'system') return <SysLine m={m} />
  const profile = BASE ? 'public' : 'operator'
  if (m.role === 'user' && isSegments(m.segments, profile)) return <div className="typed-input">
    <SegmentList segments={m.segments} profile={profile} slug={slug} nid={nid}
      world={refs?.world} onOpen={refs?.onOpen} actor={id => <MailFrom from={id} />}
      replyAvailable={replyAvailable} onLocateReply={onLocateReply} />
    {m.truncated && <div className="trunc-note">Shown truncated ? the agent received the full message</div>}
    {m.steered && m.receipt && <div className="trunc-note">{m.receipt}</div>}
  </div>
  const text = m.text
  // relative image srcs in the text (`![](outbox/plot.png)`) resolve against
  // this node's own files — the way an agent embeds a picture in its reply
  const fb = fileBase(slug, nid)
  return (
    <div className={'msg ' + m.role + (m.oracle ? ' oracle' : '')}>
      {(m.thinking || m.thinking_sealed) &&
        <div className="reply-event" data-reply-event={m.thinking_event_id ?? ''} data-reply-quote={m.thinking_reply_quote ?? m.thinking ?? ''}><ThoughtLine text={m.thinking} secs={m.think_secs}
          sealed={m.thinking_sealed} /></div>}
      {/* (the string branch guards legacy live rows; the payload's tools
          rows are null-swept server-side, so no null case exists) */}
      {(m.tools ?? []).map((t, i) => (typeof t === 'string'
        ? <div key={i} className="tools"><DotIcon fontSize="inherit" className="tooldot" /> {t}</div>
        : <ToolChip key={t.id ?? i} t={t} slug={slug} nid={nid}
            onMailLink={onMailLink} onWorkLink={onWorkLink}
            onOpenDoc={refs ? id => refs.onOpen(resolveRef({kind:'doc', org:slug, id}, refs.world)) : undefined} />))}
      {/* render-inline-html-custom-responses: this row renders BOTH roles —
          the agent's own settled reply AND the user's own settled message
          (the non-segment path above). Only `assistant` is a genuine agent
          response; the user's own text must stay exactly as inert as mail,
          tool output and presented documents. */}
      {text && <RefMdBody className="msgtext md" world={refs?.world}
        onOpen={refs?.onOpen} html={md(text, fb, m.role === 'assistant')} />}
      {/* the display copy was capped server-side (steered-log per-row cap) —
          without this line the tail is just silently missing and the message
          reads as complete (user report 2026-08-17) */}
      {m.truncated && <div className="trunc-note">
        ✂ shown truncated — the agent received the full message</div>}
      {/* D1: a steered row says what its delivery rests on (server-built
          sentence: recorded / accepted / legacy handoff, retry, duplicate) */}
      {m.steered && m.receipt && <div className="trunc-note">{m.receipt}</div>}
      {m.oracle && <div className="tools"><SparkIcon fontSize="inherit" /> oracle exchange — not retained by the node</div>}
    </div>
  )
})

function ThoughtLine({ text, secs, sealed }:
{ text?: string; secs?: number; sealed?: boolean }) {
  const [open, setOpen] = useState(false)
  const dur = secs ? `${secs}s` : 'a moment'
  if (sealed || !text) {
    return (
      <div className="thoughtwrap">
        <span className="thoughtline sealed"
          title="the model's reasoning was not included in the response — only its duration is known">
          <PsychologyIcon fontSize="inherit" />{' '}thought for {dur}
        </span>
      </div>
    )
  }
  return (
    <div className="thoughtwrap">
      <button className="thoughtline" onClick={() => setOpen((o) => !o)}
        title={open ? 'collapse' : 'read the thought process'}>
        <PsychologyIcon fontSize="inherit" />
        {' '}thought for {dur} {open ? '▾' : '▸'}
      </button>
      {open && <div className="thoughtbody">{text}</div>}
    </div>
  )
}

// №5: the compaction boundary carries its summary behind a click — never a
// 20 KB bubble in the user's voice
function SysLine({ m }: { m: ChatMessage }) {
  const [open, setOpen] = useState(false)
  // slash-command output (/context…): the output IS the point — an always-
  // visible markdown block, fixed from the flash-then-vanish live-only bug
  if (m.cmd_out) {
    return (
      <div className="msg sys cmdout">
        <div className="msgtext md" dangerouslySetInnerHTML={md(m.cmd_out)} />
      </div>
    )
  }
  return (
    <div className={'msg sys' + (m.summary ? ' click' : '')}
      onClick={m.summary ? () => setOpen((o) => !o) : undefined}
      title={m.summary ? (open ? 'collapse' : 'read the compaction summary') : undefined}>
      {m.text}{m.summary && !open ? ' · summary ▶' : ''}
      {open && m.summary && <CopyablePre><pre className="filepre">{m.summary}</pre></CopyablePre>}
    </div>
  )
}

// Thinking-effort control in the composer (user spec): a SMALL button beside
// send; the five-dot track (Claude Code's control) lives in a popover it
// opens — never inline in the entry row. Click a dot to set low…max, click
// the active dot to clear back to the CLI default. The permission-mode half
// of Claude Code's bar is deliberately absent: org permissions decide what
// agents can do.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

// `effective` is what the next turn WILL run at, resolved server-side by
// Org.effective_effort — the same call that builds the --effort flag, so the
// control and the runtime cannot disagree. It is never empty: orgtree passes
// the flag on every turn precisely so that this can always name a level.
// (Reported three times before it was right. Attempt 1 read only
// node.scope.effort, so an unconfigured agent showed nothing. Attempt 2 fell
// back to an effort field in the transcript, which the CLI writes for opus and
// not for haiku — so it worked on the agent I happened to test and nowhere
// else. The lesson is in §7 of docs/state-architecture-review.md: read the
// value that CAUSES the behaviour, not one that correlates with it.)
function EffortButton({ value, effective, onSet }:
{ value: string; effective?: string
  onSet: (lvl: string) => Promise<unknown> | void }) {
  const [open, setOpen] = useState(false)
  // OPTIMISTIC (user report 2026-08-03: "a lag of around 3-5 seconds when i
  // change the effort level before it updates visually"). The control used to
  // render purely from the tree payload, so the click showed nothing until a
  // refetch landed — which is fast when a broadcast arrives and up to a full
  // heartbeat when one does not. The click already KNOWS the new level, so
  // stop making the user wait for the server to say it back.
  //
  // `null` = nothing pending, `''` = a pending CLEAR (distinct from null, which
  // is why this is not just a string). It is uncommitted-operation state, not a
  // mirror of server data — the same exception the retract path takes — and it
  // is dropped the moment the payload speaks, whatever the payload says, so a
  // rejected or clamped write corrects itself rather than sticking.
  //
  // ⚠ "the payload speaks" is an EFFECT ON CHANGE — a 200 that changes nothing
  // (the write clamped or ignored, props come back identical) never fires it,
  // and the phantom level would stick with its .saving dim forever. So a
  // resolved write also arms a bounded settle: if the payload has not spoken
  // within a broadcast round-trip, drop the phantom and show the truth.
  const [pending, setPending] = useState<string | null>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { setPending(null) }, [value, effective])
  useEffect(() => () => { if (settle.current) clearTimeout(settle.current) }, [])
  // a pending CLEAR falls back to `effective`, which is still the old level for
  // one refresh — the org default is not known here. Transient and honest: it
  // is what the control showed before this change anyway.
  const shown = (pending || value || effective || '')
  const why = value ? 'set on this agent'
    : 'inherited — change it on this agent, or org-wide in ⚙ settings'
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    if (!open) return
    // capture-phase on window: fires before the desk's stopPropagation walls
    const away = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node | null)) setOpen(false)
    }
    const owner = wrapRef.current?.ownerDocument.defaultView ?? window
    owner.addEventListener('pointerdown', away, true)
    return () => owner.removeEventListener('pointerdown', away, true)
  }, [open])
  return (
    <span className="eff-wrap" ref={wrapRef}>
      <button type="button"
        className={'cc-eff' + ((pending ?? value) ? ' set' : shown ? ' inherited' : '')
          + (pending !== null ? ' saving' : '')}
        title={`thinking effort — ${shown || 'unset'} (${why})`}
        onClick={() => setOpen((o) => !o)}>
        {shown || 'effort'}
      </button>
      {open && (
        <span className="eff-pop">
          <EffortSwitch value={pending ?? value} level={shown}
            why={(pending ?? value) ? 'set here' : 'inherited'}
            onSet={(lvl) => {
              setPending(lvl)
              setOpen(false)
              if (settle.current) clearTimeout(settle.current)
              // the payload normally lands first and clears this; the settle
              // covers a 200 that changed nothing, the catch a write that
              // never landed at all
              Promise.resolve(onSet(lvl))
                .then(() => { settle.current = setTimeout(() => setPending(null), 2500) })
                .catch(() => setPending(null))
            }} />
        </span>
      )}
    </span>
  )
}

function EffortSwitch({ value, level, why, onSet }:
{ value: string; level: string; why: string; onSet: (lvl: string) => void }) {
  // the track lights at the level that will actually be USED so it always says
  // what will happen; `pinned` is what a click can clear, which is only the
  // node's own setting — clicking an unpinned dot pins it rather than clearing
  // nothing. `why` is the caller's one description of where the level came
  // from, so the button and the popover can never word it differently.
  const pinned = EFFORT_LEVELS.indexOf(value)
  const idx = pinned >= 0 ? pinned : EFFORT_LEVELS.indexOf(level)
  return (
    <span className="effort-switch"
      title={`thinking effort — ${level || 'unset'} (${why})`
        + '; click a dot to set, click the active dot to clear back to inherit'}>
      <span className="eff-label">Effort{level
        ? ` (${level}${value ? '' : ` — ${why}`})` : ''}</span>
      <span className="eff-track">
        {EFFORT_LEVELS.map((l, i) => (
          <button key={l} type="button"
            className={'eff-dot' + (i === idx ? ' on' : '')
              + (idx >= 0 && i < idx ? ' below' : '')
              + (pinned < 0 ? ' faint' : '')}
            title={l}
            onClick={() => onSet(i === pinned ? '' : l)} />
        ))}
      </span>
    </span>
  )
}

// Slash commands (user-approved 2026-07-31): light HINTING when the draft
// starts with "/" — a curated list of commands known to work headless, not a
// clickable palette. Sent verbatim as a session command (no mail envelope).
const SLASH_COMMANDS: [string, string][] = [
  // review C4: /compact routes to the SAME §8 org split as the compact
  // button (fork → compact → knowledge bearer) — the hint must not describe
  // a bearer-less in-place compaction as "what the org does automatically"
  ['/compact', 'compact the org way (§8): the pre-compaction self is kept as a knowledge bearer'],
  ['/context', 'show what is using the context window'],
  ['/cost', 'token + cost usage for this session'],
]

function SlashHints({ text, setText }: { text: string; setText: (v: string) => void }) {
  const head = text.trim().split(/\s/)[0]! // nUIA: split always yields at least one element
  const rows = SLASH_COMMANDS.filter(([c]) => c.startsWith(head))
  return (
    <div className="slash-hints">
      {rows.map(([c, d]) => (
        <button key={c} className="slash-row" onClick={() => setText(c)}>
          <b>{c}</b> <span className="dim">{d}</span>
        </button>
      ))}
      <span className="dim slash-note">
        sent as a session command, not mail — other CLI commands may work; the
        interactive-only ones will not
      </span>
    </div>
  )
}
