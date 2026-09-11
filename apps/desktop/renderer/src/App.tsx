import type { DesktopNotice } from './notifications'
import { notificationInboxTarget, useNativeNotifications } from './notifications'
import { restoredAgent, restoredWindows, restoreWindowKind } from './windowlayout'
import { desktop } from './desktop'
import type { NativeDesktop } from './desktop'
import { WindowControls } from './window-controls'
import { UpdateNotice } from './update-notice'
import { Connections as NetTab } from './canvas/connections'
import { sendLinkedReply } from './events/reply'
import { CurrentOrg, RestartNotice, WindowMirrors, useOrgTransition } from './popout'
import { Onboarding, onboardingCreate, showOnboarding } from './canvas/onboarding'
import type { NativePreferences } from './desktop'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  audienceAction, BASE, clearInbox, createOrg, deleteOrg,
  fileBase, fileUrl, getAudiences, getDefaults, getEvents, getHost, getInbox,
  getMailById, getOrgMd,
  getAccountRegistry, getRegisteredAccountUsage,
  getAntigravityUsage, getAntigravityUsagePeek,
  getCodexUsage, getCodexUsagePeek, getOpenRouterUsage, getOpenRouterUsagePeek,
  getProviders, getTree,
  getUsage, getUsagePeek, killAll, listOrgs,
  markRead, openWs,
  probeHub, putOrgMd,
  resumeFrozen, runOp, saveDefaults, saveSettings,
} from './api'
import { fmtClock, fmtFull } from './timefmt'
import { bumpLive } from './livebus'
import { AudienceFold, ConfirmModal, MailFolders, MailList, OrgCanvas, OrgRecord, RetiredFold } from './Canvas'
import { KillSwitch } from './KillSwitch'
import {
  AutorenewIcon, BlockIcon, CheckIcon, ChevronRightIcon, CloseIcon, CopyIcon, EyeIcon, LanIcon,
  DataUsageIcon, DeleteIcon, DocIcon, DocketIcon, ExpandMoreIcon, GitHubIcon, HearingIcon, HomeIcon, LockIcon,
  LockOpenIcon, MailIcon, MenuIcon, PlayIcon, PublicIcon, SettingsIcon,
  StopIcon, StorageIcon, WarnIcon,
} from './icons'
import { DirList } from './forms'
import { FolderPickerHost } from './picker'
import { activeDocCount, ALL_TIERS, attentionPip, availableAutopsyModels, deskDpi, fallbackActive, fmtCredits, formatCount, isOpenRouterTier, jumpKey, jumpTo, orgPxc, presenceOfPayload, primedRestartChip, setDeskDpi, TIER_LETTER, tierLabel, unicodeLength, usePolled } from './canvas/shared'
import { AskCard } from './canvas/asks'
import { AgentName } from './canvas/identity'
import { AccountsPanel, ProviderSignIn, UsageBars } from './canvas/accounts'
import { StandingMarks } from './accountusage'
import { AgentGalleryModal, DocGalleryModal } from './canvas/gallery'
import { HistoryView } from './history'
import { DocketModal, DocketToolbarButton } from './canvas/docket'
import { closeIfCentred, isModalPinned, PinFrame, pinnedModalBehind, raisePinnedModal, readModalOpen, toggleOrRaiseModal, usePersistedModalOpen } from './canvas/modalpin'
import { mailRefTarget, refToken, useRefRoutes } from './canvas/reflinks'
import type { TypedRef } from './canvas/workrefs'
import {
  SetBlock, SetGroup, SetRow, SettingsTabPanel, SettingsTabs, SetToggle,
  useVisitedTabs,
} from './canvas/settingskit'
import type { SettingsTab } from './canvas/settingskit'
import { ingestPulse, ingestStream, resetConvos } from './convo'
import type {
  AccountUsage, AskInfo, AudiencesPayload, CacheForecast, DefaultsPayload, HostPayload, InboxPayload,
  MailEntry, OpRequest, OrgEvent, OrgListEntry, OrgMdPayload, ToastFn,
  ProvidersPayload,
  AntigravityEstimate as AgyEstimate,
  AccountRegistryRow,
  ToastUndo, TreeFrozen, TreeNode, TreePayload, UsageLimit, UsagePayload, UsagePeek,
} from './types'
import type { JumpReq, MailRow, ProviderPresence } from './canvas/shared'

/** the cost chip's hover split: how much of the org total was billed to the
 *  api_fallback key vs the subscription. '' when the org has never used (and
 *  doesn't hold) a fallback key — the tooltip stays quiet rather than showing
 *  a meaningless $0.00 lane. */
const costSplitTitle = (tree: TreePayload): string => {
  const api = tree.api_cost_usd_total ?? 0
  if (!(api > 0 || tree.api_fallback)) return ''
  return `subscription $${Math.max(0, tree.cost_usd_total - api).toFixed(2)}`
    + ` · api key $${api.toFixed(2)}`
}
export const costLabel = (tree: Pick<TreePayload, 'cost_usd_total' | 'cost_usd_unknown'>): string =>
  tree.cost_usd_unknown
    ? (tree.cost_usd_total > 0
      ? `$${tree.cost_usd_total.toFixed(2)} estimated/incomplete` : '$?')
    : `$${tree.cost_usd_total.toFixed(2)}`
const costUnknownTitle = (tree: TreePayload): string => tree.cost_usd_unknown
  ? 'recorded numeric estimate; unresolved amounts are not accounted for' : ''
export const showCost = (tree: Pick<TreePayload, 'cost_usd_total' | 'cost_usd_unknown'>): boolean =>
  tree.cost_usd_total > 0 || Boolean(tree.cost_usd_unknown)
export const costTitle = (tree: TreePayload, kiosk = false): string => [
  kiosk ? 'spend / limit' : (costSplitTitle(tree) || 'total spend'),
  kiosk ? costSplitTitle(tree) : '', costUnknownTitle(tree),
].filter(Boolean).join(' — ')
const USER = '@user'       // typed actor sentinels — a node may be NAMED user/system
const SYSTEM = '@system'

// the WS broadcast shapes the handler actually reads (any other event type
// only triggers the tree refetch) — cast once at the JSON.parse boundary
type WsEvent =
  | { type: 'mail'; from: string; to: string }
  | { type: 'node_stream'; event_id?: string; reply_quote?: string; node: string; kind: string; text?: string; sticky?: boolean; id?: string;
      segments?: unknown; delivery?: unknown;
      count?: number | null; last_turn_count?: number | null; provider?: string;
      source?: string | null; reason?: string | null; emitted_at_ms?: number;
      waiting?: boolean; state?: string | null;
      forecast?: CacheForecast | null }
  | { type: 'node_event'; node: string; event: string; was?: string;
      renamed?: Record<string, string> }

function emitRename(slug: string, value: {
  was?: unknown; node?: unknown; renamed?: unknown
}): void {
  const was = typeof value.was === 'string' ? value.was : ''
  const node = typeof value.node === 'string' ? value.node : ''
  const raw = value.renamed
  const renames: Record<string, string> = {}
  if (raw && typeof raw === 'object') {
    for (const [from, to] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof to === 'string' && from && to) renames[from] = to
    }
  }
  if (was && node && !renames[was]) renames[was] = node
  if (!Object.keys(renames).length) return
  window.dispatchEvent(new CustomEvent('orgtree:rename', {
    detail: { slug, renames },
  }))
}

export const patchMcpNode = (
  node: TreeNode, id: string,
  data: Extract<WsEvent, { type: 'node_stream' }>,
): TreeNode => {
  const children = node.children.map((c) => patchMcpNode(c, id, data))
  const childChanged = children.some((c, i) => c !== node.children[i])
  if (node.id !== id) return childChanged ? { ...node, children } : node
  return {
    ...node, children,
    mcp_tool_count: typeof data.count === 'number' ? data.count : null,
    last_turn_mcp_tool_count: typeof data.last_turn_count === 'number'
      ? data.last_turn_count : null,
    mcp_tool_count_provider: data.provider ?? node.mcp_tool_count_provider,
    mcp_tool_count_source: data.source ?? null,
    mcp_tool_count_reason: data.reason ?? null,
  }
}

export const patchCacheNode = (
  node: TreeNode, id: string, forecast: CacheForecast | null,
): TreeNode => {
  const children = node.children.map((c) => patchCacheNode(c, id, forecast))
  const childChanged = children.some((c, i) => c !== node.children[i])
  if (node.id !== id) return childChanged ? { ...node, children } : node
  return { ...node, children, cache_forecast: forecast }
}

export const patchMcpReadinessNode = (
  node: TreeNode, id: string,
  data: Extract<WsEvent, { type: 'node_stream' }>,
): TreeNode => {
  const children = node.children.map((c) => patchMcpReadinessNode(c, id, data))
  const childChanged = children.some((c, i) => c !== node.children[i])
  if (node.id !== id) return childChanged ? { ...node, children } : node
  return {
    ...node, children,
    mcp_readiness_waiting: Boolean(data.waiting),
    mcp_readiness_state: data.state ?? null,
    mcp_readiness_reason: data.reason ?? null,
  }
}

/** D-202: the usage button's tooltip named "Claude and Codex" as a literal,
 *  which is a Codex mention on a machine that has never had Codex. The bars
 *  behind it exist for exactly these two providers (Antigravity has no usage
 *  route), so the label is the shown subset of them.
 *
 *  Falls back to the bare "usage limits" rather than an empty tail if neither
 *  is present — a state that only arises with Claude itself missing, where
 *  the button is nearly moot anyway and a dangling "usage limits — " would be
 *  the more visible defect. */
export const usageTitle = (pres: ProviderPresence): string => {
  const names = [pres.claude && 'Claude', pres.openai && 'Codex']
    .filter((s): s is string => !!s)
  return names.length ? `usage limits — ${names.join(' and ')}` : 'usage limits'
}

/** The activity chip is scoped to the current tree, but its tooltip answers
 * the wider machine question from the already-polled org list. `working` is
 * supervisor.working_count(), so it describes turns running now rather than
 * durable last_status values. Public org listings intentionally omit it. */
export const activeOrgTitle = (orgs: Pick<OrgListEntry, 'name' | 'working'>[]): string => {
  const known = orgs.filter((org) => typeof org.working === 'number')
  if (!known.length) return 'active agents by organization — unavailable'
  const active = known.filter((org) => org.working! > 0)
  return active.length
    ? `active agents by organization — ${active.map((org) => `${org.name}: ${org.working}`).join(' · ')}`
    : 'active agents by organization — none'
}

/** The provider-neutral header summary. It deliberately walks ALL_TIERS:
 * this is an inventory of live agents, not a provider picker.
 * ⚠ D-202 DELIBERATELY LEFT THIS ALONE. It looks like a provider surface and
 * is not: `.filter((tier) => byTier[tier])` means a family appears only when
 * an agent is actually running on it, so an absent provider contributes
 * nothing without being asked. Hiding a live Codex agent's own letter because
 * the CLI went missing would make the header lie about what is running —
 * the count is an inventory, and an inventory reports what is there. */
export function ActiveAgentSummary({ tree, orgs = [] }: {
  tree: TreePayload
  orgs?: Pick<OrgListEntry, 'name' | 'working'>[]
}) {
  const nodes = [...flatNodes(tree).values()].filter((n) => n.state === 'live')
  const busy = nodes.filter((n) => n.busy).length
  const byTier: Record<string, number> = {}
  for (const node of nodes) byTier[node.tier] = (byTier[node.tier] ?? 0) + 1
  const title = activeOrgTitle(orgs)
  return (
    <span className="chip agents"
      role="img" tabIndex={0} aria-label={title} title={title}>
      {nodes.length} live{busy > 0 ? ` · ${busy} active` : ''}
      {/* the OpenRouter tiers are runtime-minted, so the inventory takes them
          from what is actually running rather than from a static list */}
      {[...ALL_TIERS, ...Object.keys(byTier).filter(isOpenRouterTier).sort()]
        .filter((tier) => byTier[tier])
        .map((tier) => (
          <b key={tier} className={'t-' + tier}>
            {TIER_LETTER[tier]}{byTier[tier]}
          </b>
        ))}
    </span>
  )
}

/** The org list rows — the same columns the tray's primary-click list shows
 * (user spec 2026-09-10): an activity cell (spinner ONLY while that org has a
 * turn executing), the name, and an always-visible n/m count where n = agents
 * active now (`working`, supervisor.working_count()) and m = currently hired
 * agents (`live`). Every row renders every cell so the columns line up when
 * idle; a public listing row (no `working` — deliberately omitted server-side)
 * shows its hired count alone rather than inventing a zero. */
export function OrgRows({ orgs, slug, onPick, onDelete }: {
  orgs: OrgListEntry[]; slug: string | null
  onPick: (slug: string) => void; onDelete: (org: OrgListEntry) => void
}) {
  return <>
    {orgs.map((o) => (
      <div key={o.slug} role="button" tabIndex={0}
        className={'org' + (o.slug === slug ? ' current' : '')
          + (o.kiosk_cfg || o.kiosk ? ' kiosk-org' : '')}
        onClick={() => onPick(o.slug)}
        onKeyDown={(e) => { if (e.key === 'Enter') onPick(o.slug) }}>
        <span className="org-activity">
          {(o.working ?? 0) > 0 &&
            <span className="working-ct"
              title={`${o.working} agent${o.working === 1 ? '' : 's'} active — a turn executing now`}>
              <AutorenewIcon fontSize="inherit" className="cc-spin" /></span>}
        </span>
        <span className="org-name">
          <span className="org-name-text">{o.name}</span>
          {(o.kiosk_cfg || o.kiosk) &&
            <span className="kiosk-badge" title="kiosk org"><PublicIcon fontSize="inherit" /></span>}
        </span>
        <span className="org-counts dim" title="active / hired agents">
          {typeof o.working === 'number' ? `${o.working}/${o.live}` : `${o.live}`}
        </span>
        {/* kiosk orgs delete like any other (user report 2026-07-31: the
            old !o.kiosk gate left NO UI path at all — the server already
            refuses public deletes, so hiding the trash from the admin
            protected nothing) */}
        <button className="org-del"
          onClick={(e) => { e.stopPropagation(); onDelete(o) }}><DeleteIcon fontSize="inherit" /></button>
      </div>
    ))}
    {!orgs.length && <div className="dim pad">no organizations yet</div>}
  </>
}

/** The badge beside the sidebar's 'Orgtree' title (user 2026-09-10): the
 * RUNNING APP VERSION from the desktop shell — e.g. "2.0.0-alpha.8" — in the
 * seat the backend build hash used to hold; that hash stays in the tooltip.
 * A plain browser has no app version and gets no invented one: it keeps the
 * backend build hash as its visible badge, and shows nothing when even that
 * is unknown. */
export function TitleBadge({ appVersion, build }: {
  appVersion: string | null
  build: HostPayload['build'] | null
}) {
  const engine = build && build.commit !== 'unknown'
    ? `${build.branch ? `${build.branch}@${build.commit}` : build.commit}` : null
  if (appVersion) {
    return <span className="build-badge"
      title={`running app version ${appVersion}` + (engine
        ? ` — engine ${engine} started ${fmtFull(build!.started_at)}` : '')}>
      {appVersion}</span>
  }
  if (!engine) return null
  return <span className="build-badge"
    title={`running commit ${build!.commit}`
      + (build!.branch ? ` (branch ${build!.branch})` : '')
      + ` — started ${fmtFull(build!.started_at)}`}>
    {engine}</span>
}

// live-feed state threaded into OrgCanvas (boundary shapes — Canvas declares
// its own; reconcile if they drift)
// text is required on the OUT side: the backend sends it on every stream()
// emit (supervisor stream plumbing) — the `?? ''` at the construction site
// is the wire-boundary guard, not a real case
interface MailEvt { from: string; to: string; t: number }
interface Toast { id: number; lines: string[]; undo: ToastUndo | null }

/** G1: the tree is pulled on a timer as well as pushed. Slow enough to be
 *  invisible in cost (a ~4 KB payload every 6 s), fast enough that a missed
 *  push is a blink rather than a wedge. */
const TREE_POLL_MS = 6000

const slugFromPath = () => {
  // BASE is the /k/<token> prefix when served from a public kiosk URL
  const m = location.pathname.slice(BASE.length).match(/^\/o\/([a-z0-9@-]+)/)
  return m ? m[1]! : null // nUIA: group 1 is unconditional in the regex
}

export default function App() {
  // apply the stored desk text size before anything renders a desk
  useEffect(() => { setDeskDpi(deskDpi()) }, [])
  const [orgs, setOrgs] = useState<OrgListEntry[]>([])
  // false until the FIRST successful /api/orgs: first-run setup must never
  // flash at an existing installation whose list simply hasn't loaded yet
  const [orgsKnown, setOrgsKnown] = useState(false)
  const [slug, commitSlug] = useState<string | null>(() => slugFromPath() ?? (desktop() ? (() => { try { return localStorage.getItem('orgtree-desktop-last-org') } catch { return null } })() : null))   // /o/<slug> survives refresh
  const [tree, setTree] = useState<TreePayload | null>(null)
  const { request: setSlug, prompt: orgTransitionPrompt } = useOrgTransition(slug, commitSlug, BASE)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [error, setError] = useState<string | null>(null)
  // G4: `pulses` used to live here — a per-node record of the last turn event,
  // threaded App → OrgCanvas → EyeDesk/NodeSquare → DeskChat. Every consumer
  // of it is gone: the conversation refetches through convo.ts, and the node
  // inbox (its last real reader) polls itself now. DeskChat still destructured
  // it and its memo still compared it, but nothing read it — the same dead
  // prop chain `streams` was, and dead update paths are what make staleness
  // hard to see. ingestPulse still runs below; only the mirror is gone.
  const [mailEvt, setMailEvt] = useState<MailEvt | null>(null)
  // G4: `activity` used to live here — a Record<node, {phase,tool}> accumulated
  // from websocket frames and cleared on turn_done, i.e. a client-side copy of
  // something the supervisor already knows. A missed turn_done stranded an
  // indicator until the socket reconnected. It is a tree-payload field now
  // (api.py annotate(), derived from the live tail), so it self-heals on the
  // same heartbeat as everything else and no event can be missed.
  const [showSettings, setShowSettings] = useState(false)
  // the recovery browser: 'largest' = forced triage mode (the alert's path);
  // 'last' = whatever mode was used last (the header chip's path)
  const [showInbox, setShowInbox] = useState(false)
  // the mail a chat link or a reference targets — a REQUEST, so a second
  // click on the same message is a second request (`jumpTo` in shared.ts)
  const [inboxJump, setInboxJump] = useState<JumpReq | null>(null)
  const [drawer, setDrawer] = useState(false)
  const [doomedOrg, setDoomedOrg] = useState<OrgListEntry | null>(null)   // org row pending deletion
  const [showDefaults, setShowDefaults] = useState(false)   // global new-org defaults
  const [showAccounts, setShowAccounts] = useState(false)   // D-144 account registry
  const [showUsage, setShowUsage] = useState(false)         // host subscription usage bars

  // the documents gallery (user request 2026-09-03): every presented card,
  // org-wide, one place. It reads in its OWN right-hand pane (the mail
  // idiom the user asked for), so nothing about the canvas's reader is
  // lifted up here — that panel owns its selection.
  const [showGallery, setShowGallery] = useState(false)
  // The card's document shortcut opens the same list/reader layout scoped to
  // that agent, independently of whether its desk is currently pinned.
  const [agentGalleryId, setAgentGalleryId] = useState<string | null>(null)
  usePersistedModalOpen('agent-gallery', slug, Boolean(agentGalleryId), agentGalleryId ? {agent:agentGalleryId, generation: tree ? flatNodes(tree).get(agentGalleryId)?.generation : undefined} : undefined)
  // the native work docket (docket-final-spec.md) — its own list+pane modal,
  // same pattern as the gallery above.
  const [showDocket, setShowDocket] = useState(false)
  // a docket link from a tool chip: open the panel AT one item. Held as a
  // one-shot so re-opening the docket later does not silently re-select what
  // some earlier link pointed at — the panel consumes it and clears it.
  // ⚠ A REQUEST, NOT A TARGET. Two clicks on the same reference are two
  // requests, and the panel's latch compares the request — see `jumpTo`
  // in shared.ts.
  const [docketJump, setDocketJump] = useState<JumpReq | null>(null)
  // usage pins per org (user 2026-09-10 14:19) — its open marker follows the
  // org it was pinned in; at home (slug null) it is unpinnable and the
  // marker never writes
  usePersistedModalOpen('usage', slug, showUsage)
  // EVERY pinned surface's toggle button goes through one decision (user
  // ruling 2026-09-10 16:36, all pinned modals): a click that means "bring
  // up my window" must never silently close a pinned window that was merely
  // sitting behind another surface — see modalToggleAction for the
  // three-way rule (open / raise / close).
  const toggleSurface = useCallback((kind: string, open: boolean,
    set: (v: boolean) => void) =>
    toggleOrRaiseModal(kind, open, set, slug), [slug])
  const toggleUsage = useCallback(() =>
    toggleSurface('usage', showUsage, setShowUsage), [toggleSurface, showUsage])
  usePersistedModalOpen('defaults', null, showDefaults)
  usePersistedModalOpen('app-settings', null, showAccounts)
  usePersistedModalOpen('org-settings', slug, showSettings)
  usePersistedModalOpen('inbox', slug, showInbox)
  usePersistedModalOpen('gallery', slug, showGallery)
  usePersistedModalOpen('docket', slug, showDocket)
  const [focusAgent, setFocusAgent] = useState<string | null>(null)
  // a `@mail:` reference clicked in the docket. The docket owns no mailbox;
  // the canvas owns the router that knows which of the three a pointer belongs
  // to, so this is handed DOWN to it rather than re-decided here. One-shot,
  // like `focusAgent` above.
  const [mailJump, setMailJump] = useState<{ id: string; to: string; seq: number } | null>(null)
  // and a `@doc:` reference. The canvas owns the document reader (it opens
  // from the node chips), so this travels the same way the mail pointer does
  // rather than growing a second reader up here.
  const [docJump, setDocJump] = useState<string | null>(null)
  // the SAME world the user's inbox uses, for the other panel that renders
  // prose somebody wrote: a presented document. One builder, so the two
  // cannot answer differently about the same token (see `useShellRefs`).
  //
  // ⚠ `doc` IS ROUTED EVEN THOUGH THE GALLERY IS THE DOCUMENT PANEL. It
  // handles a document it LISTS itself, in place; this route is the fallback
  // for one it does not, and the reader it opens performs the exact fetch and
  // reports what it finds.
  const galleryRefs = useShellRefs(slug ?? '', tree ?? null, {
    onOpenItem: (item) => {
      setShowGallery(false); setDocketJump(jumpTo(item)); setShowDocket(true)
      raisePinnedModal('docket', slug)
    },
    onFocusAgent: (id) => { setShowGallery(false); setFocusAgent(id) },
    onOpenDoc: (id) => { setShowGallery(false); setDocJump(id) },
    onOpenMail: (r) => { setShowGallery(false); setMailJump({ ...mailRefTarget(r), seq: jumpTo(r.id).seq }) },
  })
  // the usage button GLOWS once a lane nears its wall (user feature
  // 2026-08-19), so a freeze stops being the first notice. It rides
  // /api/usage/peek — the CACHE-ONLY readout — because this poll runs whether
  // or not the modal was ever opened, and an always-on indicator must not be
  // able to add an upstream request; the server's warm loop is what keeps
  // that cache worth reading. usePolled also wakes on the livebus, so the
  // interval is only the floor.
  const usagePeek = usePolled(BASE ? noUsagePeek : getUsagePeek, [], 60000)
  const codexUsagePeek = usePolled(BASE ? noUsagePeek : getCodexUsagePeek, [], 60000)
  // the Antigravity standing is observed from turns (a wall + its reset),
  // never fetched — the same cache-only contract, so it may ride the glow
  const agyUsagePeek = usePolled(BASE ? noUsagePeek : getAntigravityUsagePeek, [], 60000)
  // OpenRouter: a prepaid credit balance, cache-only here too — see
  // openrouter_limits's module docstring for why a plain key never earns a
  // percentage without a spend cap, which is also why this lane rarely glows
  const orrUsagePeek = usePolled(BASE ? noUsagePeek : getOpenRouterUsagePeek, [], 60000)
  const usageAlert = useMemo(
    () => usagePeak(usagePeek, codexUsagePeek, agyUsagePeek, orrUsagePeek),
    [usagePeek, codexUsagePeek, agyUsagePeek, orrUsagePeek])
  // D-202: which providers this machine actually has, for the usage button's
  // label. Polled rather than fetched once so installing a CLI mid-session is
  // picked up; unresolved is ALL_PRESENT, i.e. exactly today's wording.
  const provPresence = presenceOfPayload(
    usePolled(BASE ? noProviders : getProviders, [], 60000))
  // mobile compact orgbar (D-125 ruling 2026-08-14, 'one row, banner→chip'):
  // the detail chips + resume banner collapse behind a ⋯ toggle
  const [barMore, setBarMore] = useState(false)
  // the running backend's build: a short commit + start time, so a person
  // can look at the page and confirm which deploy is actually serving —
  // fetched once, since it cannot change without a process restart (see
  // supervisor.build_info)
  const [build, setBuild] = useState<HostPayload['build'] | null>(null)
  const [nativeTarget, setNativeTarget] = useState<DesktopNotice | null>(null)
  useNativeNotifications(notice => {
    setNativeTarget(notice)
    if (notice.org !== slug) setSlug(notice.org)
  })
  // the tray's org list (primary click on the tray icon): the main process
  // has already shown the window and broadcasts the chosen org; making it
  // the active slug runs the ordinary switch path, which restores that
  // org's own saved pins, popouts and camera
  useEffect(() => {
    const bridge = desktop()
    if (!bridge) return
    return bridge.onEvent(event => {
      if ((event.type as string) !== 'open-org') return
      const org = (event.data as { org?: unknown } | null)?.org
      if (typeof org === 'string' && org) setSlug(org)
    })
  }, [setSlug])
  useEffect(() => {
    setShowUsage((isModalPinned('usage') && readModalOpen(null).some(r => r.kind === 'usage')) || restoreWindowKind('usage', null))
    setShowAccounts((isModalPinned('app-settings') && readModalOpen(null).some(r => r.kind === 'app-settings')) || restoreWindowKind('app-settings', null))
    setShowDefaults((isModalPinned('defaults') && readModalOpen(null).some(r => r.kind === 'defaults')) || restoreWindowKind('defaults', null))
  }, [])
  const restoredOrg = useRef<string | null>(null)
  useEffect(() => {
    if (!tree || tree.slug !== slug || restoredOrg.current === slug) return
    restoredOrg.current = slug
    const pinned = readModalOpen(slug)
    const pinnedKind = (kind: string) => pinned.some(r => r.kind === kind && isModalPinned(kind, slug))
    setShowUsage(pinnedKind('usage') || restoreWindowKind('usage', slug))
    setShowSettings(pinnedKind('org-settings') || restoreWindowKind('org-settings', slug))
    setShowInbox(pinnedKind('inbox') || restoreWindowKind('inbox', slug))
    setShowGallery(pinnedKind('gallery') || restoreWindowKind('gallery', slug))
    setShowDocket(pinnedKind('docket') || restoreWindowKind('docket', slug))
    const pinnedGallery = pinnedKind('agent-gallery') ? pinned.find(r => r.kind === 'agent-gallery' && r.org === slug)?.restore : undefined
    const galleryNode = pinnedGallery?.agent ? flatNodes(tree).get(pinnedGallery.agent) : undefined
    setAgentGalleryId(galleryNode && galleryNode.generation === pinnedGallery?.generation ? galleryNode.id
      : restoredAgent(restoredWindows(slug).find(r => r.kind === 'agent-gallery'), flatNodes(tree)))
  }, [tree, slug])
  useEffect(() => {
    if (!nativeTarget || !tree || tree.slug !== nativeTarget.org || slug !== nativeTarget.org) return
    if (nativeTarget.item) { setDocketJump(jumpTo(nativeTarget.item)); setShowDocket(true); raisePinnedModal('docket', slug) }
    else { setShowInbox(true); setInboxJump(jumpTo(notificationInboxTarget(nativeTarget))); raisePinnedModal('inbox', slug) }
    setNativeTarget(null)
  }, [nativeTarget, tree, slug])
  useEffect(() => { getHost().then((h) => setBuild(h.build)).catch(() => {}) }, [])
  // The running APP version, shown beside the sidebar title (user 2026-09-10,
  // e.g. "2.0.0-alpha.8"). It comes from the desktop shell's own bridge —
  // packaging is what has a version, not the backend's git state — via the
  // getAppVersion the native side exposes; older shells (and the plain
  // browser) simply don't have it and show no invented version. Typed as an
  // optional probe rather than through DesktopBridge because the contracts
  // file is the native side's to declare.
  const [appVersion, setAppVersion] = useState<string | null>(null)
  useEffect(() => {
    const bridge = desktop() as (NativeDesktop & { getAppVersion?: () => Promise<unknown> }) | undefined
    let alive = true
    bridge?.getAppVersion?.().then((v: unknown) => {
      if (alive && typeof v === 'string' && v) setAppVersion(v)
    }).catch(() => {})
    return () => { alive = false }
  }, [])
  const wsRef = useRef<WebSocket | null>(null)

  // №17: a toast may carry an UNDO — a 12-second reverse on the gesture just
  // made (mis-drag reorders, accidental promotes, one-click retires)
  const toast = useCallback((lines?: string[] | null, undo: ToastUndo | null = null) => {
    if (!lines || !lines.length) return
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, lines, undo }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 12000)
  }, [])

  // the error banner used to have no clearer at all: a transient fetch
  // failure set it and it sat there until F5, even once polling (below)
  // had long since started succeeding again. Asymmetric on purpose — slow
  // to alarm, quick to reassure — so ONE blip doesn't flicker the banner,
  // but recovery is instant: a streak ref (not state) survives across
  // polls without a re-render of its own, and any successful fetch either
  // source makes is proof the backend is reachable again.
  const errStreak = useRef(0)
  const ERROR_STREAK = 2
  const fetchOk = useCallback(() => { errStreak.current = 0; setError(null) }, [])
  const fetchErr = useCallback((e: Error) => {
    errStreak.current += 1
    if (errStreak.current >= ERROR_STREAK) setError(e.message)
  }, [])
  const refreshOrgs = useCallback(() =>
    listOrgs().then((o) => { setOrgs(o); setOrgsKnown(true); fetchOk() }).catch(fetchErr), [fetchOk, fetchErr])
  // desktop preferences, only for the first-run gate below; the onboarding
  // card manages its own live copy once shown
  const [deskPrefs, setDeskPrefs] = useState<NativePreferences | null>(null)
  useEffect(() => {
    const bridge = desktop()
    if (!bridge) return
    let alive = true
    bridge.getPreferences().then(p => { if (alive) setDeskPrefs(p) }).catch(() => {})
    const unsubscribe = bridge.onEvent(e => {
      if (e.type === 'preferences' && alive) setDeskPrefs(e.data as NativePreferences)
    })
    return () => { alive = false; unsubscribe() }
  }, [])
  // G1b — ONE TREE FETCH IN FLIGHT, AND NEVER A LOST ONE.
  //
  // `refreshTree` is called from two unthrottled sources: the 6 s heartbeat
  // below, and EVERY websocket `changed` frame — i.e. every `save_org` by any
  // agent, the supervisor or another tab. Neither knew whether the last fetch
  // had come back, so a slow render multiplied itself: MEASURED 2026-09-03,
  // one `GET /api/orgs/{slug}` took 11-38 s alone and 113 s with two in
  // flight, past `DEFAULT_TIMEOUT_MS` — the "signal timed out" banner. Worse,
  // HTTP/1.1 caps a browser at ~6 sockets per origin, so a stack of stalled
  // tree polls starves everything else on the page; that is why the agent
  // CHAT stopped loading while the backend was answering chat in ~2 s.
  //
  // ⚠ COALESCE, NEVER DROP. A `changed` frame means the doc really moved, so
  // skipping its refetch would leave the UI stale against a change it was
  // told about — a new bug wearing a fix's clothes. A frame that arrives
  // mid-flight therefore sets `pending`, and the settle handler runs exactly
  // one more fetch, which starts AFTER the change landed. Any number of
  // frames during one fetch collapse into that single trailing refetch.
  const treeBusy = useRef(false)
  const treePending = useRef<string | null>(null)
  // …and the slug the app actually wants right now, for the guard below.
  // A ref rather than a dep so coalescing never re-creates this callback
  // (which would restart the heartbeat interval on every org switch).
  const wantSlug = useRef(slug)
  useEffect(() => { wantSlug.current = slug }, [slug])
  const refreshTree = useCallback((s: string | null) => {
    if (!s) return
    if (treeBusy.current) { treePending.current = s; return }
    const run = (want: string) => {
      treeBusy.current = true
      getTree(want).then((t) => {
        // ⚠ an ORG SWITCH mid-flight: this payload is the PREVIOUS org's
        // tree and painting it would show the old org under the new org's
        // header until the next poll. Not new caution — before coalescing,
        // the two fetches raced and the loser was whichever the network
        // happened to settle last, so the stale one could win. Now the
        // ordering is deterministic and the stale one is simply not applied;
        // the switch has already queued its own fetch as `pending`.
        if (wantSlug.current === want) setTree(t)
        fetchOk()
      }).catch(fetchErr).finally(() => {
        treeBusy.current = false
        const next = treePending.current
        treePending.current = null
        if (next) run(next)
      })
    }
    run(s)
  }, [fetchOk, fetchErr])

  useEffect(() => { refreshOrgs() }, [refreshOrgs])
  useEffect(() => { const imported = () => { void refreshOrgs() }; window.addEventListener('orgtree:organizations-imported', imported); return () => window.removeEventListener('orgtree:organizations-imported', imported) }, [refreshOrgs])
  // G1 — THE TREE HEARTBEAT. Everything on screen that is not the conversation
  // — every card, credit meter, occupancy bar, roster row, resume timer and
  // inbox badge — is rendered from this one payload, and until now it was
  // PUSH-ONLY: refetched on a websocket frame or in the acting client's own
  // callback, never on a timer. So any fact that reached the ledger without a
  // frame reaching THIS browser stayed invisible indefinitely — another tab's
  // edit, an endpoint that saved without broadcasting, a dropped frame, mail
  // (whose frame is animation-only and deliberately refetches nothing).
  //
  // This is the same lesson as the chat heartbeat (convo.beat, D-34) applied to
  // the other half of the app: the gate is "an org view is mounted", which is
  // known LOCALLY and cannot be stale.
  //
  // ⚠ THIS PULL IS NOT FREE, AND THE CLAIM THAT IT WAS IS HOW IT GOT
  // EXPENSIVE. Until 2026-09-03 the line here read "the payload is ~4 KB and
  // the endpoint answers in 2-12 ms, so the pull costs nothing worth
  // counting". MEASURED that day on an org with 6 live and 179 archived
  // seats: 881 KB and 11-38 s. Nothing warned, because the assertion of
  // cheapness sat in a comment where no test could reach it — and every
  // per-node field added to the tree payload since was weighed against it.
  // The COST OF ONE RENDER IS THE BUDGET THIS HEARTBEAT SPENDS SIX TIMES A
  // MINUTE, per open tab, plus once per `save_org`: measure it before adding
  // a per-node call to `annotate`, and never do filesystem work per node
  // there. `G1b` above now bounds the damage to one in-flight fetch; it does
  // not make the render cheap.
  useEffect(() => {
    if (!slug) return
    const t = setInterval(() => refreshTree(slug), TREE_POLL_MS)
    return () => clearInterval(t)
  }, [slug, refreshTree])
  useEffect(() => {          // the org list/dashboard is LIVE while visible —
    // kiosk spend/storage/caps move under it (agent turns, admin edits)
    if (slug && !drawer) return
    const t = setInterval(refreshOrgs, 3000)
    return () => clearInterval(t)
  }, [slug, drawer, refreshOrgs])
  useEffect(() => {          // kiosk: the single org IS the app — PUBLIC
    // builds only (BASE = /k/<token>). On the admin side orgs[0] can be a
    // kiosk org too (list_orgs carries the flag now), and a kiosk sorting
    // first hijacked the whole welcome screen into it
    if (BASE && !slug && orgs.length) setSlug(orgs[0]!.slug)
  }, [orgs, slug])

  useEffect(() => {                    // back/forward keep working
    const onPop = () => setSlug(slugFromPath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  useEffect(() => {                    // Escape dismisses the org drawer
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {                    // the active org lives in the path
    const want = BASE + (slug ? `/o/${slug}` : '/')
    if (location.pathname !== want) history.pushState(null, '', want)
  }, [slug])
  useEffect(() => {                    // №38: the tab title carries the unread
    // ⚠ the USER's inbox only. Org-inbox mail is addressed to the organization
    // and answered by its agents, so counting it here billed the user for
    // someone else's correspondence — and once the tile's badge went (user
    // 2026-08-10), a tab reading "(3)" would have pointed at nothing the user
    // could find or clear.
    const n = tree?.user_inbox_count ?? 0
    document.title = (n > 0 ? `(${n}) ` : '')
      + (tree?.name ? `${tree.name} — Orgtree` : 'Orgtree')
  }, [tree])

  // a conversation belongs to ONE org — dropping the store on an org switch
  // keeps a stale chat from ever being shown under a different tree
  useEffect(() => { resetConvos() }, [slug])
  useEffect(() => { if (desktop()) { try { if (slug) localStorage.setItem('orgtree-desktop-last-org', slug); else localStorage.removeItem('orgtree-desktop-last-org') } catch {} } }, [slug])
  useEffect(() => {
    if (!slug) return
    // the WS must SURVIVE backend restarts (updates, redeploys): without
    // auto-reconnect every state indicator froze at its last value until a
    // manual page reload — the "states never line up" bug
    let dead = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const connect = () => {
      if (dead) return
      refreshTree(slug)
      wsRef.current = openWs(slug, handleWs,
        () => { if (!dead) timer = setTimeout(connect, 1500) })
    }
    const handleWs = (ev: MessageEvent<string>) => {
      let data: WsEvent | null = null
      try { data = JSON.parse(ev.data) as WsEvent } catch { /* ignore */ }
      if (data?.type === 'mail') {     // spark on the wire — pure animation
        setMailEvt({ from: data.from, to: data.to, t: Date.now() })
        return
      }
      if (data?.type === 'node_stream') {
        if (data.kind === 'cache_forecast') {
          setTree((old) => old ? {
            ...old,
            roots: old.roots.map((n) => patchCacheNode(
              n, data.node, data.forecast ?? null)),
          } : old)
          return
        }
        if (data.kind === 'mcp_tool_count') {
          // Inventory is a hard-realtime process fact. Apply the websocket
          // payload directly; the next ordinary tree fetch is reconciliation,
          // not the primary update path.
          setTree((old) => old ? {
            ...old,
            roots: old.roots.map((n) => patchMcpNode(n, data.node, data)),
          } : old)
          window.dispatchEvent(new CustomEvent('orgtree:mcp-tool-count-applied', {
            detail: {
              node: data.node,
              latency_ms: typeof data.emitted_at_ms === 'number'
                ? Math.max(0, Date.now() - data.emitted_at_ms) : null,
            },
          }))
          return
        }
        if (data.kind === 'mcp_readiness') {
          setTree((old) => old ? {
            ...old,
            roots: old.roots.map((n) => patchMcpReadinessNode(
              n, data.node, data)),
          } : old)
          return
        }
        // the conversation model is fed ONCE here, not once per mounted view:
        // a node can be on screen twice (its card and its switchboard panel)
        // and two private copies of one conversation diverge by construction
        // (user bug 2026-08-02). See convo.ts.
        ingestStream(slug, {
          node: data.node, kind: data.kind, text: data.text ?? '',
          ...(typeof data.event_id === 'string' ? { event_id: data.event_id } : {}),
          ...(typeof data.reply_quote === 'string' ? { reply_quote: data.reply_quote } : {}),
          ...(data.segments !== undefined ? { segments: data.segments } : {}),
          ...(data.delivery !== undefined ? { delivery: data.delivery } : {}),
          // sticky rides through: immediate-command output lives in NO
          // transcript, so the live-feed reconciliation must never sweep it
          ...(data.sticky ? { sticky: true } : {}),
          ...(data.id ? { id: data.id as string } : {}), t: Date.now() })
        return   // live feed only — no tree refetch per message
      }
      if (data?.type === 'node_event') {
        if (data.event === 'renamed') emitRename(slug, data)
        ingestPulse(slug, { node: data.node, event: data.event, t: Date.now() })
        // toasts only here — the tree refetch is the shared one below (each
        // branch used to call refreshTree and then fall through to it again,
        // two fetches per event)
        if (data.event === 'frozen') {   // usage-limit / network popup
          toast([`${data.node} is FROZEN (usage limit or network interruption) — the resume button in the top bar releases it once the wait passes; auto-resume handles it for you if enabled`])
        }
        if (data.event === 'spend_frozen') {
          toast(['SPEND LIMIT REACHED — every agent is frozen; raise the limit in the org’s settings (⚙) to resume'])
        }
        if (data.event === 'storage_blocked') {
          toast(['WORKSPACE STORAGE LIMIT reached — file writes are blocked until enough files are deleted (agents keep running)'])
        }
        if (data.event === 'storage_cleared') {
          toast(['workspace back under its storage limit — writes unblocked'])
        }
      }
      refreshTree(slug)
      // the client's G2 (livebus.ts): a 'changed' means SOMEONE saved the
      // org doc — agents, the supervisor, another tab — so every mounted
      // polled surface refetches too, not just the tree
      bumpLive()
    }
    connect()
    return () => { dead = true; clearTimeout(timer!); wsRef.current?.close() }
  }, [slug, refreshTree])

  // op fires only from the active-org canvas — slug is set there (hence !)
  const op = useCallback((body: OpRequest) =>
    runOp(slug!, body)
      .then((r) => {
        if ((r as { renamed?: unknown; was?: unknown; node?: unknown }).renamed) {
          emitRename(slug!, r as unknown as {
            was?: unknown; node?: unknown; renamed?: unknown
          })
        }
        // op-specific result field (OpResult is open in types.ts) — the
        // ceiling-bridge marker, stated at the wire boundary
        const bridge = (r as { bridge?: { raise_ceiling?: boolean } } | null)?.bridge
        if (bridge?.raise_ceiling) {
          // the one-action bridge (ceiling spec §1): the same op, re-sent
          // with the flag — auto_raise OFF never means "go navigate"
          toast(r.warnings?.length ? r.warnings
            : ['clamped to the kiosk permission ceiling'],
          { label: 'raise ceiling & apply',
            fn: () => runOp(slug!, { ...body, raise_ceiling: true })
              .then((r2) => { toast(r2.warnings); refreshTree(slug); refreshOrgs() })
              .catch((e: Error) => toast([`error: ${e.message}`])) })
        } else toast(r.warnings)
        refreshTree(slug); refreshOrgs(); return r
      })
      .catch((e: Error) => { toast([`error: ${e.message}`]); throw e }),
    [slug, toast, refreshTree, refreshOrgs])

  const pick = (s: string) => { setSlug(s); setShowSettings(false); setDrawer(false) }
  const goHome = () => { setSlug(null); setDrawer(false) }

  const orgPanel = (showControls = true) => (
    <>
      {/* 'Orgtree', written the one way every visible title writes it (user
          2026-09-10 — the sidebar used to shout an uppercase 'ORGTREE' with
          a spark glyph while the home header said 'orgtree'). */}
      <h1>Orgtree
        <TitleBadge appVersion={appVersion} build={build} />
        <a className="gh-link h1-gh" href="https://github.com/Maurdekye/orgtree"
          target="_blank" rel="noreferrer" title="Orgtree on GitHub">
          <GitHubIcon fontSize="inherit" /></a>
        {!BASE &&
          <button className={'h1-usage' + (usageAlert ? ' u-' + usageAlert.sev : '')}
            title={usageAlert?.title ?? usageTitle(provPresence)}
            onClick={toggleUsage}>
            <DataUsageIcon fontSize="inherit" /></button>}
        {/* the accounts panel (machine-local routing, 2026-08-25). Beside
            the usage bars deliberately — they answer the same question
            ("which account is paying, and how close is it to a wall?") and
            are read together. */}
        {!BASE &&
          <button className="h1-usage" title="App settings"
            onClick={() => setShowAccounts(v => isModalPinned('app-settings') ? !v : true)}>
            <SettingsIcon fontSize="inherit" />
          </button>}
        {showControls && <UpdateNotice />}
        {showControls && <WindowControls />}</h1>
      {slug && <button className="home" onClick={goHome}><HomeIcon fontSize="inherit" /> all organizations</button>}
      <nav>
        <OrgRows orgs={orgs} slug={slug} onPick={pick}
          onDelete={(o) => setDoomedOrg(o)} />
      </nav>
      {!BASE && <NewOrg onCreate={(name, dirs, netAuto, netHubs) =>
        createOrg(name, dirs, netAuto, netHubs)
          .then((r) => { refreshOrgs(); pick(r.slug) })
          .catch((e: Error) => toast([`error: ${e.message}`]))} />}
      {/* global default org settings (user spec): every NEW org is born with
          these — admin only */}
      {!BASE && <button className="home" onClick={() => setShowDefaults(v => isModalPinned('defaults') ? !v : true)}>
        <SettingsIcon fontSize="inherit" /> default org settings</button>}
      {/* kiosk dashboard: admin only — a public visitor never sees this panel
          (and the server refuses the endpoints regardless) */}
    </>
  )

  return (
    <CurrentOrg.Provider value={slug}><div className="app">
      <RestartNotice />
      {orgTransitionPrompt}
      {/* no active org: the org list IS the screen */}
      {!slug && (
        <div className="welcome">
          {/* One window header for both first-run setup and the org list. */}
          {desktop() && <header className="orgbar native-header home-header">
            <h2>Orgtree</h2>
            <UpdateNotice />
            <WindowControls />
          </header>}
          {!BASE && showOnboarding(deskPrefs, orgs.length, orgsKnown) ? (
            <Onboarding>
              {/* completion runs INSIDE onboardingCreate, before refreshOrgs
                  unmounts this card — a child effect would never see it */}
              <NewOrg onCreate={(name, dirs, netAuto, netHubs) =>
                onboardingCreate(() => createOrg(name, dirs, netAuto, netHubs),
                  (m) => toast([`setup: charter documents were not populated — ${m}`]))
                  .then((r) => { refreshOrgs(); pick(r.slug) })
                  .catch((e: Error) => toast([`error: ${e.message}`]))} />
            </Onboarding>
          ) : (
            <div className="welcome-card">{orgPanel(!desktop())}</div>
          )}
        </div>
      )}

      {/* active org: full foreground; the list hides in a drawer */}
      {slug && (
        <main className="solo">
          {/* the tree hasn't loaded at all yet — no header, no canvas, nothing
              to shift, so the plain pre-header banner is harmless here. Once
              `tree` exists the SAME `error` string moves into the orgbar
              itself (below) instead, because that's where a connectivity
              blip after load would otherwise push the canvas down. */}
          {!tree && <>
            {desktop() && <header className="orgbar fallback-orgbar native-header">
              <h2>Orgtree</h2>
              <UpdateNotice />
              <WindowControls />
            </header>}
            {error && <div className="error">{error}</div>}
          </>}
          {tree ? (
            <>
              <header className={'orgbar' + (desktop() ? ' native-header' : '')}>
                <div className="native-header-main">
                {!tree.public &&
                  <button className="iconbtn" onClick={() => setDrawer(true)}><MenuIcon fontSize="inherit" /></button>}
                <span className="orgname-wrap">
                  <h2>{tree.name}</h2>
                  {/* connectivity/save-error banner, relocated into the header
                      (user report 2026-09-03): it used to be a block above the
                      header and pushed the whole canvas down whenever it
                      appeared or cleared. It's `position: absolute` here on
                      purpose — anchored off the org-name's own box rather
                      than sitting as a normal flex item, so its presence,
                      absence, or message length can NEVER change the height
                      the orgbar computes (that's the actual bug: a transient
                      message must not move whatever the user is doing under
                      the canvas). A long message truncates with an ellipsis;
                      the full text is always available via `title`. */}
                  <span className={'chip bad conn-chip' + (error ? ' show' : '')}
                    title={error ?? undefined}>
                    <WarnIcon fontSize="inherit" />
                    <span className="conn-chip-text">{error}</span>
                  </span>
                </span>
                {/* MOBILE-ONLY merged status chip (D-125 orgbar ruling): live
                    count · working · frozen in one glance; tapping it opens
                    the same ⋯ panel. display:none on desktop (.mob-only). */}
                {(() => {
                  const ns = [...flatNodes(tree).values()].filter((n) => n.state === 'live')
                  const busy = ns.filter((n) => n.busy).length
                  const froz = ns.filter((n) => n.frozen).length
                  return (
                    <button className={'chip mstat mob-only' + (froz ? ' bad' : '')}
                      onClick={() => setBarMore((v) => !v)}>
                      {ns.length} live{busy > 0 ? ` · ${busy}⟳` : ''}
                      {froz > 0 ? ` · ${froz} frozen` : ''}
                    </button>
                  )
                })()}
                {/* desktop: display:contents — the chips stay direct flex
                    items of the orgbar, byte-identical layout. Compact: the
                    whole run collapses behind ⋯ (D-125 orgbar ruling; the
                    resume banner + auto-resume toggle live in here). */}
                <div className={'bar-detail' + (barMore ? ' open' : '')}>
                {/* the ledger self-audit only speaks when something is wrong;
                    credit totals live on the eye's bar */}
                {!tree.audit.no_overdraft &&
                  <span className="chip bad"><WarnIcon fontSize="inherit" /> {tree.audit.problems.join(', ')}</span>}
                <ActiveAgentSummary tree={tree} orgs={orgs} />
                {/* the bare cost chip is redundant when the kiosk spend chip
                    already shows the same figure against its limit (user
                    spec 2026-07-31) — limitless orgs keep it */}
                {showCost(tree) && !tree.kiosk?.spend_limit &&
                  <span className="chip" title={costTitle(tree)}>
                    {costLabel(tree)}</span>}
                {tree.fable_lock &&
                  <span className="chip bad" title={tree.fable_lock.at as string | undefined}><BlockIcon fontSize="inherit" /> fable limit</span>}
                {tree.kiosk?.spend_limit && (
                  tree.spend_frozen
                    ? <span className="chip bad"><BlockIcon fontSize="inherit" /> spend limit reached — agents frozen</span>
                    : <span className={'chip' + (tree.cost_usd_total >= tree.kiosk.spend_limit * 0.9 ? ' bad' : '')}
                        title={costTitle(tree, true)}>
                        {costLabel(tree)} / ${tree.kiosk.spend_limit.toFixed(2)}
                      </span>
                )}

                {tree.headless && (
                  <span className="chip"
                    title="headless: no user is present — user-bound requests auto-deny; the eye renders grey and empty">
                    <EyeIcon fontSize="inherit" /> headless
                  </span>
                )}
                {/* FR-27 (user spec 2026-08-27): "some visual indication
                    somewhere that a prime is active and will trigger the next
                    moment the system quiesces".
                    ⚠ IT SHOWS IN EVERY ORG, and that is the point rather than
                    a side effect: the record is machine-wide because the
                    restart is machine-wide, so the org that gets cut without
                    having armed anything is exactly the one that most needs
                    the warning. The words live in `primedRestartChip` —
                    see the note there for why they are not inline. */}
                {(() => {
                  const pc = primedRestartChip(tree.primed_restart)
                  if (!pc) return null
                  return (
                    <span className="chip primed" title={pc.title}>
                      <AutorenewIcon fontSize="inherit" /> {pc.label}
                    </span>
                  )
                })()}
                {(() => {   // Only external connections get header tokens.
                  // The embedded hub has the stable id "local" (net.LOCAL_HUB_ID).
                  const hubs = (tree.net?.hubs ?? [])
                    .filter((h) => h.id !== 'local' && h.enabled && !h.hidden)
                  if (!hubs.length) return null
                  const up = hubs.filter((h) => h.connected).length
                  const queued = hubs.reduce((a, h) => a + h.queued, 0)
                  const label = hubs.length === 1
                    ? (hubs[0]?.name || 'hub') : `${up}/${hubs.length} hubs`
                  return (
                    <span className={'chip' + (up === 0 ? ' bad' : '')}
                      title={hubs.map((h) =>
                        `${h.name || h.address}: ${h.connected ? 'connected'
                          : h.error || 'connecting…'}`).join(' · ')}>
                      <LanIcon fontSize="inherit" /> {label}
                      {up === 0 ? ': offline' : ''}
                      {queued > 0 ? ` · ${queued} queued` : ''}
                    </span>
                  )
                })()}
                {/* the frozen-agents banner (resume-all ▶, the usage-limit warning
                    and the auto toggle) left the header (user 2026-09-10): auto-
                    resume lives in Settings → Autonomy now, and per-card freeze
                    badges still say who is frozen. Scheduling is untouched. */}
                {/* compact ⋯ panel extras — desktop hides these (.mob-only);
                    the real settings/kill controls sit right of the spacer
                    and are display:none at compact */}
                {!tree.public &&
                  <button className="mob-only bar-row"
                    onClick={() => { setBarMore(false); toggleSurface('org-settings', showSettings, setShowSettings) }}>
                    <SettingsIcon fontSize="inherit" /> settings</button>}
                <KillSwitch slug={slug} toast={toast} refreshTree={refreshTree}
                  onKilled={() => setBarMore(false)} className="mob-only" />
                </div>
                <span style={{ flex: 1 }} />
                {/* the killswitch: unlatch (expands STOP ALL to the left),
                    then press after 500ms safety window — interrupts EVERY
                    active agent and clears their queues */}
                <KillSwitch slug={slug} toast={toast} refreshTree={refreshTree} />
                {/* the SECOND inbox icon (user ruling 2026-08-04): it glows —
                    alone in the whole chrome — iff an un-nulled ask (question
                    or credit request) is waiting on the user. Two-tier badge
                    (user spec 2026-08-06, supersedes the 2026-08-05 full-total
                    ruling): with asks open the badge shows the ASK count in
                    the vibrant pulsing form; otherwise the unread-mail count,
                    muted. Click opens the inbox either way. */}
                {(() => {
                  // D-169: the rule is `attentionPip` now — one classifier,
                  // four surfaces. The 2026-08-04 ruling that this bell glows
                  // ALONE in the whole chrome is untouched; the user widened
                  // WHAT counts (urgent mail joins open asks), not the
                  // property. Nothing else in the chrome starts glowing.
                  const pip = attentionPip(tree)
                  return (
                    <button className={'iconbtn ask-bell' + (pip?.urgent ? ' glow' : '')}
                      title={pip?.title ?? 'your inbox'}
                      onClick={() => { setInboxJump(null); toggleSurface('inbox', showInbox, setShowInbox) }}>
                      <MailIcon fontSize="inherit" />
                      {pip && <b className={'eye-count' + (pip.urgent ? ' asks' : '')}>
                        {pip.count}</b>}
                    </button>
                  )
                })()}
                {/* the presented-document gallery sits BESIDE the inbox (user
                    ruling 2026-09-03: "place it next to the mail icon"). They
                    are the same kind of thing — a standing pile of what agents
                    sent you, read in the same list-plus-pane panel — so they
                    read as one pair of mailbox controls rather than two
                    unrelated buttons. */}
                {(() => {
                  // the corner count is the mail bell's own badge (.eye-count
                  // in a position:relative button), carrying the number of
                  // documents presented by CURRENTLY HIRED agents — the set
                  // the panel shows with "show retired agents" unticked. It
                  // never wears the `.asks` pulse: nothing here is waiting on
                  // an answer, and the 2026-08-04 ruling leaves the bell the
                  // only glowing thing in the chrome.
                  const docs = activeDocCount(tree.roots)
                  return (
                    <button className="iconbtn doc-bell"
                      title={docs > 0
                        ? `presented documents — ${docs} from currently-hired agents`
                        : 'presented documents'}
                      onClick={() => toggleSurface('gallery', showGallery, setShowGallery)}>
                      <DocIcon fontSize="inherit" />
                      {docs > 0 && <b className="eye-count">{docs}</b>}
                    </button>
                  )
                })()}
                {/* the work docket sits beside the gallery — same "standing
                    pile, read in a list+pane panel" family. Badge counts ride
                    the tree poll (docket-final-spec.md — no separate timer):
                    orange = items needing attention, else muted active count
                    (zero hidden). */}
                <DocketToolbarButton
                  summary={tree.work_items_summary}
                  onClick={() => toggleSurface('docket', showDocket, setShowDocket)} />
                <button className="iconbtn barmore mob-only" title="more"
                  onClick={() => setBarMore((v) => !v)}>⋯</button>
                {/* host subscription usage (the Claude Code /usage bars) —
                    the host account's own standing, so admin only: a kiosk
                    visitor neither sees the button nor could call the
                    endpoint (the public gateway 404s it) */}
                {!tree.public &&
                  <button className={'iconbtn' + (usageAlert ? ' u-' + usageAlert.sev : '')}
                    title={usageAlert?.title ?? usageTitle(provPresence)}
                    onClick={toggleUsage}>
                    <DataUsageIcon fontSize="inherit" /></button>}
                {/* gear-only (user 2026-09-10 header cleanup): Settings is
                    the door to Connections, History and Autonomy now, so it
                    keeps just the icon */}
                {!tree.public &&
                  <button className="iconbtn" title="Settings" aria-label="Settings"
                    onClick={() => toggleSurface('org-settings', showSettings, setShowSettings)}><SettingsIcon fontSize="inherit" /></button>}
                </div>
                {/* Native WindowControls owns refresh in the desktop shell; keep
                    the renderer-only action available when running in a browser. */}
                {!desktop() && <button type="button" className="iconbtn" title="refresh app view"
                  aria-label="refresh app view" onClick={() => window.location.reload()}>
                  <AutorenewIcon fontSize="inherit" />
                </button>}
                <UpdateNotice />
                <WindowControls />
              </header>
              <div className="canvas-stage">
              {desktop() && <div className="window-drag-margin" aria-hidden="true" />}
              <OrgCanvas tree={tree} op={op} slug={slug} toast={toast}
                mailEvt={mailEvt}
                focusAgent={focusAgent}
                onFocusAgentHandled={() => setFocusAgent(null)}
                openMailAt={mailJump}
                onOpenMailHandled={() => setMailJump(null)}
                openDocAt={docJump}
                onOpenDocHandled={() => setDocJump(null)}
                onOpenAgentGallery={(id) => {
                  // the same shortcut again is an activation click: raise a
                  // pinned window sitting behind, toggle off only from on top
                  if (agentGalleryId === id && isModalPinned('agent-gallery', slug)) {
                    if (pinnedModalBehind('agent-gallery', slug)) raisePinnedModal('agent-gallery', slug)
                    else setAgentGalleryId(null)
                    return
                  }
                  setAgentGalleryId(id)
                  raisePinnedModal('agent-gallery', slug)
                }}
                onAccounts={BASE ? undefined : () => setShowAccounts(v => isModalPinned('app-settings') ? !v : true)}
                onInbox={(jump: unknown) => {
                  if (typeof jump === 'string') {
                    // a targeted jump opens AND surfaces a pinned window —
                    // landing behind another surface reads as a dead click
                    setInboxJump(jumpTo(jump)); setShowInbox(true)
                    raisePinnedModal('inbox', slug)
                  } else {
                    setInboxJump(null)
                    toggleSurface('inbox', showInbox, setShowInbox)
                  }
                }}
                onWorkItem={(item: string) => {
                  setDocketJump(jumpTo(item))
                  setShowDocket(true)
                  raisePinnedModal('docket', slug)
                }} />
              {desktop() && <div className="window-drag-margin" aria-hidden="true" />}
              </div>
              {/* hard-full is a STATE, not an event: the alert persists (and
                  survives reloads) until usage drops; it never auto-opens
                  the browser — it carries the button (user refinement) */}
              {showSettings && (
                <SettingsPanel tree={tree} toast={toast}
                  close={() => { setShowSettings(false); refreshTree(slug) }} />
              )}
              {showInbox && (
                <InboxPanel slug={slug} tree={tree} toast={toast}
                  refresh={() => refreshTree(slug)}
                  jumpTo={inboxJump?.id ?? null} jumpSeq={inboxJump?.seq}
                  onFocusAgent={(id) => {
                    closeIfCentred('inbox', () => {
                      setShowInbox(false)
                      setInboxJump(null)
                    }, slug)
                    setFocusAgent(id)
                  }}
                  onOpenItem={(item) => {
                    // every destination is somewhere else, so each of these
                    // closes the inbox first: the panels they open are the
                    // same `.overlay` layer and would otherwise open BEHIND
                    // the mail the reader clicked from. A PINNED inbox is
                    // beside them rather than over them, so it stays.
                    closeIfCentred('inbox', () => {
                      setShowInbox(false); setInboxJump(null)
                    }, slug)
                    setDocketJump(jumpTo(item)); setShowDocket(true)
                    raisePinnedModal('docket', slug)
                  }}
                  onOpenDoc={(id) => {
                    closeIfCentred('inbox', () => {
                      setShowInbox(false); setInboxJump(null)
                    }, slug)
                    setDocJump(id)
                  }}
                  onOpenMail={(r) => {
                    closeIfCentred('inbox', () => {
                      setShowInbox(false); setInboxJump(null)
                    }, slug)
                    setMailJump({ ...mailRefTarget(r), seq: jumpTo(r.id).seq })
                  }}
                  close={() => {
                    setShowInbox(false); setInboxJump(null); refreshTree(slug)
                  }} />
              )}
            </>
          ) : <div className="empty">loading {slug}…</div>}
        </main>
      )}

      {drawer && (
        <div className="drawer-backdrop" onClick={() => setDrawer(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            {orgPanel(false)}
          </aside>
        </div>
      )}

      {showDefaults && (
        <DefaultsPanel toast={toast} close={() => setShowDefaults(false)} />
      )}
      {showUsage && (
        <UsageModal toast={toast} close={() => setShowUsage(false)} />
      )}
      {showGallery && slug && (
        <DocGalleryModal slug={slug} toast={toast}
          onOpenDocument={id => {closeIfCentred('gallery', () => setShowGallery(false), slug); setDocJump(id)}}
          onFocusAgent={(id) => {
            closeIfCentred('gallery', () => setShowGallery(false), slug)
            setFocusAgent(id)
          }}
          refs={galleryRefs}
          close={() => setShowGallery(false)} />
      )}
      {agentGalleryId && slug && (
        <AgentGalleryModal slug={slug} nid={agentGalleryId}
          node={tree ? flatNodes(tree).get(agentGalleryId) : undefined}
          toast={toast}
          refs={galleryRefs}
          onFocusAgent={(id) => {
            closeIfCentred('agent-gallery', () => setAgentGalleryId(null), slug)
            setFocusAgent(id)
          }}
          close={() => setAgentGalleryId(null)} />
      )}
      {showDocket && slug && tree && (
        <DocketModal slug={slug} toast={toast} tree={tree}
          jumpTo={docketJump?.id ?? null} jumpSeq={docketJump?.seq}
          onJumpHandled={() => setDocketJump(null)}
          onFocusAgent={(id) => {
            closeIfCentred('docket', () => setShowDocket(false), slug)
            setFocusAgent(id)
          }}
          onOpenMail={(r) => {
            // the mailbox opens BEHIND where the docket is, so the docket
            // closes with it — the same move the agent link above makes, for
            // the same reason: leaving it up would cover what the user just
            // asked to read. A PINNED docket covers nothing, so it stays put.
            closeIfCentred('docket', () => {
              setShowDocket(false)
              setDocketJump(null)
            }, slug)
            setMailJump({ ...mailRefTarget(r), seq: jumpTo(r.id).seq })
          }}
          close={() => { setDocketJump(null); setShowDocket(false) }} />
      )}
      {showAccounts && (
        <AccountsPanel toast={toast} close={() => setShowAccounts(false)} />
      )}
      {doomedOrg && (
        <ConfirmModal title={`permanently delete ${doomedOrg.name}?`}
          body={`Erases the organization and its ${doomedOrg.nodes} node(s) — ledger, mail, lineage, audiences.${
            doomedOrg.kiosk_cfg || doomedOrg.kiosk
              ? ' The public kiosk link dies with it, and its sandbox container is removed.'
              : ''} Workspace and scratch folders remain on disk. This cannot be undone.`}
          confirmLabel="delete organization"
          onConfirm={() => deleteOrg(doomedOrg.slug)
            .then(() => { if (slug === doomedOrg.slug) setSlug(null); refreshOrgs() })
            .catch((e: Error) => toast([`error: ${e.message}`]))}
          close={() => setDoomedOrg(null)} />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast" onClick={() =>
            setToasts((x) => x.filter((y) => y.id !== t.id))}>
            {t.lines.map((l, i) => <div key={i}>{l}</div>)}
            {t.undo && (
              <button className="toast-undo" onClick={(e) => {
                e.stopPropagation()
                setToasts((x) => x.filter((y) => y.id !== t.id))
                ;(typeof t.undo === 'function' ? t.undo : t.undo!.fn)()
              }}>{typeof t.undo === 'function' ? 'undo' : t.undo.label}</button>
            )}
          </div>
        ))}
      </div>
      <WindowMirrors>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast" onClick={() =>
            setToasts((x) => x.filter((y) => y.id !== t.id))}>
            {t.lines.map((l, i) => <div key={i}>{l}</div>)}
            {t.undo && (
              <button className="toast-undo" onClick={(e) => {
                e.stopPropagation()
                setToasts((x) => x.filter((y) => y.id !== t.id))
                ;(typeof t.undo === 'function' ? t.undo : t.undo!.fn)()
              }}>{typeof t.undo === 'function' ? 'undo' : t.undo.label}</button>
            )}
          </div>
        ))}
      </div>
      </WindowMirrors>
      {/* the in-app folder picker: LAST so it stacks above every modal */}
      <FolderPickerHost />
    </div></CurrentOrg.Provider>
  )
}

/** F-07 (user ruling 2026-08-04: "both, one modal"): the ONE advanced-org
 *  modal shell. The create form's advanced disclosure and the ⚙ settings
 *  panel both open this same surface; each pours in its own sections, and
 *  creation-only facts (kiosk, sandbox, disk type) render as LOCKED chips
 *  outside creation — visible, never editable, so the modal can't offer to
 *  change what cannot change after birth. No save button of its own: the
 *  create form submits, and the settings panel keeps its ONE bottom save
 *  (three save surfaces was a user-reported failure once already). */
export function AdvancedOrgModal({ title, close, children, tabs }: {
  title: string
  close: () => void
  children?: ReactNode
  /** tabbed form (user amendment 2026-08-05): categories as a tab strip —
   *  presentation only; both callers keep their own save flow */
  tabs?: { label: string; content: ReactNode }[]
}) {
  const [tab, setTab] = useState(0)
  return (
    <PinFrame kind="advanced-org" title={`${title} advanced`} panel="settings" close={close} pinnable={false}>
      <h3><SettingsIcon fontSize="inherit" /> {title} — advanced</h3>
        {tabs && (
          <div className="adv-tabs">
            {tabs.map((t, i) => (
              <button key={t.label} type="button"
                className={'adv-tab' + (i === tab ? ' on' : '')}
                onClick={() => setTab(i)}>{t.label}</button>
            ))}
          </div>
        )}
        {tabs ? tabs[Math.min(tab, tabs.length - 1)]?.content : children}
        <div className="row">
          <button className="primary" type="button" onClick={close}>done</button>
        </div>
    </PinFrame>
  )
}

/** the header usage modal: the host subscription's rate-limit bars — the
 *  same session / weekly / weekly-scoped readout Claude Code shows under
 *  /usage (user feature 2026-08-18). The backend proxies the account usage
 *  endpoint with the host OAuth token and caches ~30 s; this panel rides
 *  usePolled, so it is fresh on open and stays live while it sits there.
 *  Bars render generically from the `limits` array rather than three
 *  hardcoded rows: when the account gains or loses a scoped limit (a new
 *  model bucket), it shows up here with no code change. */
const USAGE_LABEL: Record<string, string> = {
  session: 'session (5hr)',
  weekly_all: 'weekly (7 day)',
}

const usageLabel = (l: UsageLimit): string =>
  l.label || (l.kind === 'weekly_scoped' && l.model ? `weekly ${l.model}`
    : USAGE_LABEL[l.kind] ?? l.kind.replace(/_/g, ' '))

const usageResets = (iso: string | null): string => {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'resets soon'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h >= 48) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`
}

/** the ONE severity rule, shared by the modal's bars and the header button's
 *  glow. Severity comes straight from upstream when it speaks; the percent
 *  thresholds are the fallback so an older shape still colors. Shared because
 *  two readers of one standing that disagreed about what "near the wall"
 *  means would be a bug you could only see by opening the modal to check the
 *  button against it. */
export const usageSeverity = (l: UsageLimit): '' | 'warn' | 'crit' => {
  const pct = Math.max(0, Math.min(100, l.percent ?? 0))
  return l.severity === 'critical' || pct >= 90 ? 'crit'
    : (l.severity && l.severity !== 'normal') || pct >= 75 ? 'warn' : ''
}

/** the worst lane in a peek, or null when nothing warrants a glow (user
 *  feature 2026-08-19). The button wears the PEAK because a wall is a wall:
 *  whichever lane arrives first is the one that freezes an agent, and the
 *  breakdown is one click away. Ties break on percent so the tooltip names
 *  the lane actually closest to it. */
export const usagePeak = (...readouts: (UsagePeek | null)[]):
{ sev: 'warn' | 'crit'; title: string } | null => {
  let best: { sev: 'warn' | 'crit'; l: UsageLimit; provider: string } | null = null
  for (const u of readouts) {
    if (!u?.available) continue
    for (const l of u.limits ?? []) {
      const sev = usageSeverity(l)
      if (!sev) continue
      if (!best || (sev === 'crit' && best.sev === 'warn')
        || (sev === best.sev && (l.percent ?? 0) > (best.l.percent ?? 0))) {
        best = { sev, l, provider: u.provider ?? 'Claude' }
      }
    }
  }
  if (!best) return null
  const r = usageResets(best.l.resets_at)
  const source = best.provider === 'Claude'
    ? 'Claude subscription usage' : `${best.provider} usage`
  return {
    sev: best.sev,
    title: `${usageLabel(best.l)} at ${Math.round(best.l.percent ?? 0)}%`
      + (r ? ` · ${r}` : '') + ` — ${source}`,
  }
}

/** a kiosk visitor has no usage button and no claim on the host account's
 *  standing: the poll is not merely hidden, it is never issued. One frozen
 *  object, not a fresh literal per tick — `usePolled` stores what it is
 *  handed, and a new object every 60 s would re-render the whole app to say
 *  the same nothing. */
const NO_PEEK: UsagePeek = Object.freeze({ available: false })
const noUsagePeek = (): Promise<UsagePeek> => Promise.resolve(NO_PEEK)
// D-202: same shape for /api/providers — a kiosk gateway does not serve it,
// so don't poll a 404 every minute. An EMPTY provider list, not a rejection:
// `presenceOfPayload` reads that as all-present, which is the right answer
// for a kiosk (it hires from the host's own harnesses, and the surfaces this
// gates are admin-only and unrendered there anyway).
const noProviders = (): Promise<ProvidersPayload> =>
  Promise.resolve({ providers: [] })

/** 1_234_567 -> "1.2M". Token counts here run to hundreds of millions and the
 *  reader wants the ORDER of the number, not its digits. */
const fmtTokens = (n: number): string =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k'
  : String(n)

/** What the Antigravity lane's recorded intervals support.
 *
 *  ⚠ NEVER A BAR AND NEVER A PERCENTAGE — a percentage implies a denominator,
 *  and the account ceiling is published nowhere orgtree can read. So: a token
 *  count, and the qualifications that must travel with it. It is an inference
 *  from walls actually hit, not a reported limit; it is a LOWER bound, since
 *  the same account is spendable in the Antigravity IDE where orgtree sees
 *  nothing; it is ONE interval whose comparability to any other is unknown;
 *  and when `limit_continuity` is unknown, one limit is not even established
 *  to span the interval itself.
 *
 *  ⚠ ONE OBSERVATION, WHICH MUST NOT READ AS SEVERAL AGREEING. Other recorded
 *  intervals are a count, never a range.
 *
 *  With no measurable interval it prints the REASON and no number: a section
 *  that quietly rendered nothing would look identical to a missing one. */
export function AntigravityEstimateNote(
  { est }: { est?: AgyEstimate | null },
) {
  if (!est) return null
  if (!est.available) {
    return (
      <div className="agy-est dim" data-testid="agy-estimate">
        no usage estimate yet{est.reason ? ` — ${est.reason}` : ''}
      </div>
    )
  }
  const e = est.estimate
  if (!e) return null
  const cov = est.coverage ?? {}
  const unsummable = cov.unsummable_receipts ?? 0
  const others = est.other_intervals?.reset_to_wall ?? 0
  return (
    <div className="agy-est" data-testid="agy-estimate"
         title={[est.basis, est.warning, est.comparability_note,
                 est.limit_continuity_note,
                 unsummable ? cov.unsummable_note : '']
           .filter(Boolean).join('\n\n')}>
      <span className="agy-est-n">~{fmtTokens(e.tokens)} tokens</span>
      <span className="dim"> spent between an observed {est.limit ?? 'quota'}
        {' '}reset and the wall that followed it{' · '}{est.confidence}</span>
      <div className="dim agy-est-why">
        inferred from walls orgtree hit, not a reported limit — a LOWER bound,
        so any budget left reads high; comparability to any other interval is
        UNKNOWN, so this is not corroborated
        {est.limit_continuity === 'unknown'
          && '; and one limit is not even known to span this interval'}
        {others > 0 && `; ${others} other recorded interval`
          + `${others === 1 ? ' is' : 's are'} counted but never combined `
          + `with it`}
        {unsummable > 0 && `; ${unsummable} older receipt`
          + `${unsummable === 1 ? '' : 's'} could not be counted`}
        {(cov.windows_with_unobserved_gaps ?? 0) > 0
          && `; ${cov.windows_with_unobserved_gaps} interval(s) span a period `
            + `orgtree was not running`}
      </div>
    </div>
  )
}

type UsageReadout = UsagePayload | AccountUsage
const readoutObservedAt = (readout: UsageReadout): number => {
  const raw = readout.observed_at
  const parsed = typeof raw === 'string' ? Date.parse(raw) : Number.NaN
  return Number.isFinite(parsed) ? parsed : Date.now()
}
type UsageReadoutState = {
  value: UsageReadout | null
  pending: boolean
  failure: string | null
  updatedAt: number | null
  refresh: (force?: boolean) => Promise<void>
}

/** One provider's live readout. The modal has four independent upstream
 * routes; keeping the in-flight latch here means a manual refresh cannot
 * start a second request while the initial poll or the interval is pending. */
function useUsageReadout<T extends UsageReadout>(fetcher: (force?: boolean) => Promise<T>): {
  value: T | null
  pending: boolean
  failure: string | null
  updatedAt: number | null
  refresh: (force?: boolean) => Promise<void>
} {
  const [value, setValue] = useState<T | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const fetchRef = useRef(fetcher)
  fetchRef.current = fetcher
  const inFlight = useRef<Promise<void> | null>(null)
  const refresh = useCallback((force = false): Promise<void> => {
    if (inFlight.current) return inFlight.current
    setPending(true)
    setFailure(null)
    const request = Promise.resolve().then(() => fetchRef.current(force)).then((next) => {
      setValue(next)
      setUpdatedAt(readoutObservedAt(next))
    }).catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      inFlight.current = null
      setPending(false)
    })
    inFlight.current = request
    return request
  }, [])
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 60000)
    return () => window.clearInterval(timer)
  }, [refresh])
  return { value, pending, failure, updatedAt, refresh }
}

function UsageRefresh({ provider, state }: { provider: string; state: UsageReadoutState }) {
  return <div className="usage-refresh">
    <button type="button" className="usage-refresh-button" aria-busy={state.pending}
      aria-label={`refresh ${provider} usage`}
      title={state.pending ? `refreshing ${provider} usage` : `refresh ${provider} usage`}
      onClick={() => { void state.refresh(true) }}>
      <AutorenewIcon fontSize="inherit" className={state.pending ? 'cc-spin' : undefined} />
    </button>
    {state.updatedAt !== null && <span className="usage-updated" aria-live="polite">
      updated {fmtClock(state.updatedAt)}
    </span>}
    {state.failure && <span className="usage-refresh-error" role="alert">
      refresh failed: {state.failure}
    </span>}
  </div>
}

/** provider display names for registry rows, whose `provider` field is the
 *  backend's lowercase id — same wording the host lanes above use */
const REGISTRY_PROVIDER_NAME: Record<string, string> = {
  claude: 'Claude', openai: 'Codex', google: 'Antigravity',
}

/** one REGISTERED account's own section of the usage modal (user report
 *  2026-09-10: alpha.10's modal showed only the host lanes, so a secondary
 *  signed-in account's usage was visible in App settings but absent here).
 *  Same conventions as the provider lanes: an auto-polled readout through
 *  useUsageReadout, the shared UsageBars markup, a gated manual refresh —
 *  plus the row's own label and identity so accounts never blur together.
 *  Each section is one account's independent read; nothing is summed
 *  across accounts. */
function RegisteredAccountSection({ row }: { row: AccountRegistryRow }) {
  const state = useUsageReadout(
    (force) => getRegisteredAccountUsage(row.id, force))
  const u = state.value
  const provider = REGISTRY_PROVIDER_NAME[row.provider] ?? row.provider
  const name = row.label || row.id
  return <div className="usage-acct" data-account={row.id}>
    <div className="usage-acct-head">
      <span><span className="acct-label">{provider}</span>
        <span className="dim"> · {name}</span>
        {row.identity?.email && <span className="dim"> · {row.identity.email}</span>}
      </span>
      <UsageRefresh provider={name} state={state} />
    </div>
    {u
      ? <><UsageBars u={{ ...u, provider }} />
        <StandingMarks standing={u.standing} /></>
      : <div className="dim">usage unavailable until refresh succeeds</div>}
  </div>
}

export function UsageModal({ close, toast }: { close: () => void; toast: ToastFn }) {
  // ⚠ EVERY registered account, primary first then fallbacks in priority
  // order (user ruling 2026-08-25) — one section of bars per account. The
  // bar markup itself lives in UsageBars (canvas/accounts.tsx) so this modal
  // and the panel's per-row buttons cannot drift apart.
  const claude = useUsageReadout(getUsage)
  const codex = useUsageReadout(getCodexUsage)
  // Antigravity: the last wall a turn hit and its parsed reset (the CLI
  // publishes no readout — see antigravity_limits); with no wall on record
  // the section carries the settled `unsupported` note, not an error
  const agy = useUsageReadout(getAntigravityUsage)
  // OpenRouter: a prepaid credit balance read off the stored key, not a
  // subscription lane — see openrouter_limits's module docstring. `fetch`
  // answers `{available:false, error:"no API key…"}` rather than nothing
  // when no key is stored, same shape as the other providers' "not
  // installed" case, so it degrades through the same `shown.openrouter &&`
  // gate below rather than a bespoke branch.
  const orr = useUsageReadout(getOpenRouterUsage)
  // D-202. ⚠ `codex` IS TRUTHY ON A MACHINE WITH NO CODEX — measured, not
  // assumed: codex_limits.fetch returns {available:false, error:"Codex CLI is
  // not installed"} rather than nothing, so the bare `codex &&` gate below
  // rendered a "Codex" heading over that error. It was the app's clearest
  // remaining "you could have Codex" advertisement, and on a Codex-less
  // machine the whole block is now absent instead.
  const shown = presenceOfPayload(usePolled(getProviders, [], 60000))
  // every REGISTERED account beyond the host lanes (user report 2026-09-10:
  // the modal omitted a signed-in secondary account entirely). The registry
  // list is the source; `ambient` rows are exactly the accounts the provider
  // lanes above already show, so filtering them out renders each account
  // once. A list that cannot be read SAYS so below rather than silently
  // omitting accounts — silence here was the original defect.
  const [registry, setRegistry] = useState<AccountRegistryRow[] | null>(null)
  const [registryError, setRegistryError] = useState('')
  useEffect(() => {
    let live = true
    const load = () => getAccountRegistry().then((r) => {
      if (!live) return
      if (Array.isArray(r?.accounts)) { setRegistry(r.accounts); setRegistryError('') }
      else setRegistryError('the backend answered without an account list (older backend?)')
    }).catch((e: Error) => { if (live) setRegistryError(e.message) })
    load()
    const timer = window.setInterval(load, 60000)
    return () => { live = false; window.clearInterval(timer) }
  }, [])
  const registered = (registry ?? []).filter((r) => !r.ambient)
  return (
    <PinFrame kind="usage" title="usage limits" panel="settings usage-modal"
      close={close}>
        <h3><DataUsageIcon fontSize="inherit" /> usage limits</h3>
        {/* the codex half only counts toward "still loading" while it is a
            half this machine has — otherwise a Codex-less box would skip the
            spinner and show a blank modal until the Claude bars land */}
        {!claude.value && !claude.failure && !claude.pending
          && !(shown.openai && (codex.value || codex.failure || codex.pending))
          && !(shown.google && (agy.value || agy.failure || agy.pending))
          && !(shown.openrouter && (orr.value || orr.failure || orr.pending))
          ? <div className="dim">loading…</div>
          : <div className="usage-cards">
          {shown.claude && (claude.value || claude.failure || claude.pending) && <div className="usage-acct">
            <div className="usage-acct-head">
              <span>Claude Code{claude.value?.email && <span className="dim"> · {claude.value.email}</span>}</span>
              <UsageRefresh provider="Claude" state={claude} /></div>
            {/* D-231 expansion: the PRIMARY sign-in entry point is here, not
                only in App settings — shown exactly when the usage fetch
                came back a real, structured credential rejection (never
                string-matched from `error`). */}
            {claude.value?.reauth_required && <ProviderSignIn provider="claude"
              connected toast={toast} onRefresh={() => { void claude.refresh(true) }} />}
            {claude.value
              ? <UsageBars u={{ ...claude.value, account: 'claude', label: 'Claude Code' }} />
              : <div className="dim">usage unavailable until refresh succeeds</div>}
          </div>}
          {shown.openai && (codex.value || codex.failure || codex.pending) && <div className="usage-acct" key={codex.value?.account ?? 'codex'}>
            <div className="usage-acct-head">
              <span><span className="acct-label">{codex.value?.provider ?? 'Codex'}</span>
                {codex.value?.label && <span className="dim"> · {codex.value.label}</span>}</span>
              <UsageRefresh provider="Codex" state={codex} />
            </div>
            {codex.value?.reauth_required && <ProviderSignIn provider="codex"
              connected toast={toast} onRefresh={() => { void codex.refresh(true) }} />}
            {codex.value
              ? <UsageBars u={codex.value} />
              : <div className="dim">usage unavailable until refresh succeeds</div>}
          </div>}
          {shown.google && (agy.value || agy.failure || agy.pending) && <div className="usage-acct" key={agy.value?.account ?? 'antigravity'}>
            <div className="usage-acct-head">
              <span><span className="acct-label">{agy.value?.provider ?? 'Antigravity'}</span>
                {agy.value?.label && <span className="dim"> · {agy.value.label}</span>}</span>
              <UsageRefresh provider="Antigravity" state={agy} />
            </div>
            {/* user-approved UX (2026-09-09): Antigravity's sign-in opens a
                visible terminal running the CLI's own interactive entry
                point rather than the browser/in-app-code flow Claude and
                Codex use above — see providerlogin.ts's
                launchAntigravityTerminal docstring. */}
            {agy.value?.reauth_required && <ProviderSignIn provider="antigravity"
              connected toast={toast} onRefresh={() => { void agy.refresh(true) }} />}
            {agy.value
              ? <><UsageBars u={agy.value} />
                <AntigravityEstimateNote est={agy.value.usage_estimate} /></>
              : <div className="dim">usage unavailable until refresh succeeds</div>}
          </div>}
          {shown.openrouter && (orr.value || orr.failure || orr.pending) && <div className="usage-acct" key={orr.value?.account ?? 'openrouter'}>
            <div className="usage-acct-head">
              <span><span className="acct-label">{orr.value?.provider ?? 'OpenRouter'}</span>
                {orr.value?.label && <span className="dim"> · {orr.value.label}</span>}</span>
              <UsageRefresh provider="OpenRouter" state={orr} />
            </div>
            {orr.value
              ? <UsageBars u={orr.value} />
              : <div className="dim">usage unavailable until refresh succeeds</div>}
          </div>}
          {registered.map((r) => <RegisteredAccountSection key={r.id} row={r} />)}
          {registryError && !registry && <div className="dim">
            registered accounts unavailable: {registryError}</div>}
          </div>}
    </PinFrame>
  )
}

export function NewOrg({ onCreate }: {
  onCreate: (name: string, dirs: string[], netAuto: boolean, netHubs: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [name, setName] = useState('')
  const [dirs, setDirs] = useState<string[]>([])
  // F-06: local-hub auto-connect defaults ON (ruled); detection is a HINT
  // beside the box, never a gate — a hub that is down still gets configured
  const [netAuto, setNetAuto] = useState(true)
  const [netHubs, setNetHubs] = useState<string[]>([])
  const [hubSeen, setHubSeen] = useState<{ ok: boolean; name?: string | null } | null>(null)
  useEffect(() => {
    if (advanced && hubSeen == null) {
      probeHub().then(setHubSeen).catch(() => setHubSeen({ ok: false }))
    }
  }, [advanced, hubSeen])
  const reset = () => {
    setOpen(false); setAdvanced(false); setName(''); setDirs([])
    setNetAuto(true); setNetHubs([])
  }
  if (!open) return <button className="primary" onClick={() => setOpen(true)}>+ new organization</button>
  return (
    <form className="stack" onSubmit={(e) => {
      e.preventDefault()
      onCreate(name, dirs.map((s) => s.trim()).filter(Boolean),
        netAuto, netHubs.map((s) => s.trim()).filter(Boolean))
      reset()
    }}>
      <input autoFocus placeholder="organization name" value={name}
        onChange={(e) => setName(e.target.value)} required />
      {/* F-07: the disclosure now OPENS the shared advanced modal instead of
          unfolding inline — same summary line (the at-a-glance state the form
          must not lose), one modal shape shared with the ⚙ settings panel */}
      <button type="button" className="disclosure" aria-expanded={advanced}
        onClick={() => setAdvanced(true)}>
        <ChevronRightIcon fontSize="inherit" /> advanced…
        {(dirs.length > 0 || netAuto || netHubs.length > 0) && (
          <span className="dim adv-sum"> · {[
            dirs.length ? `${dirs.length} folder${dirs.length > 1 ? 's' : ''}` : '',
            netAuto || netHubs.length ? 'hub' : '',
          ].filter(Boolean).join(' · ')}</span>)}
      </button>
      {advanced && (
        <AdvancedOrgModal title={name.trim() || 'new organization'}
          close={() => setAdvanced(false)}
          tabs={[
            { label: 'general', content: (
              <>
                <div className="field-label">also grant existing folders</div>
                <DirList dirs={dirs} onChange={setDirs} />
              </>
            ) },
            { label: 'mailserver', content: (
              <>
                <label className="row kiosk-sbx"
                  title="being listed means peers can mail this org (and thereby spend its credits) — refusable here, at creation">
                  <input type="checkbox" checked={netAuto}
                    onChange={(e) => setNetAuto(e.target.checked)} />
                  connect to the mailserver on this computer
                </label>
                {<div className="dim hub-hint">
                  {hubSeen == null ? 'checking for a local hub…'
                    : hubSeen.ok
                      ? `detected: ${hubSeen.name || 'unnamed hub'}`
                      : 'not running right now — the org will connect when it starts'}
                </div>}
                {(
                  <>
                    <div className="field-label adv-sep">remote mailservers</div>
                    {netHubs.map((h, i) => (
                      <div className="row" key={i}>
                        <input style={{ flex: 1 }} placeholder="http://host:7370"
                          value={h} onChange={(e) => setNetHubs(
                            (l) => l.map((x, j) => (j === i ? e.target.value : x)))} />
                        <button type="button" onClick={() => setNetHubs(
                          (l) => l.filter((_, j) => j !== i))}>
                          <CloseIcon fontSize="inherit" /></button>
                      </div>
                    ))}
                    <button type="button" onClick={() => setNetHubs((l) => [...l, ''])}>
                      + add a remote mailserver address</button>
                    <div className="dim hub-hint">names are discovered on
                      connect — only the address is typed</div>
                  </>
                )}
              </>
            ) },
          ]} />
      )}
      <div className="row">
        <button type="submit" className="primary">create</button>
        <button type="button" onClick={reset}>cancel</button>
      </div>
    </form>
  )

}

/** §9.5/§9.6: per-org API key + headless mode. Saves IMMEDIATELY (the
 *  couplings are server-enforced 422s — instant feedback beats a buffered
 *  save that fails later). */
function AutonomyTab({ tree, toast, keyDraft, setKeyDraft }: {
  tree: TreePayload
  toast: ToastFn
  keyDraft: string
  setKeyDraft: (value: string) => void
}) {
  const save = (opts: Parameters<typeof saveSettings>[1], note: string) =>
    saveSettings(tree.slug, opts)
      .then((r) => toast(r.warnings?.length ? r.warnings : [note]))
      .catch((e: Error) => toast([`error: ${e.message}`]))
  return (
    <>
      <div className="field-label">API key (§9.5 — the org's own metered
        billing)</div>
      <div className="row">
        {tree.api_key_set
          ? <>
              <span className="badge free">{'key set — turns bill the key'}</span>
              <button onClick={() => save({ clear_api_key: true },
                'API key cleared')}>clear</button>
            </>
          : <>
              <input style={{ flex: 1 }} type="password"
                placeholder="sk-ant-… (stored server-side, never shown again)"
                value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} />
              <button disabled={!keyDraft.trim()}
                onClick={() => { save({ api_key: keyDraft.trim() }, 'API key set')
                  setKeyDraft('') }}>set</button>
            </>}
      </div>
      <div className="dim hub-hint">an API key removes the subscription's
        refresh-token ceiling — required for headless, useful for any
        unattended org; it never reaches an agent's context</div>
      <label className="checkline"
        title="no user is present: questions, credit requests and user audiences auto-deny; mail to you is stored with a no-reply note; requires an API key and non-halt fable policies">
        <input type="checkbox" checked={!!tree.headless}
          onChange={(e) => save({ headless: e.target.checked },
            e.target.checked ? 'headless ON — nobody is watching now'
              : 'headless off')} />
        headless — this org runs with no user present
      </label>
      {/* usage-limit freezes moved here from the header (user 2026-09-10
          header cleanup): the auto toggle keeps its exact old semantics —
          resume every frozen agent one minute after the reported reset —
          and the manual ▶ that left the chrome keeps a seat here so bulk
          resume still exists. Per-card badges still say who is frozen. */}
      <div className="field-label">Usage-limit freezes</div>
      <label className="checkline">
        <input type="checkbox" checked={!!tree.account_fallback_default}
          onChange={(e) => save({ account_fallback_default: e.target.checked },
            e.target.checked ? 'account fallback default ON' : 'account fallback default off')} />
        automatically switch accounts after a usage limit
      </label>
      <div className="hint">Default for this org; each agent can override it.
        Uses another account with capacity for the same lane and keeps that account.</div>
      <label className="checkline"
        title="auto-resume all frozen agents one minute after the reported reset time">
        <input type="checkbox" checked={!!tree.auto_resume}
          onChange={(e) => save({ auto_resume: e.target.checked },
            e.target.checked ? 'auto-resume ON' : 'auto-resume off')} />
        auto-resume frozen agents when the usage limit resets
      </label>
      {(() => {
        const frozen = resumableFrozen(tree)
        return frozen.length
          ? <div className="row" style={{ alignItems: 'center' }}>
              <button title={frozen.map((n) => n.id).join(', ')}
                onClick={() => resumeFrozen(tree.slug)
                  .then((r) => toast([`resumed ${r.resumed.length} agent(s)`]))
                  .catch((e: Error) => toast([`error: ${e.message}`]))}>
                <PlayIcon fontSize="inherit" /> resume {frozen.length} frozen agent{frozen.length === 1 ? '' : 's'} now
              </button>
            </div>
          : <div className="dim hub-hint">no agents are frozen right now</div>
      })()}
      {tree.headless && <div className="dim hub-hint">the overseer renders
        grey with an empty eye while headless is on</div>}
      <div className="dim" style={{ fontSize: '11.5px' }}>
        autonomy changes apply immediately
      </div>
    </>
  )
}

function flatNodes(tree: TreePayload): Map<string, TreeNode> {
  const map = new Map<string, TreeNode>()
  const walk = (n: TreeNode) => { map.set(n.id, n); n.children.forEach(walk) }
  ;(tree.roots ?? []).forEach(walk)   // total: settings fixtures pass partial trees
  return map
}

/** The nodes ▶ resume will ACTUALLY act on — the banner's count, its title
 *  list and its wording all read from this and nothing else.
 *
 *  user report 2026-08-26: the banner read "resume 2 · 2 agents frozen" in an
 *  org whose two frozen agents had since been RETIRED. Retiring does not clear
 *  the freeze record — deliberately, since a retired agent keeps its context
 *  and can be rehired — so the old test (`n.frozen != null` alone) counted
 *  nodes ▶ has never been willing to touch. Nothing behind the banner was
 *  broken: the backend already refused them and ▶ resumed nobody.
 *
 *  ⚠ THE RULE IS NOT HERE, AND MUST NOT COME BACK HERE. `node.resumable` is
 *  composed by the backend from `supervisor.resumable`, which is the single
 *  expression of it. The first fix re-derived the rule in this file and held
 *  the two copies together with a test that read `supervisor.py` as text —
 *  and a source-text check cannot tell a rule that got STRONGER from one that
 *  got weaker, fires on a harmless rename, and misses a semantic change that
 *  keeps the same spelling. If you find yourself adding a condition below,
 *  the condition belongs in `_resumable` instead.
 *
 *  The `frozen != null` test is a TYPE NARROWING, not a second copy of the
 *  rule: `resumable` is only ever true for a node carrying a record, and the
 *  banner dereferences `.frozen.until` — this is how TypeScript is told. */
export function resumableFrozen(
  tree: TreePayload,
): (TreeNode & { frozen: TreeFrozen })[] {
  return [...flatNodes(tree).values()].filter(
    (n): n is TreeNode & { frozen: TreeFrozen } =>
      n.resumable && n.frozen != null)
}

export function SenderChip({ id, nodes, onFocusAgent }: {
  id: string
  nodes: Map<string, TreeNode>
  onFocusAgent?: (agentId: string) => void
}) {
  if (id === SYSTEM || id === 'system') return <b className="dim">system</b>
  if (id === USER) return <b>you</b>
  const n = nodes.get(id)
  // ⚠ ONLY AN ESTABLISHED LOCAL NODE NAVIGATES: a name this tree does not hold
  // stays readable and loses a route that was never there.
  if (!n) return <b>{id}</b>
  const chip = (
    <span className={'sender ' + (n?.state ?? '')} title={n ? `${tierLabel(n.tier)} · ${n.state}` : id}>
      {n && <span className={'tier t-' + n.tier}>{TIER_LETTER[n.tier] ?? '?'}</span>}
      <b>{id}</b>
    </span>
  )
  if (onFocusAgent) {
    return (
      /* ⚠ stopPropagation is load-bearing since this chip moved into the mail
         LIST ROW as well as the reading pane: the row's own onClick toggles
         selection, so without it clicking a sender's name would jump AND
         select (or, on the open mail, deselect the thing you were reading).
         `AgentName` stops it for the same reason; the two must not drift.
         type="button" for the same reason `AgentName` carries one — this is
         rendered inside forms, where the default submit would be wrong. */
      <button type="button" className="cc-name cc-name-jump" title={`focus ${id}'s desk`}
        onClick={(e) => { e.stopPropagation(); onFocusAgent(id) }}>
        {chip}
      </button>
    )
  }
  return chip
}


// audience requests parked at the user (fields the inbox reads) —
// AudienceRequest is an open dict in types.ts
interface UserAudReq {
  from: string
  reason?: string
  [k: string]: unknown
}

/** The world a SHELL PANEL judges canonical references against.
 *
 *  Two panels render prose that can carry a reference — the user's inbox and
 *  the document gallery — and they must answer the same way. The decision
 *  itself lives in `useRefRoutes` (reflinks.tsx), which the desk builds its
 *  world with too; all this adds is the shell's agent source, since the shell
 *  holds a TREE where the canvas holds a flattened map. Written per surface
 *  they would drift, and the drift would be invisible: one panel quietly
 *  calling a real item missing looks exactly like a real missing item.
 *
 *  ⚠ `null` UNTIL THE TREE ARRIVES, which reads as `loading` and not as
 *  `absent`: an empty tree would call every agent and every mailbox imaginary
 *  for as long as the first fetch takes. */
function useShellRefs(slug: string, tree: TreePayload | null, routes: {
  onOpenItem?: (itemSlug: string) => void
  onFocusAgent?: (agentId: string) => void
  onOpenDoc?: (docId: string) => void
  onOpenMail?: (ref: TypedRef) => void
}) {
  const nodes = useMemo(() => (tree ? flatNodes(tree) : null), [tree])
  // a shell panel is not AT an agent either — it can only say what each
  // one is running
  const tierOf = useCallback(
    (id: string) => nodes?.get(id)?.tier, [nodes])
  return useRefRoutes(slug, nodes, { ...routes, tierOf })
}

export function InboxPanel({ slug, tree, toast, refresh, close, jumpTo, jumpSeq,
  onFocusAgent, onOpenItem, onOpenDoc, onOpenMail }: {
  slug: string
  tree: TreePayload
  toast: ToastFn
  refresh?: () => void
  close: () => void
  jumpTo: string | null
  /** the request's own identity, so a repeat click is a new request */
  jumpSeq?: number | null
  onFocusAgent?: (agentId: string) => void
  /** a canonical reference written in a mail BODY, followed. Each is
   *  optional and each one supplied is one more kind of token this panel
   *  admits — an omitted one renders "not opened from here", which is the
   *  true statement rather than a control that does nothing. */
  onOpenItem?: (itemSlug: string) => void
  onOpenDoc?: (docId: string) => void
  onOpenMail?: (ref: TypedRef) => void
}) {
  const [folder, setFolder] = useState('inbox')
  // ⚠ A REFERENCE MUST OPEN THE FOLDER THE MESSAGE IS IN. The user's own sends
  // are a separate folder, so a token naming one arriving with the panel on
  // `inbox` leaves the message an unmarked click away while the panel looks
  // perfectly ordinary.
  //
  // Keyed on the REQUEST, not on the box: switching whenever the data changes
  // would drag the reader out of a folder they chose by hand on every poll.
  // `box` is in the deps because the answer is not knowable until it loads.
  const foldedJump = useRef<string | null>(null)
  const nodes = flatNodes(tree)
  const mailRefs = useShellRefs(slug, tree,
    { onOpenItem, onFocusAgent, onOpenDoc, onOpenMail })
  // G5: mail arrives, and audience requests are raised by agents, while this
  // panel sits open. Polled while mounted rather than fetched once — the same
  // gate as everywhere else: "is anyone looking at this".
  //
  // ⚠ `readBump` is what makes marking-read FEEL instant (user bug 2026-08-07:
  // "takes several seconds to process"). The POST answers in ~5 ms; the delay
  // was entirely here. These rows come from getInbox, but onRead refreshed the
  // TREE — a different payload that does not carry them — so the row kept its
  // unread mark until the next 5 s poll tick: 0–5 s, ~2.5 s typical. Bumping a
  // dep restarts the effect, which ticks immediately. No optimistic local
  // state: the server answer still decides, it is just asked for now.
  const [readBump, setReadBump] = useState(0)
  // readBump rides the REFRESH key, not deps: deps changes reset the value to
  // null (identity changed — §6.10), and blanking the inbox on every
  // mark-read would regress the instant-ack this bump exists to provide
  const box = usePolled(() => getInbox(slug), [slug], 5000, readBump)
  // the exact question for a reference that landed outside this window —
  // one id, asked once, never on the poll
  const userLookup = useCallback(
    (id: string) => getMailById(slug, 'user', id).then((r) => r.mail as MailRow | null),
    [slug])
  // the panel's own question, for the folder that has no `lookup` and so is
  // not the one asking, plus the deliberate retry that goes with it
  const [jumpAsk, setJumpAsk] = useState<'asking' | 'failed' | null>(null)
  const [askAgain, setAskAgain] = useState(0)
  // ⚠ THE LIVE REQUEST, AND THE ONLY THING ALLOWED TO ANSWER. In a ref rather
  // than the effect's closure: `box` is in the deps and the poll replaces it
  // every few seconds, so an effect-scoped cancel abandons any answer slower
  // than one tick. Superseded by a NEWER REQUEST or by unmount, never by a
  // re-run of the same one.
  const askKey = useRef<string | null>(null)
  useEffect(() => () => { askKey.current = null }, [])
  useEffect(() => {
    // a retry is a new attempt at the same request: it must pass the latch
    const req = jumpKey(jumpTo, jumpSeq) + '#' + askAgain
    if (foldedJump.current === req) return
    // ⚠ THE CLAIM IS STAKED BEFORE ANYTHING IS DECIDED ABOUT THE NEW REQUEST,
    // because the branches below RETURN. A target already in a loaded list
    // needs no question of its own, and staking the claim after those returns
    // leaves the previous question live to answer over the top of it.
    askKey.current = req
    setJumpAsk(null)
    if (!jumpTo || !box) return
    foldedJump.current = req
    const here = (rows: { id?: string }[] | undefined) =>
      (rows ?? []).some((m) => m.id === jumpTo)
    if (here(box.pending) || here(box.delivered)) { setFolder('inbox'); return }
    if (here(box.sent)) { setFolder('sent'); return }
    // in NEITHER loaded list: the PANEL asks, because a list only knows the id
    // is missing from its own window. The answer's folder is decided here — a
    // `@mail:org/user/<id>` names the user's RECEIVED mail, and the Sent rows
    // are copies of mail that lives in other boxes.
    setJumpAsk('asking')
    Promise.resolve(userLookup(jumpTo))
      .then((m) => {
        if (askKey.current !== req) return
        setJumpAsk(null)
        if (m) setFolder('inbox')
      })
      .catch(() => {
        if (askKey.current !== req) return
        setJumpAsk('failed')
      })
  }, [jumpTo, jumpSeq, box, userLookup, askAgain])
  const aud = usePolled(() => getAudiences(slug), [slug])
  // №10: the record loads on demand — and keeps loading while that tab is up
  const events = usePolled(
    () => (folder === 'record' ? getEvents(slug).then((r) => r.events)
      : Promise.resolve(null)), [folder, slug])
  const userAud = aud?.audiences?.filter((a) => a.grantor === USER) ?? []
  const userReqs = (aud?.requests?.filter((r) => r.target === USER && r.currently_at === USER) ?? []) as UserAudReq[]
  const act = (action: string, node: string, target?: string | null) =>
    audienceAction(slug, action, node, target)
      .catch((e: Error) => toast([`error: ${e.message}`]))
  // an audience holder is an agent of this org, so it wears the same chip and
  // the same jump as everywhere else. `nodes.get(g)?.tier` may be undefined
  // for a holder no longer in the tree — AgentName then draws no chip, which
  // is the honest answer rather than a guessed one.
  const audBadge = (g: string, dim = false) => (
    <span key={g} className={'badge aud-badge ' + (dim ? 'dim' : 'free')}>
      <HearingIcon fontSize="inherit" />
      {/* the id alone — `AgentName` calls back with (id, event) and
          `onFocusAgent` is declared one-argument. Wrapped at its source here
          today, so nothing is corrupted; mail.tsx's defaultIdentity records
          what the bare handoff cost when the source was `centerOn`. */}
      <AgentName id={g} tier={nodes.get(g)?.tier}
        onFocus={onFocusAgent ? (id: string) => onFocusAgent(id) : undefined} />
      <button className="chip-x" title="rescind" type="button"
        onClick={() => act('revoke', g)}><CloseIcon fontSize="inherit" /></button>
    </span>
  )
  // Asks ride the inbox as their OWN mail rows (user ruling 2026-08-04),
  // interleaved chronologically with real mail — the only difference is the
  // reading pane shows the response UI as the body instead of a reply box.
  // Open asks join the unread group; resolved ones sit in the flow wearing
  // their nulled state (grey answered/denied, orange interrupted).
  const askRow = (a: AskInfo): MailRow => ({
    id: 'ask:' + a.id, from: a.node, at: a.at,
    kind: a.kind === 'batch' ? 'request batch'
      : (a.kind === 'credit' || a.old != null) ? 'credit request'
      : a.kind === 'scope' ? 'scope request' : 'question',
    body: a.kind === 'batch'
      ? `${(a.tabs ?? []).length} request(s) awaiting one submit`
      : a.kind === 'scope'
        ? 'requests scope: ' + (a.items ?? [])
          .map((it) => it.kind === 'dir' ? it.path
            : it.kind === 'permission_mode' ? `mode ${it.mode}`
            : it.tool ?? it.server ?? it.kind).join(', ')
        : a.question ?? `asks for credits: ${a.old} → ${a.new}`,
    _ask: a,
  } as MailRow)
  const askOpen = (a: AskInfo) => a.status === 'open' || a.status === 'pending'
  const asks = tree.asks ?? []
  // FR-14: an agent's OPEN requests render as its ONE composed batch card
  // (node.ask, kind 'batch') — never as separate per-kind rows. The raw
  // per-store entries keep feeding the resolved history below.
  const askPending = [...nodes.values()]
    .filter((n) => n.ask && askOpen(n.ask)).map((n) => askRow(n.ask!))
  const askDone = asks.filter((a) => !askOpen(a)).slice(-8).map(askRow)
  const renderAskBody = (m: MailRow) => {
    if (!m._ask) return null
    const n = nodes.get(m._ask.node)
    return (
      <AskCard ask={m._ask} slug={slug} toast={toast}
        seat={n?.seat ?? 0}
        committed={(n?.grant ?? 0) - (n?.free ?? 0)}
        segments={(n?.children ?? []).filter((c) => c.state === 'live')
          .map((c) => ({ seat: c.seat, grant: c.grant }))}
        pxc={orgPxc(tree)}
        maxTop={tree.max_top_grant ?? 1000} />
    )
  }
  return (
    <PinFrame kind="inbox" title="your inbox" panel="settings wide"
      close={close}>
        <h3><MailIcon fontSize="inherit" /> your inbox</h3>
        {userReqs.length > 0 && (
          <>
            <div className="field-label">audience requests</div>
            {userReqs.map((r) => (
              <div className="hist-row" key={r.from}>
                <SenderChip id={r.from} nodes={nodes} />
                <span className="dim">{r.reason}</span>
                <button className="primary" onClick={() => act('grant', r.from)}>grant</button>
                <button onClick={() => act('deny', r.from, USER)}>deny</button>
              </div>
            ))}
          </>
        )}
        {userAud.length > 0 && (
          <>
            <div className="field-label">audience holders</div>
            <div className="row aud-holders-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <AudienceFold
                ids={userAud.filter((a) => nodes.get(a.grantee)?.state === 'live')
                  .map((a) => a.grantee)}
                label="audience holders"
                render={(g) => audBadge(g)} />
              <RetiredFold
                ids={userAud.filter((a) =>
                  nodes.get(a.grantee)?.state !== 'live').map((a) => a.grantee)}
                render={(g) => audBadge(g, true)} />
            </div>
          </>
        )}
        <MailFolders folder={folder} setFolder={setFolder}
          folders={['inbox', 'sent', 'record']}
          unread={(box?.pending.length ?? 0) + askPending.length} />
        <div className="mailpane">
          {folder === 'record'
            ? <OrgRecord events={events} />
            : box == null
            ? <div className="dim">loading…</div>
            : folder === 'inbox'
              ? <MailList pending={[...box.pending, ...askPending]}
                  delivered={[...box.delivered, ...askDone]}
                  renderBody={renderAskBody}
                  // FR-21: this was the ONE MailList call site without
                  // fileHref, which is why the node inbox's attachments were
                  // downloadable and the user's were not. Keyed on the
                  // SENDER — the file sits in that agent's own outbox/.
                  fileHref={(p, m) => fileUrl(slug, m.from, p)}
                  mdBase={(m) => fileBase(slug, m.from)}
                  waitLabel="unread" selectOldestUnread jumpTo={jumpTo} jumpSeq={jumpSeq}
                  lookup={userLookup} refs={mailRefs} toast={toast}
                  /* the row's reference for the context menu: this folder IS
                     the user's box (`@mail:org/user/<id>`); an ask row is a
                     request, not a mail, and gets none */
                  refOf={(m) => m.id && !m._ask
                    ? refToken({ kind: 'mail', org: slug, box: 'user', id: m.id }) : null}
                  onRead={(m: MailEntry) => markRead(slug, [m.id])
                    .then(() => { setReadBump((n) => n + 1); refresh?.() })
                    .catch(() => {})}
                  onReply={(m: MailEntry, text: string, attachments?: string[]) => {
                    return sendLinkedReply(slug, m.from, text, { kind: 'mail', org: slug, box: 'user', id: m.id },
                      attachments)
                      .then(async (receipt) => {
                        toast([`sent to ${m.from}`, ...(receipt.warnings ?? [])])
                        // Commands have no mail receipt. Read only after a
                        // durable reply, using the captured original identity.
                        if (!receipt.id) return
                        try {
                          await markRead(slug, [m.id])
                          setReadBump((n) => n + 1)
                          refresh?.()
                        } catch {
                          // The reply already exists: do not retain its draft
                          // as though sending failed and invite a duplicate.
                          toast(['Reply sent, but could not mark the original mail read.'])
                        }
                      })
                      .catch((e: Error) => {
                        toast([`error: ${e.message}`])
                        throw e
                      })
                  }}
                  onFocusAgent={onFocusAgent ? (agentId) => { close(); onFocusAgent(agentId) } : undefined}
                  rowSender={(id: string) => <span>{id}</span>}
                  sender={(id: string) => <SenderChip id={id} nodes={nodes}
                    onFocusAgent={onFocusAgent ? (agentId) => { close(); onFocusAgent(agentId) } : undefined} />} />
              // the user's OWN sends: attachments live in the RECIPIENT's
              // uploads/ (the upload landed there at stage time) — key on
              // m.to; a row without one ('' = unreachable) keeps plain chips
              /* ⚠ NO `lookup` HERE. These rows are copies of mail that lives
                 in other boxes, so an exact answer never belongs in this
                 folder — the panel above asks and opens the one that does. It
                 hands down the OUTCOME of that question (`askState`) so this
                 list does not read an unfinished or failed one as an absence. */
              : <MailList delivered={box.sent ?? []} outgoing refs={mailRefs}
                  jumpTo={jumpTo} jumpSeq={jumpSeq}
                  askState={jumpAsk}
                  onAskRetry={() => setAskAgain((n) => n + 1)}
                  onFocusAgent={onFocusAgent ? (agentId) => { close(); onFocusAgent(agentId) } : undefined}
                  fileHref={(p, m) => typeof m.to === 'string' && m.to
                    ? fileUrl(slug, m.to, p) : ''}
                  mdBase={(m) => typeof m.to === 'string' && m.to
                    ? fileBase(slug, m.to) : ''}
                  rowSender={(id: string) => <span>{id}</span>}
                  sender={(id: string) => <SenderChip id={id} nodes={nodes}
                    onFocusAgent={onFocusAgent ? (agentId) => { close(); onFocusAgent(agentId) } : undefined} />} />}
        </div>
        <div className="row">
          {/* ⚠ the bump is not optional here. These rows come from getInbox,
              and the server's own `changed` broadcast only makes clients
              refetch the TREE — a different payload that does not carry them.
              So without this the button's effect waited for the 5 s poll: the
              per-mail path was fixed first and this sibling call site was
              missed, which is the same bug reported twice (2026-08-07/08). */}
          {folder === 'inbox' && (box?.pending.length ?? 0) > 0 && <button onClick={() =>
            clearInbox(slug)
              .then(() => { setReadBump((n) => n + 1); refresh?.() })
              .catch((e: Error) => toast([`error: ${e.message}`]))}>mark all read</button>}
          <button className="primary" onClick={close}>close</button>
        </div>
    </PinFrame>
  )
}

// Global DEFAULT org settings (user spec, root page): every newly created
// org is born with these values — the same knobs as a single org's settings
// panel, saved once in <data>/defaults.json.
export function DefaultsPanel({ toast, close }: { toast: ToastFn; close: () => void }) {
  // Partial: the error fallback seeds {} and every read has its own default
  const [d, setD] = useState<Partial<DefaultsPayload> | null>(null)
  useEffect(() => { getDefaults().then(setD).catch(() => setD({})) }, [])
  const provPayload = usePolled(getProviders, [], 60000)
  const autopsyGroups = useMemo(
    () => availableAutopsyModels(provPayload, d?.fable_filter_model ?? 'opus'),
    [provPayload, d?.fable_filter_model])
  if (d == null) {
    return (
      <PinFrame kind="defaults" title="default org settings"
        panel="settings" close={close}>
        <div className="dim pad">loading…</div>
      </PinFrame>
    )
  }
  const set = (k: string, v: unknown) => setD({ ...d, [k]: v })
  return (
    <PinFrame kind="defaults" title="default org settings"
      panel="settings" close={close}>
        <h3><SettingsIcon fontSize="inherit" /> default org settings</h3>
        {/* WHICH ORGS THIS APPLIES TO is the panel's most load-bearing
            sentence, and it used to live inside the h3 — where a pinned window
            hides it along with the duplicated heading. Outside it, visible in
            both modes (Astra 2026-09-06). */}
        <div className="dim modalpin-subtitle">applied to every NEW
          organization</div>
        <div className="field-label">top-level grant cap</div>
        <input type="number" min="1" step="1" style={{ width: '8em' }}
          value={d.max_top_grant ?? 1000}
          onChange={(e) => set('max_top_grant', +e.target.value)} />
        <div className="field-label">default top-level grant (pre-filled on new hires)</div>
        <input type="number" min="0" step="1" style={{ width: '8em' }}
          value={d.default_top_grant ?? 50}
          onChange={(e) => set('default_top_grant', +e.target.value)} />
        <div className="field-label">compaction threshold % (50–95)</div>
        <input type="number" min="50" max="95" step="1" style={{ width: '8em' }}
          value={Math.round((d.compact_at ?? 0.8) * 100)}
          onChange={(e) => set('compact_at', (+e.target.value || 80) / 100)} />
        <div className="field-label">default thinking effort (agents without
          their own setting inherit this, live)</div>
        <select value={d.default_effort ?? ''}
          onChange={(e) => set('default_effort', e.target.value)}>
          <option value="">CLI default (no flag)</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
          <option value="max">max</option>
        </select>
        <div className="field-label">fable weekly-limit policy</div>
        <select value={d.fable_limit_policy ?? 'halt'}
          onChange={(e) => set('fable_limit_policy', e.target.value)}>
          <option value="halt">halt (default)</option>
          <option value="opus">switch to opus</option>
          <option value="dissolve">dissolve subtree</option>
        </select>
        <div className="field-label">fable content-filter policy</div>
        <select value={d.fable_filter_policy ?? 'halt'}
          onChange={(e) => set('fable_filter_policy', e.target.value)}>
          <option value="halt">halt (default)</option>
          <option value="opus">switch to opus + retry</option>
          <option value="auto-autopsy">auto-autopsy</option>
        </select>
        {(d.fable_filter_policy ?? 'halt') === 'auto-autopsy' && (
          <>
            <div className="field-label">autopsy model (fable not selectable)</div>
            <select value={d.fable_filter_model ?? 'opus'} aria-label="autopsy model"
              onChange={(e) => set('fable_filter_model', e.target.value)}>
              {autopsyGroups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.models.map((m) => (
                    <option key={m.tier} value={m.tier}>
                      {m.label}{m.seat != null ? ` · seat ${fmtCredits(m.seat)}` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </>
        )}
        <div className="field-label">credit cost bubbling</div>
        <label className="checkline">
          <input type="checkbox" checked={d.cascade_hire !== false}
            onChange={(e) => set('cascade_hire', e.target.checked)} />
          hires bubble their cost up the chain
        </label>
        <label className="checkline">
          <input type="checkbox" checked={d.cascade_alloc !== false}
            onChange={(e) => set('cascade_alloc', e.target.checked)} />
          allocations &amp; model upgrades bubble their cost up the chain
        </label>
        <label className="checkline">
          <input type="checkbox" checked={!!d.auto_resume}
            onChange={(e) => set('auto_resume', e.target.checked)} />
          auto-resume usage-limit-frozen agents after the reset time
        </label>
        <label className="checkline">
          <input type="checkbox" checked={!!d.auto_resume_compact}
            onChange={(e) => set('auto_resume_compact', e.target.checked)} />
          cheap-compact limit-frozen agents before auto-resume wakes them
        </label>
        <div className="field-label">app-wide Luna reserve default</div>
        <label className="checkline">
          <input type="checkbox" checked={d.prefer_reserve !== false}
            onChange={(e) => set('prefer_reserve', e.target.checked)} />
          prefer reserve capacity first when no individual preference is set
        </label>
        <div className="hint">
          Other defaults apply only when creating an organization. The
          app-wide Luna reserve default also reaches existing agents that have
          no individual preference; an explicit agent preference always wins.
        </div>
        <div className="row">
          <button className="primary" onClick={() =>
            saveDefaults({
              max_top_grant: d.max_top_grant,
              default_top_grant: d.default_top_grant,
              compact_at: Math.round((d.compact_at ?? 0.8) * 100),
              fable_limit_policy: d.fable_limit_policy,
              fable_filter_policy: d.fable_filter_policy,
              fable_filter_model: d.fable_filter_policy === 'auto-autopsy'
                ? (d.fable_filter_model ?? 'opus') : undefined,
              default_effort: d.default_effort ?? '',
              cascade_hire: d.cascade_hire !== false,
              cascade_alloc: d.cascade_alloc !== false,
              auto_resume: !!d.auto_resume,
              auto_resume_compact: !!d.auto_resume_compact,
              prefer_reserve: d.prefer_reserve !== false,
            }).then(() => {
              toast(['default org settings and app-wide Luna default saved'])
              close()
            })
              .catch((e: Error) => toast([`error: ${e.message}`]))}>save</button>
          <button onClick={close}>cancel</button>
        </div>
    </PinFrame>
  )
}

/** D-222: the org settings modal's tab series. "basic" is always first; the
 *  rest are the categories that used to be inside the nested advanced modal,
 *  now siblings of it. `mailserver` and `autonomy` are conditional — see
 *  `orgTabs` in the panel. */
type OrgSettingsTab =
  'basic' | 'policies' | 'orgtype' | 'mailserver' | 'autonomy' | 'history'

// exported for tests/orgsettings.test.tsx — the consolidation is a claim
// about THIS component's shape (one modal, one save, tabs not a nested
// modal), so the test has to be able to mount it directly
export function SettingsPanel({ tree, toast, close }: {
  tree: TreePayload
  toast: ToastFn
  close: () => void
}) {
  // P3 — every field below used to be its own useState SEEDED FROM `tree`.
  // useState(x) snapshots x once at mount and never looks again, so this panel
  // held seventeen private copies of server values that could each go stale
  // silently (the mechanism behind the user's "the charter looks empty"). Now
  // there is ONE cell: the edits you have actually made. Everything else is
  // derived from the prop on every render, so a value that changes anywhere
  // else shows up here, and saving clears the buffer back to server truth.
  const [edit, setEdit] = useState<Record<string, unknown>>({})
  // takes the value THIS render derived, so an updater form still works
  const set = <T,>(k: string, cur: T) => (v: T | ((prev: T) => T)) =>
    setEdit((e) => ({ ...e,
      [k]: typeof v === 'function' ? (v as (p: T) => T)(cur) : v }))
  const val = <T,>(k: string, server: T): T =>
    (k in edit ? edit[k] as T : server)
  const clearEdits = () => setEdit({})
  const [orgMd, setOrgMd] = useState<string | null>(null)
  const [orgMdLoad, setOrgMdLoad] = useState<'pending' | 'error' | 'ready'>('pending')
  const [orgMdError, setOrgMdError] = useState<string | null>(null)
  const [orgMdRetry, setOrgMdRetry] = useState(0)
  // what the server said about org.md's length and how much of it agents
  // actually receive — the editor is the only place the operator can learn it
  const [orgMdMeta, setOrgMdMeta] = useState<OrgMdPayload | null>(null)
  // D-222 (user ruling 2026-09-01, "consolidate settings into ONE modal"):
  // the advanced disclosure and the nested AdvancedOrgModal it opened are
  // gone from this panel. Its categories are now tabs of THIS modal, with
  // "Basic" first — one surface, one Escape, one save button, and no
  // modal-over-a-modal. (AdvancedOrgModal itself stays for the create form,
  // which opens it from an inline form rather than from another modal.)
  const [tab, setTab, visited] = useVisitedTabs<OrgSettingsTab>('basic')
  // the strip is built from live org shape: a kiosk has no autonomy, an org
  // with no mail identity has no mailserver tab. Same conditionals the
  // advanced modal's tab array used — moved out here so the tab strip and
  // the panels below cannot disagree about which tabs exist.
  const orgTabs = useMemo<SettingsTab<OrgSettingsTab>[]>(() => [
    { id: 'basic', label: 'Basic' },
    { id: 'policies', label: 'Policies' },
    ...(tree.net != null
      ? [{ id: 'mailserver' as const, label: 'Connections' }] : []),
    { id: 'autonomy', label: 'Autonomy' },
    // low-priority history lives HERE, not in the chrome (user 2026-09-10)
    { id: 'history', label: 'History' },
  ], [tree.net])
  // D-204: these are unsaved inputs. The tabs now stay mounted once visited,
  // so a tab switch can no longer destroy them — but close/reopen still
  // unmounts the whole shell, and keeping the only copies here also means a
  // future field added to those tabs inherits the protection instead of
  // having to rediscover it.
  const [netHubDraft, setNetHubDraft] = useState('')
  const [apiKeyDraft, setApiKeyDraft] = useState('')

  // the shadowing pair below keeps every USE SITE unchanged: same name, same
  // setter signature — only where the value comes from has changed
  const maxTop = val<number | string>('maxTop', tree.max_top_grant ?? 1000)
  const setMaxTop = set('maxTop', maxTop)
  const defTop = val<number | string>('defTop', tree.default_top_grant ?? 50)
  const setDefTop = set('defTop', defTop)
  const compactAt = val<number | string>('compactAt',
    Math.round((tree.compact_at ?? 0.8) * 100))
  const setCompactAt = set('compactAt', compactAt)
  const fablePolicy = val('fablePolicy', tree.fable_limit_policy ?? 'halt')
  const setFablePolicy = set('fablePolicy', fablePolicy)
  const filterPolicy = val('filterPolicy', tree.fable_filter_policy ?? 'halt')
  const setFilterPolicy = set('filterPolicy', filterPolicy)
  const filterModel = val('filterModel', tree.fable_filter_model ?? 'opus')
  const setFilterModel = set('filterModel', filterModel)
  const provPayload = usePolled(getProviders, [], 60000)
  const autopsyGroups = useMemo(
    () => availableAutopsyModels(provPayload, filterModel),
    [provPayload, filterModel])
  const defEffort = val('defEffort', tree.default_effort ?? '')
  const setDefEffort = set('defEffort', defEffort)
  const cascadeHire = val('cascadeHire', tree.cascade_hire !== false)
  const setCascadeHire = set('cascadeHire', cascadeHire)
  const cascadeAlloc = val('cascadeAlloc', tree.cascade_alloc !== false)
  const setCascadeAlloc = set('cascadeAlloc', cascadeAlloc)
  // Known-cold pre-turn cheap compaction — per-node overrides
  // live in each agent's own gear panel
  const acc = tree.auto_cheap_compact ?? null
  const accOn = val('accOn', !!acc?.enabled)
  const setAccOn = set('accOn', accOn)
  const accOcc = val<number | string>('accOcc',
    Math.round(((acc?.occ ?? 0.5) as number) * 100))
  const setAccOcc = set('accOcc', accOcc)
  // pre-resume cheap compact (2026-08-17): rides the AUTO limit resume only
  const arCompact = val('arCompact', !!tree.auto_resume_compact)
  const setArCompact = set('arCompact', arCompact)
  useEffect(() => {
    // null = not loaded: the textarea is disabled and save skips the write.
    // ☠ The catch used to set '' — an empty EDITABLE buffer — so a transient
    // fetch failure plus one ordinary save wiped the org's charter with
    // putOrgMd(slug, ''). A failed READ must never arm a destructive write;
    // null also resets on org switch so the previous org's text cannot be
    // saved into the new one during the load window.
    setOrgMd(null)
    setOrgMdMeta(null)
    setOrgMdLoad('pending')
    setOrgMdError(null)
    let current = true
    getOrgMd(tree.slug).then((r) => {
      if (!current) return
      setOrgMdMeta(r)
      // ☠ Same family as the empty-write scar above: if the READ was cut, the
      // buffer is not the file. Saving it back would rewrite org.md short and
      // destroy the tail for real. Refuse to load it into an editable buffer
      // at all — null keeps the textarea disabled and skips the write.
      setOrgMd(r.read_truncated ? null : r.content)
      setOrgMdLoad('ready')
    }).catch((e: unknown) => {
      if (!current) return
      setOrgMd(null)
      setOrgMdMeta(null)
      setOrgMdError(e instanceof Error && e.message ? e.message : 'request failed')
      setOrgMdLoad('error')
    })
    return () => { current = false }
  }, [tree.slug, orgMdRetry])
  return (
    <PinFrame kind="org-settings" title={`${tree.name} - org settings`}
      panel="settings" close={close}>
        <h3><SettingsIcon fontSize="inherit" /> {tree.name} - org settings</h3>
        <SettingsTabs tabs={orgTabs} tab={tab} setTab={setTab}
          idBase="org-settings" label="Organization settings sections" />

        {/* ── Basic: the knobs an operator reaches for, in the order they
            reach for them. Everything that used to be behind "advanced…" is
            now a SIBLING TAB rather than a second modal. */}
        <SettingsTabPanel id="basic" idBase="org-settings"
          active={tab === 'basic'}>
        {/* folder access lives on the eye's ⚙ gear panel (user ruling) */}
        <SetGroup title="Credits">
          <SetRow label="top-level grant cap"
            hint="the largest grant any top-level agent may hold">
            <input type="number" min="1" step="1" value={maxTop}
              aria-label="top-level grant cap"
              onChange={(e) => setMaxTop(e.target.value)} />
          </SetRow>
          <SetRow label="default top-level grant"
            hint="pre-filled on new hires">
            <input type="number" min="0" step="1" value={defTop}
              aria-label="default top-level grant"
              onChange={(e) => setDefTop(e.target.value)} />
          </SetRow>
        </SetGroup>
        <SetGroup title="Agent defaults">
          <SetRow label="compaction threshold"
            hint="50–95%. Splits the agent when its context passes this.">
            <input type="number" min="50" max="95" step="1" value={compactAt}
              aria-label="compaction threshold percent"
              onChange={(e) => setCompactAt(e.target.value)} />
            <span className="dim">%</span>
          </SetRow>
          {/* default effort (user req 2026-08-01, visible inherit): agents
              without their own effort follow this LIVE — changing it here
              reaches every unset agent's next turn, no rehire */}
          <SetRow label="default thinking effort"
            hint={'agents without their own setting inherit this, live — '
              + 'no rehire needed. Changing it restarts every agent that '
              + 'inherits it.'}>
            <select value={defEffort} aria-label="default thinking effort"
              onChange={(e) => setDefEffort(e.target.value)}>
              <option value="">CLI default (no flag)</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
              <option value="max">max</option>
            </select>
          </SetRow>
        </SetGroup>
        <SetGroup title="Org charter" note="org.md">
          <SetBlock hint={"carried in the managed system prompt of EVERY "
            + "agent in this org, on every provider — Claude, Codex and "
            + "Antigravity alike — and read as a standing directive from "
            + "you. It is delivered at session start, so saving restarts "
            + "every agent here. Keep it short: it sits in each agent's "
            + "cached prefix on every lane."}>
            {orgMdLoad === 'pending' && (
              <div className="orgmd-status" role="status" aria-live="polite">
                Loading org.md...
              </div>
            )}
            {orgMdLoad === 'error' && (
              <div className="orgmd-status" role="alert">
                Unable to load org.md ({orgMdError ?? 'request failed'}). The
                editor is disabled until it loads successfully.
                <button type="button"
                  onClick={() => setOrgMdRetry((n) => n + 1)}>Retry</button>
              </div>
            )}
            <textarea className="orgmd-editor" value={orgMd ?? ''}
              aria-label="org.md" disabled={orgMd == null}
              onChange={(e) => setOrgMd(e.target.value)} />
            {orgMdLoad === 'ready' && orgMd === '' && (
              <div className="orgmd-status">No org.md charter is configured.</div>
            )}
            {/* ⚠ the writer-facing half of the delivery cut. The prompt block
                already tells the AGENT its copy was cut, but an agent cannot
                shorten org.md — the operator is the only one who can, and was
                the only one never told. This says it where they are typing. */}
            {orgMdMeta?.read_truncated && (
              <div className="orgmd-warn" role="alert">
                ⚠ This file is {orgMdMeta.chars} chars — larger than the
                editor loads ({orgMdMeta.edit_max}). Editing is DISABLED so a
                partial copy cannot be saved over the whole file. Edit
                org.md on disk instead.
              </div>
            )}
            {orgMd != null && orgMdMeta?.prompt_max != null
              && unicodeLength(orgMd) > orgMdMeta.prompt_max && (
              <div className="orgmd-warn" role="alert">
                ⚠ {formatCount(unicodeLength(orgMd))} characters — only the first {formatCount(orgMdMeta.prompt_max)}
                {' '}characters reach an agent. The last {formatCount(unicodeLength(orgMd) - orgMdMeta.prompt_max)}
                {' '}{unicodeLength(orgMd) - orgMdMeta.prompt_max === 1 ? 'character is' : 'characters are'}
                {' '}delivered to NO agent on any provider. The file saves whole;
                {' '}the delivery is what is cut.
              </div>
            )}
          </SetBlock>
        </SetGroup>
        </SettingsTabPanel>

        {/* ── Policies (was the advanced modal's "general" tab) ─────────── */}
        <SettingsTabPanel id="policies" idBase="org-settings"
          active={tab === 'policies'}>
          {tree.fable_lock && (<SetGroup title="Locks">
                  <SetBlock>
                    <div className="row">
                      <button className="danger" onClick={() =>
                        saveSettings(tree.slug, { clear_fable_lock: true })
                          .then((r) => { toast(r.warnings); close() })
                          .catch((e: Error) => toast([`error: ${e.message}`]))}>
                        <BlockIcon fontSize="inherit" /> clear the fable weekly-limit lock (your decree)</button>
                    </div>
                  </SetBlock></SetGroup>)}
          {visited('policies') && (<>
            <SetGroup title="Fable tier">
              <SetRow label="weekly-limit policy"
                hint="what happens when the weekly Fable-tier limit is reached">
                <select value={fablePolicy} aria-label="fable weekly-limit policy"
                  onChange={(e) => setFablePolicy(e.target.value)}>
                  <option value="halt">halt (default)</option>
                  <option value="opus">switch to opus</option>
                  <option value="dissolve">dissolve subtree</option>
                </select>
              </SetRow>
              <SetRow label="content-filter policy"
                hint={'a flagged message halts the turn, converts the '
                  + 'agent to opus and retries, or runs an auto-autopsy'}>
                <select value={filterPolicy} aria-label="fable content-filter policy"
                  onChange={(e) => setFilterPolicy(e.target.value)}>
                  <option value="halt">halt (default)</option>
                  <option value="opus">switch to opus + retry</option>
                  <option value="auto-autopsy">auto-autopsy</option>
                </select>
              </SetRow>
              {filterPolicy === 'auto-autopsy' && (
                <SetRow label="autopsy model"
                  hint="model used to run the autopsy and re-brief the replacement agent (fable not selectable)">
                  <select value={filterModel} aria-label="autopsy model"
                    onChange={(e) => setFilterModel(e.target.value)}>
                    {autopsyGroups.map((g) => (
                      <optgroup key={g.label} label={g.label}>
                        {g.models.map((m) => (
                          <option key={m.tier} value={m.tier}>
                            {m.label}{m.seat != null ? ` · seat ${fmtCredits(m.seat)}` : ''}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </SetRow>
              )}
            </SetGroup>
            <SetGroup title="Cache-protective cheap compaction">
              <SetToggle label="reset a session before a known-cold turn"
                checked={accOn} onChange={setAccOn}
                hint={'org default — agents can override in their own ⚙. '
                  + 'The old self stays consultable. Cache expiry is fixed by '
                  + 'lane and never editable: Claude uses 60 min after a '
                  + 'positive subscription receipt or 5 min after a positive '
                  + 'API-key receipt; OpenAI subscription uses the documented '
                  + '30 min default as a fixed estimate. A known identity '
                  + 'mismatch is cold immediately; unknown forecasts never '
                  + 'auto-compact.'} />
              {accOn && (
                <SetRow label="only above a context occupancy of">
                  <input type="number" min="5" max="95" step="5" value={accOcc}
                    aria-label="cheap compaction context occupancy percent"
                    onChange={(e) => setAccOcc(e.target.value)} />
                  <span className="dim">%</span>
                </SetRow>
              )}
              {/* 2026-08-17: a usage-limit freeze outlives the cache TTL by
                  construction, so the auto-resume wake can swap the session
                  first and skip the cold reload. The manual ▶ never compacts. */}
              <SetToggle
                label="cheap-compact limit-frozen agents before auto-resume"
                checked={arCompact} onChange={setArCompact}
                title="applies only to the automatic resume after a usage-limit freeze (auto-resume toggle); pressing ▶ yourself resumes sessions as they are"
                hint={'applies to the automatic resume only — pressing ▶ '
                  + 'yourself resumes the session as it is'} />
            </SetGroup>
            {/* §4.6 cost-bubbling toggles (user spec, both ON by default) */}
            <SetGroup title="Credit cost bubbling">
              <SetToggle label="hires bubble their cost up the chain"
                checked={cascadeHire} onChange={setCascadeHire}
                hint={"off: the hiring agent's superior must hold the free "
                  + 'credits itself'} />
              <SetToggle
                label="allocations & model upgrades bubble their cost up the chain"
                checked={cascadeAlloc} onChange={setCascadeAlloc}
                hint="off: limited to the superior's own free credits" />
            </SetGroup>
          </>)}
        </SettingsTabPanel>

        {/* ── Org type (was the advanced modal's "org type" tab) ────────── */}
        {/* ── Mailserver (F-06). Saves IMMEDIATELY on its own, which is why
            it is rendered only once visited: an unvisited tab must not fetch
            hub state the operator never asked to see. ─────────────────── */}
        {tree.net != null && (
          <SettingsTabPanel id="mailserver" idBase="org-settings"
            active={tab === 'mailserver'}>
            {visited('mailserver') && <NetTab tree={tree} toast={toast}
              adding={netHubDraft} setAdding={setNetHubDraft} />}
          </SettingsTabPanel>
        )}

        {/* ── Autonomy — kiosks have none, so the tab is absent for them ── */}
        <SettingsTabPanel id="autonomy" idBase="org-settings"
            active={tab === 'autonomy'}>
            {visited('autonomy') && <AutonomyTab tree={tree} toast={toast}
              keyDraft={apiKeyDraft} setKeyDraft={setApiKeyDraft} />}
          </SettingsTabPanel>

        {/* ── History — the retained-records browser, a tab since the header
            cleanup (user 2026-09-10). Read-only; the save row below saves
            the OTHER tabs' edits and touches nothing here. ── */}
        <SettingsTabPanel id="history" idBase="org-settings"
            active={tab === 'history'}>
            {visited('history') && <HistoryView slug={tree.slug} />}
          </SettingsTabPanel>

        {/* ONE save button for the whole modal, on every tab — the panel's
            single save surface, unchanged. It is now visible from whichever
            tab you are on, which is what retires the four "changes here save
            with the panel's own save button" notes the nested modal needed. */}
        <div className="row">
          <button className="primary" onClick={() => {
            const jobs: Promise<{ warnings?: string[]
                                  freezes_cleared?: string[] }>[] = [
              saveSettings(tree.slug,
                { max_top_grant: +maxTop || undefined,
                  default_top_grant: Number.isFinite(+defTop) ? +defTop : undefined,
                  compact_at: Number.isFinite(+compactAt) ? +compactAt : undefined,
                  fable_limit_policy: fablePolicy,
                  fable_filter_policy: filterPolicy,
                  fable_filter_model: filterPolicy === 'auto-autopsy' ? filterModel : undefined,
                  default_effort: defEffort,
                  cascade_hire: cascadeHire,
                  cascade_alloc: cascadeAlloc,
                  auto_resume_compact: arCompact,
                  auto_cheap_compact: { enabled: accOn,
                    occ: (+accOcc || 50) / 100 } }),
              // pass the org.md warnings through rather than swallowing them:
              // a save that delivers less than it stored has to SAY so, and
              // this array is already how every other job reaches the toast
              orgMd != null
                ? putOrgMd(tree.slug, orgMd).then((r) => ({ warnings: r.warnings }))
                : Promise.resolve({}),
            ]
            Promise.all(jobs).then((rs) => {
              const cleared = rs.flatMap((r) => r.freezes_cleared ?? [])
              const lines = [
                ...(cleared.length
                  ? [`limit raised — cleared: ${cleared.join(', ')}`] : []),
                ...rs.flatMap((r) => r.warnings ?? []),
              ]
              toast(lines.length ? lines : ['settings saved'])
              // the edits are the server's now — drop the buffer so the panel
              // reads from the tree again rather than from what was typed
              clearEdits()
              close()
            }).catch((e: Error) => toast([`error: ${e.message}`]))
          }}>save</button>
          <button onClick={close}>cancel</button>
        </div>
    </PinFrame>
  )
}
