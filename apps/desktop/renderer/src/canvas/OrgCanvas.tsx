import { adoptPinLayer, usePinSurfaces, pinSnapId } from './pinspace'
import { closeSavedWindow, restoredAgent, restoredWindows, savedDeskIdentities } from '../windowlayout'
import { intersectsViewport, ViewportPath, worldViewport } from './viewport'
import { preserveRemovedDrafts, renameDrafts } from '../draftstore'
import { DeskHosts, useDeskActionsNow } from './deskhosts'
// canvas/OrgCanvas.tsx — the canvas core: the OrgCanvas component itself —
// camera (pan/zoom/springs/follow), tree layout orchestration, wires and
// mail sparks, node dragging and re-parenting, the retired/crowd piles, the
// HUD and agent tray, and the modal wiring. Extracted verbatim from
// Canvas.tsx in the phase-3 split.

import { Fragment, useCallback, useLayoutEffect, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import type { AudienceGrant, NodeStatus, ProviderInfo, ToastFn, TreeNode, TreePayload } from '../types'
import { audienceAction, getProviders, orgInboxRead, reorderNode } from '../api'
import {
  AddIcon, ChevronLeftIcon, ChevronRightIcon, FrozenIcon,
  FullscreenIcon, PublicIcon, RemoveIcon, ViewListIcon,
} from '../icons'
import {
  ago, ALL_TIER_SEAT, anyTierSeat, attentionPip, codexTierOffer, CODEX_TIER_LETTER, CODEX_TIER_SEAT, CODEX_TIERS, DOG_H, DOG_W, DRAFT, ease, edgeJumpPlacement, type EJForm, EXTERN, fallbackActive, familyOffer, flatten, fmtCredits, ANTIGRAVITY_TIER_LETTER, ANTIGRAVITY_TIER_SEAT, ANTIGRAVITY_TIERS, hireOf, INBOX, INBOX_H, jumpTo, layout, NODE_H, NODE_W, noteTierModels, openrouterTierIds, orgPxc, presenceOf, segD, setOpenRouterTiers,
  providerOf, queuedSwitchTitle, savedView, saveView, segPoint, sizeOf, smooth, SPRING_C, SPRING_K, startView, startZoomOn, TIER_LETTER, TIER_SEAT, tierCapabilityNotes, tierLabel, TIERS, useCrowdPiles, useHideRetired, usePolled, USER, USER_H,
  USER_W, withDraftTree, Z_DESK, Z_MAX, Z_MINI,
} from './shared'
import type {
  CanvasNode, DraftScope, DraftState, FamilyOffer, MailEvent, MailLinkFn,
  HireState, OpFn, Pile, Pt, Seg, Spring, StreamEvent, View, WorkLinkFn,
} from './shared'
import { ContextWheel, DeskChat, DestinationBusy, LineagePanel, TrayStatus } from './desk'
import { DocReader } from './docs'
import { mailRefTarget, useRefRoutes, Written } from './reflinks'
import type { ResolvedRef } from './reflinks'
import type { TypedRef } from './workrefs'
import { NodeInboxModal, OrgInboxModal } from './mail'
import { AgentDocketModal } from './agentdocket'
import { NodeConfig, PilePicker, WatchdogPanel } from './modals'
import { DraftNode, NodeSquare, UserNode } from './cards'
import { addPin, clampRect, PinLayer, prunePins, renamePin, showPin, usePins } from './pins'
import type { PinRect } from './pins'
import { clearRegion, fitZoom } from './clearRect'
import type { Region } from './clearRect'
import { isCompact, isMobile, MaybePortal, sheetGate } from '../mobile'
import { dropConvo, renameConvo } from '../convo'
import { isModalPinned, ModalOverPins, PinFrame, pinnedModalBehind, raisePinnedModal, readModalOpen, usePersistedModalOpen } from './modalpin'
import { freeInsets, useCanvasAnchor } from './canvasanchor'
import { charterLine } from '../archived'
import { NodeDetailGate } from './nodedetailgate'
import { contextMenuBelongsTo, useContextMenu } from './contextmenu'
import type { ContextMenuHandle, MenuEntry } from './contextmenu'
import { AgentRetireConfirm, agentMenuEntries } from './agentmenu'
import type { RetireKind } from './agentmenu'
import { useSurfaceDocument } from '../popout'

export interface OrgCanvasProps {
  tree: TreePayload
  op: OpFn
  slug: string
  toast: ToastFn
  mailEvt: MailEvent | null
  /** open the user's inbox, optionally jumped to a specific mail id */
  onInbox?: (jump?: string) => void
  /** open the work docket at ONE item — a tool chip's docket link */
  onWorkItem?: (slug: string) => void
  /** D-199: open the accounts panel — the route out of the no-harness state,
   *  which the canvas can reach but cannot render itself (it lives in App). */
  onAccounts?: () => void
  /** open GENERAL org settings (user ruling 2026-09-11): the eye's ⚙ and its
   *  context menu both go here. Same shape as `onAccounts` and for the same
   *  reason — SettingsPanel lives in App, not on the canvas. Absent on a
   *  public org, where that modal has no door; the controls disappear with
   *  it rather than becoming dead. */
  onOrgSettings?: () => void
  /** focus an agent's desk on the canvas (camera centerOn / mobile sheet) */
  focusAgent?: string | null
  onFocusAgentHandled?: () => void
  /** open one message, from a panel that owns no mailbox — the docket's
   *  `@mail:` references. The three boxes live on THIS side and the router
   *  below already knows which is which, so the shell hands the pointer down
   *  rather than growing a second copy of that routing table. Consumed once,
   *  exactly like `focusAgent`. */
  openMailAt?: { id: string; to: string; seq?: number } | null
  onOpenMailHandled?: () => void
  /** open one presented document, from a panel that owns no reader — the
   *  same one-shot route as `openMailAt`. The reader here IS the exact GET,
   *  so an id this org does not have is reported by the reader rather than
   *  guessed at up front. */
  openDocAt?: string | null
  onOpenDocHandled?: () => void
  /** open the selected agent's presentations in a shell modal */
  onOpenAgentGallery?: (agentId: string) => void
}

/** has this spring arrived? Both the spring loop (which snaps to the target on
 *  the frame this first holds) and the №25 follow ask it, and they have to ask
 *  the SAME question: the follow may only engage on a node that has come to
 *  rest, so a threshold that drifted between the two would let it engage on a
 *  node the loop still considers in flight — which is the freeze it exists to
 *  avoid. */
// the backdrop grid's pan rate relative to the foreground's — kept close to 1
// so the effect stays a tiny "farther away" cue, not a distinct layer racing
// past the cards.
const PARALLAX_BG = 0.88

const atRest = (s: Spring, tgt: Pt): boolean =>
  Math.abs(tgt.x - s.x) <= 0.4 && Math.abs(tgt.y - s.y) <= 0.4
  && Math.abs(s.vx) <= 2 && Math.abs(s.vy) <= 2

/** Move browser-owned state whose key includes a node id. The server's rename
 * is authoritative; this only carries the corresponding client view state
 * across the same validated identity transition. Existing destination values
 * win defensively, so a stale or hand-edited key is never overwritten. */
const migrateClientNodeState = (slug: string, from: string, to: string): void => {
  try {
    const oldDraft = `orgtree-draft-${slug}-${from}`
    const newDraft = `orgtree-draft-${slug}-${to}`
    const draft = localStorage.getItem(oldDraft)
    if (draft != null) {
      if (localStorage.getItem(newDraft) == null) localStorage.setItem(newDraft, draft)
      localStorage.removeItem(oldDraft)
    }
    for (const suffix of ['eyemin', 'eyeseen']) {
      const key = `orgtree-${suffix}-${slug}`
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const ids = JSON.parse(raw) as unknown
      if (!Array.isArray(ids)) continue
      const next = [...new Set(ids.map((id) => id === from ? to : id))]
      if (JSON.stringify(next) !== JSON.stringify(ids)) localStorage.setItem(key, JSON.stringify(next))
    }
    const pileKey = `orgtree-pile-${slug}`
    const rawPile = localStorage.getItem(pileKey)
    if (rawPile) {
      const pile = JSON.parse(rawPile) as unknown
      if (pile && typeof pile === 'object' && !Array.isArray(pile)) {
        const next: Record<string, string> = {}
        for (const [parent, front] of Object.entries(pile as Record<string, unknown>)) {
          const nextParent = parent === from || parent.startsWith(`${from}|`)
            ? to + parent.slice(from.length) : parent
          next[nextParent] = front === from ? to : String(front)
        }
        if (JSON.stringify(next) !== JSON.stringify(pile)) localStorage.setItem(pileKey, JSON.stringify(next))
      }
    }
  } catch { /* private mode or hand-edited state — never block tree updates */ }
}

// Switching organizations restores each org's OWN saved camera (user spec
// 2026-09-10: selecting an org from the tray list or the sidebar reopens its
// saved pins, popouts and canvas position — pins and popouts already restore
// per org; the camera is this pair's job). Only the FIRST canvas a session
// shows keeps the configured start-view intro (org glide / switchboard /
// remember): a later switch is a return to a place the user already
// arranged, so it restores like 'remember' does. Module-level on purpose —
// an org switch unmounts the canvas, so the fact "this session already
// showed a canvas" must live outside the component; a page reload starts a
// fresh session and plays the configured intro again.
let firstCanvasSlug: string | null = null
let leftFirstOrg = false

/** THE CAMERA INTENT - the view a command asked for, which the canvas keeps
 *  honouring as the available canvas changes under it (user 2026-09-11).
 *    'org'    the whole-org fit - the historical `fitFollowing` boolean.
 *    'focus'  one target filling the canvas: an agent's desk, or the
 *             SWITCHBOARD when the id is the eye.
 *  DIFFERENT GEOMETRY TRIGGERS: 'org' refits when the org's extent OR the
 *  canvas changes; 'focus' only when the canvas does (a desk's size is
 *  fixed). RELEASED by `animateTo` - so any unclaimed camera move, a manual
 *  pan or a wheel zoom drops it - and REPLACED, never stacked, by the next
 *  command. */
type CamIntent =
  | { kind: 'org' }
  | { kind: 'focus'; id: string; z: number | null; onCanvas?: boolean }
/** tests only: put the module back in the fresh-session state */
export const resetCanvasSessionForTests = (): void => { firstCanvasSlug = null; leftFirstOrg = false }

/** hide-retired's DISPLAY prune of the layout tree (pure — the canvas memos
 *  it; tests call it directly). Removes archived subtrees from the children
 *  lists, EXCEPT: a knowledge bearer (its floating card is an active
 *  consultation surface), an archived node with a LIVE descendant (hiding it
 *  would hide live agents), and anything the session has revealed. Returns
 *  the pruned root, the hidden retirees grouped by their visible parent (the
 *  retired-list token's data), and the full id set of everything pruned
 *  (centerOn's reveal hook). */
export function pruneRetiredView(root: CanvasNode, hideRetired: boolean,
  shownRetired: ReadonlySet<string>): {
  root: CanvasNode
  retiredByParent: Map<string, CanvasNode[]>
  prunedIds: Set<string>
} {
  const retiredByParent = new Map<string, CanvasNode[]>()
  const prunedIds = new Set<string>()
  if (!hideRetired) return { root, retiredByParent, prunedIds }
  const hasLive = (n: CanvasNode): boolean => n.state === 'live'
    || (n.children ?? []).some(hasLive)
  const collect = (n: CanvasNode) => {
    prunedIds.add(n.id)
    ;(n.children ?? []).forEach(collect)
  }
  const walk = (n: CanvasNode): CanvasNode => {
    const keep: CanvasNode[] = []
    const gone: CanvasNode[] = []
    for (const c of n.children ?? []) {
      if (c.state === 'archived' && !c.isBearerOf && !shownRetired.has(c.id)
          && !hasLive(c)) { gone.push(c); collect(c) }
      else keep.push(walk(c))
    }
    if (gone.length) retiredByParent.set(n.id, gone)
    return gone.length || keep.some((c, i) => c !== (n.children ?? [])[i])
      ? { ...n, children: keep } : n
  }
  return { root: walk(root), retiredByParent, prunedIds }
}

/**
 * The Agents List's context-menu host (user request 2026-09-12).
 *
 * ⚠ IT IS A COMPONENT, AND IT IS MOUNTED INSIDE THE LIST'S FRAME, for two
 * reasons that are the same reason: `useContextMenu` and `ConfirmModal` both
 * resolve the document they render into from the SURFACE they are called in
 * (popout.tsx), and the Agents List pops out into a window of its own. Called
 * from OrgCanvas's body they would resolve to the main window and put the menu
 * — and the retire dialog behind it — in the wrong one.
 *
 * The rows stay where they are, rendered by the canvas, because they are built
 * from the canvas's own handlers; this only lends them the menu handle and the
 * confirm. The shared menu records its row anchor so the list's click-away
 * rule recognizes a press in its own menu even though it lives in the body.
 */
function AgentListMenuHost({ render, map, op, slug, toast }: {
  render: (menu: ContextMenuHandle,
    ask: (a: { id: string; kind: RetireKind }) => void,
    deskNow: ReturnType<typeof useDeskActionsNow>) => ReactNode
  map: Map<string, CanvasNode>
  op: OpFn
  /** for the desk registry: the popout entries read it when the menu opens */
  slug: string
  toast: ToastFn
}) {
  const menu = useContextMenu()
  // ⚠ HERE AND NOT IN OrgCanvas's BODY: the desk registry's context provider is
  // `<DeskHosts>`, which OrgCanvas RENDERS — a hook called in its body would
  // read the context from outside the provider and get null. This host is
  // inside it, with the rows.
  const deskNow = useDeskActionsNow(slug)
  const [asking, setAsking] = useState<{ id: string; kind: RetireKind } | null>(null)
  const body = useSurfaceDocument().body
  const node = asking ? map.get(asking.id) : null
  return <>
    {render(menu, setAsking, deskNow)}
    {menu.node}
    {/* the confirm is the CARD's confirm — same wording, same op, same undo
        toast (canvas/agentmenu.tsx). It is portaled out of the list's own
        scroller, which clips, into whichever document this list is in. */}
    {node && asking && createPortal(
      <AgentRetireConfirm kind={asking.kind} node={node} op={op} toast={toast}
        close={() => setAsking(null)} />, body)}
  </>
}

export function OrgCanvas({ tree, op, slug, toast, mailEvt, onInbox, onOrgSettings, onWorkItem,
  onAccounts, focusAgent, onFocusAgentHandled, openMailAt,
  onOpenMailHandled, openDocAt, onOpenDocHandled, onOpenAgentGallery }: OrgCanvasProps) {
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [configId, setConfigId] = useState<string | null>(null)
  // A pinned node-config remains mounted as a window; clicking its same
  // opener toggles visibility, while another agent's gear selects that agent.
  // Every opener is an ACTIVATION first (user ruling 2026-09-10 16:36, all
  // pinned modals): a pinned window sitting behind another surface is raised
  // and (re)targeted, never silently closed — the plain toggle applies only
  // when the window is already on top or not pinned at all.
  const toggleConfig = useCallback((id: string) => {
    if (pinnedModalBehind('node-config', slug)) {
      raisePinnedModal('node-config', slug); setConfigId(id); return
    }
    setConfigId((v) => isModalPinned('node-config', slug) && v === id ? null : id)
  }, [])
  const toggleNodeSurface = useCallback((kind: string, id: string,
    set: (v: string | null | ((current: string | null) => string | null)) => void) => {
    if (pinnedModalBehind(kind, slug)) {
      raisePinnedModal(kind, slug); set(id); return
    }
    set((current) => isModalPinned(kind, slug) && current === id ? null : id)
  }, [])
  const toggleDog = useCallback((id: string) => {
    if (pinnedModalBehind('watchdog', slug)) {
      raisePinnedModal('watchdog', slug); setDogView(id); return
    }
    setDogView((current) => isModalPinned('watchdog', slug) && current === id ? null : id)
  }, [])
  const [lineageId, setLineageId] = useState<string | null>(null)
  const [restoreDesks, setRestoreDesks] = useState(() => savedDeskIdentities(slug))
  useEffect(() => { setRestoreDesks(savedDeskIdentities(slug)) }, [slug])
  const [restoredDocs, setRestoredDocs] = useState(() => restoredWindows(slug).filter(r => r.kind !== 'doc' && r.restore?.document))
  const restoredModalOrg = useRef<string | null>(null)
  const [docView, setDocView] = useState<string | null>(null)   // FR-03 reader
  const [trayOpen, setTrayOpen] = useState(false)   // the flat agent tray
  const trayWrapRef = useRef<HTMLDivElement | null>(null)
  const [trayQ, setTrayQ] = useState('')            // №26: tray name filter
  const [trayArch, setTrayArch] = useState(false)   // archived rows shown (user
                                                    // spec: hidden by default)
  // "Hire a subordinate…" picked from an AGENTS LIST row: the hire chips are
  // the card's, so the row walks the camera there and hands the card this
  // signal. A counter rather than a flag — picking it twice for the same agent
  // must open the chips twice — cleared by the card once it has acted on it.
  const [hireReveal, setHireReveal] =
    useState<{ id: string; seq: number } | null>(null)
  const [inboxId, setInboxId] = useState<string | null>(null)
  const [agentDocketId, setAgentDocketId] = useState<string | null>(null)
  const [oiOpen, setOiOpen] = useState(false)       // the ORG-inbox viewer
  // inline mail links (user spec 2026-07-31): a chat's send chip opens the
  // box that HOLDS the mail, selected on it — user inbox, a node's inbox, or
  // the org inbox for outbound. Jump ids clear when the modal closes.
  // the REQUEST, not the target: two clicks on the same message are two
  // requests, and the panel's latch compares the request (`jumpKey`)
  const [nodeInboxJump, setNodeInboxJump] =
    useState<{ id: string; seq: number } | null>(null)
  // the org-mail a link or a reference targets — a REQUEST, so a repeat
  // click on the same row is a second request (`jumpKey`)
  const [oiJump, setOiJump] = useState<{ id: string; seq: number } | null>(null)
  const [dogView, setDogView] = useState<string | null>(null)  // FR-18 panel

  // ---- mobile wave (D-123/D-125) ----
  // the desk SHEET: explicit state, mobile-only. This deliberately does NOT
  // touch focusId — at compact the zoom clamps below Z_DESK so the camera-
  // derived focus never fires, and the two sources of truth never coexist
  // (the spec's §2-① haunting dissolves by partition, not by a third guard).
  const [sheetId, setSheetId] = useState<string | null>(null)
  const [sheetDogs, setSheetDogs] = useState(false)   // header dog list open
  const [hireOpen, setHireOpen] = useState(false)     // compact hire form
  const [, setVpTick] = useState(0)                   // re-render on resize

  useEffect(() => {
    if (!trayOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      // A pinned or detached PinFrame is a window, not a centred modal. Its
      // panel may be portalled away from trayWrapRef, so the ordinary tray
      // containment check must not dismiss it from a main-window gesture.
      const detached = restoredWindows(slug).some(r => r.kind === 'agent-list')
      if (isModalPinned('agent-list', slug) || detached) return
      const root = trayWrapRef.current
      if (!root) return
      const path = typeof event.composedPath === 'function'
        ? event.composedPath()
        : []
      if (path.includes(root)) return
      if (event.target instanceof Node && root.contains(event.target)) return
      // Its own menu portals to the body. Keep the list alive through the
      // press that chooses an entry; other surfaces' menus remain outside.
      if (contextMenuBelongsTo(event.target, root)) return
      // Capture observes the gesture but never consumes it: the outside
      // control or canvas still receives the same pointerdown/click/drag.
      setTrayOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      // `defaultPrevented` is the Escape STACK's answer (shared.ts useEsc): the
      // top surface — a row's open context menu — has already taken this key
      // and closed itself. One Escape closes one thing.
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (isModalPinned('agent-list', slug) || restoredWindows(slug).some(r => r.kind === 'agent-list')) return
        setTrayOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [slug, trayOpen])

  const compact = isCompact()
  const compactRef = useRef(compact); compactRef.current = compact
  // the eye's unread-mail GLOW is gone (user ruling 2026-08-04: only agents
  // that need the user's answer glow; the header ask icon carries the rest).
  // The seen-stamp bookkeeping stays: the inbox count badge still uses it.
  // guarded like every other client-state read in this file: a browser that
  // BLOCKS storage throws from the `localStorage` getter itself, and this one
  // runs during OrgCanvas's FIRST RENDER — unguarded it took the whole app to
  // the crash screen the moment the tree loaded, which is the same startup
  // failure as the crash reporter's (redteam-opus 2026-09-07, seen in Chrome).
  const [, setInboxSeen] = useState(() => {
    try { return localStorage.getItem('orgtree-inbox-seen-' + slug) ?? '' }
    catch { return '' }
  })
  // ⚠ NOT A LITERAL. This used to spell out eleven prices of its own and the
  // copy went stale: `astra` reached ledger.TIERS and shared.ts's codex table
  // but never this line, so a payload without `tiers` priced an astra seat at
  // nothing. `ALL_TIER_SEAT` is the merge of the three family tables, which
  // chiptips §8b holds against the backend — one place to update, one check.
  const seats = tree.tiers ?? ALL_TIER_SEAT
  // FR-15 M8: hire surfaces render from the provider payload — whether the
  // codex family is hireable HERE and NOW (CLI installed + signed in) or
  // still a disabled preview, with the payload's own reason as the tooltip.
  // D-203: a provider switch is a machine-wide mutation. `req()` wakes the
  // livebus after it saves, so this reader refetches immediately and the
  // canvas behind App settings changes before the modal closes. The old
  // fetch-once effect made a correctly persisted toggle look inert until a
  // reload or org change.
  const providerPayload = usePolled(getProviders, [slug], 60000)
  const providerEntries = providerPayload?.providers ?? []
  const codexProvider = providerEntries.find(
    (v) => v.id === 'openai') ?? null
  const antigravityProvider = providerEntries.find(
    (v) => v.id === 'google') ?? null
  // the OpenRouter lane (2026-09-02): its entry ALSO carries the runtime
  // tiers (the user's favorites) that every hire surface draws from the
  // shared registry — adopted here, on the canvas's own poll, so the chips
  // and the generated tier CSS follow the settings panel within one poll
  const openrouterProvider = providerEntries.find(
    (v) => v.id === 'openrouter') ?? null
  useEffect(() => { setOpenRouterTiers(openrouterProvider?.tiers) },
    [openrouterProvider])
  // …and the org doc's own tier→model table, so a node still running on a
  // favorite that was since deselected is named by its model, not its slug
  useEffect(() => { noteTierModels(tree.models) }, [tree.models])
  // D-199: Claude is read from the payload like the other two. It never was —
  // there was no `claudeProvider` at all, which is why a machine with only
  // Codex set up still offered four live Claude hire buttons.
  const claudeProvider = providerEntries.find(
    (v) => v.id === 'claude') ?? null
  // `installed` rides along because the offer rule needs to tell "absent" from
  // "signed out" — hiding is reserved for the first (see `familyOffer`).
  // D-202 moved `hireOf` into shared.ts when the accounts panel and the two
  // dropdown surfaces started asking the same question.
  const codexHire = hireOf(codexProvider)
  const antigravityHire = hireOf(antigravityProvider)
  const claudeHire = hireOf(claudeProvider)
  const openrouterHire = hireOf(openrouterProvider)
  // D-202: which families exist on this machine at all, for the surfaces that
  // are not hire strips (the model-switch dropdown, the lineage rehire
  // dropdown). Same verdict the chips use — see `providerShown`.
  const presence = useMemo(() => presenceOf({
    claude: claudeProvider, openai: codexProvider, google: antigravityProvider,
    openrouter: openrouterProvider,
  }), [claudeProvider, codexProvider, antigravityProvider, openrouterProvider])
  const userDisabled = useMemo(() => ({
    claude: claudeProvider?.user_enabled === false,
    openai: codexProvider?.user_enabled === false,
    google: antigravityProvider?.user_enabled === false,
    openrouter: openrouterProvider?.user_enabled === false,
  }), [claudeProvider, codexProvider, antigravityProvider, openrouterProvider])
  // canonical retired-stack slot (user note 2026-08-06): display-order every
  // parent's children so archived siblings sit CONTIGUOUSLY at the first
  // archived ordinal. Buried members take no layout space, so with a
  // contiguous block the pile's front renders between the same visible
  // neighbors no matter which member fronts it — switching fronts can no
  // longer make the stack jump columns. Pure display transform: the doc's
  // child order is untouched (a drag commits the block order for real).
  const canonPiles = (n: CanvasNode): CanvasNode => {
    const kids = (n.children ?? []).map(canonPiles)
    const arch = kids.filter((c) => c.state === 'archived')
    if (arch.length < 2) return { ...n, children: kids }
    const at = kids.findIndex((c) => c.state === 'archived')
    const before = kids.slice(0, at).filter((c) => c.state !== 'archived')
    const after = kids.slice(at).filter((c) => c.state !== 'archived')
    return { ...n, children: [...before, ...arch, ...after] }
  }
  const vrootFull = useMemo(() => canonPiles(withDraftTree(tree, draft)),
    [tree, draft])   // eslint-disable-line react-hooks/exhaustive-deps
  // hide-retired (user resumed 2026-09-10 13:25): a DISPLAY prune of the
  // LAYOUT tree only. `map` stays FULL below, so desks, mail routing, the
  // agents tray's archived rows, lineage and window restoration keep every
  // retiree addressable — a hidden retiree simply has no canvas position
  // until something reveals it. Reveals are per-session (state, reset on an
  // org switch), and three things reveal: the retired-list token, the
  // switchboard's archived rows, and ANY jump to the retiree (centerOn).
  // ⚠ never prune an archived node that still has a LIVE descendant (a
  // transiently un-reassigned subtree) — hiding it would hide live agents —
  // and never prune a knowledge BEARER: its floating card over the successor
  // is an active consultation surface, not a resting retiree.
  const hideRetired = useHideRetired()
  const [shownRetired, setShownRetired] = useState<ReadonlySet<string>>(() => new Set<string>())
  useEffect(() => { setShownRetired(new Set<string>()) }, [slug])
  const prunedView = useMemo(() => pruneRetiredView(vrootFull, hideRetired, shownRetired),
    [vrootFull, hideRetired, shownRetired])
  const vroot = prunedView.root
  const prunedRef = useRef(prunedView.prunedIds)
  useEffect(() => { prunedRef.current = prunedView.prunedIds }, [prunedView])
  // the retired-list token's open menu: the parent id whose list is showing
  const [retiredOpen, setRetiredOpen] = useState<string | null>(null)
  const map = useMemo(() => flatten(vrootFull, seats), [vrootFull])   // eslint-disable-line
  usePersistedModalOpen('node-config', slug, configId !== null, configId ? { agent: configId, generation: map.get(configId)?.generation } : undefined)
  usePersistedModalOpen('lineage', slug, lineageId !== null, lineageId ? { agent: lineageId, generation: map.get(lineageId)?.generation } : undefined)
  usePersistedModalOpen('node-inbox', slug, inboxId !== null, inboxId ? { agent: inboxId, generation: map.get(inboxId)?.generation } : undefined)
  usePersistedModalOpen('agent-docket', slug, agentDocketId !== null, agentDocketId ? { agent: agentDocketId, generation: map.get(agentDocketId)?.generation } : undefined)
  usePersistedModalOpen('watchdog', slug, dogView !== null, dogView ? { watchdog: dogView } : undefined)
  usePersistedModalOpen('org-inbox', slug, oiOpen)
  usePersistedModalOpen('doc', slug, docView !== null, docView ? { document: docView } : undefined)
  usePersistedModalOpen('agent-list', slug, trayOpen)
  useEffect(() => {
    if (restoredModalOrg.current === slug) return
    restoredModalOrg.current = slug
    const rows = restoredWindows(slug)
    const pinned = readModalOpen(slug)
    const pinnedKind = (kind: string) => pinned.some(r => r.kind === kind && isModalPinned(kind, slug))
    const agent = (kind: string) => restoredAgent(rows.find(r => r.kind === kind), map)
    const pinnedAgent = (kind: string) => {
      const row = pinned.find(r => r.kind === kind && r.restore?.agent)
      return row ? restoredAgent({
        key: `pinned:${slug}:${kind}`, kind, org: slug, open: true,
        rect: { x: 0, y: 0, width: 200, height: 150 }, restore: row.restore,
      }, map) : null
    }
    setConfigId(pinnedKind('node-config') ? (agent('node-config') ?? pinnedAgent('node-config')) : agent('node-config'))
    setLineageId(pinnedKind('lineage') ? (agent('lineage') ?? pinnedAgent('lineage')) : agent('lineage'))
    setInboxId(pinnedKind('node-inbox') ? (agent('node-inbox') ?? pinnedAgent('node-inbox')) : agent('node-inbox'))
    setAgentDocketId(pinnedKind('agent-docket') ? (agent('agent-docket') ?? pinnedAgent('agent-docket')) : agent('agent-docket'))
    setOiOpen(pinnedKind('org-inbox') || rows.some(r => r.kind === 'org-inbox'))
    setTrayOpen(pinnedKind('agent-list') || rows.some(r => r.kind === 'agent-list'))
    const watchdogRow = pinned.find(r => r.kind === 'watchdog') || rows.find(r => r.kind === 'watchdog')
    const watchdog = watchdogRow?.restore?.watchdog
    // Keep a pinned restore target even when watchdog data arrives later; the
    // panel render below already waits for the matching tree entry.
    setDogView(watchdog && (pinnedKind('watchdog') || !!rows.find(r => r.kind === 'watchdog')) ? watchdog : null)
    const pinnedDoc = pinned.find(r => r.kind === 'doc' && r.restore?.document)
    setDocView(pinnedDoc?.restore?.document ?? rows.find(r => r.kind === 'doc')?.restore?.document ?? null)
    setRestoredDocs(rows.filter(r => r.kind !== 'doc' && r.restore?.document))
    const unavailable = rows.filter(r => r.restore?.agent && !restoredAgent(r, map))
    if (unavailable.length) toast(['Some saved windows refer to an agent generation that is no longer available.'])
  }, [slug, map])
  // the mail-link router — STABLE identity (Msg is memoized on its props;
  // the ref carries the fresh closure). user_inbox → the eye's mailbox
  // (marking the glow seen, same as its ✉); @ext:/@org:/@mcp: → the org
  // inbox; anything else → that node's inbox. Dead targets no-op.
  const openMailRef = useRef<MailLinkFn | null>(null)
  openMailRef.current = (m) => {
    if (!m?.id || !m?.to) return
    if (m.to === 'user_inbox') {
      const nw = tree.user_inbox_newest ?? new Date().toISOString()
      localStorage.setItem('orgtree-inbox-seen-' + slug, nw)
      setInboxSeen(nw)
      onInbox?.(m.id)
    } else if (String(m.to).startsWith('@')) {
      setOiJump({ id: String(m.id), seq: jumpTo(String(m.id)).seq })
      setOiOpen(true)
    } else if (map.has(m.to)) {
      setNodeInboxJump({ id: String(m.id), seq: jumpTo(String(m.id)).seq })
      setInboxId(m.to)
    }
  }
  const openMail = useCallback<MailLinkFn>((m) => openMailRef.current?.(m), [])
  // a pointer handed down from the shell (the docket's `@mail:` references).
  // It goes through the SAME router as a chat chip's mail link — one routing
  // table, so a box that opens from one surface opens from the other.
  useEffect(() => {
    if (!openMailAt) return
    openMailRef.current?.(openMailAt)
    onOpenMailHandled?.()
  }, [openMailAt, onOpenMailHandled])
  useEffect(() => {
    if (!openDocAt) return
    setDocView(openDocAt)
    onOpenDocHandled?.()
  }, [openDocAt, onOpenDocHandled])
  // THE DOCKET LIVES IN APP, so a work link is handed straight up rather than
  // half-handled here. The canvas owns the inbox modals and genuinely routes
  // mail; it owns nothing of the docket and should not pretend to.
  const openWork = useCallback<WorkLinkFn>(
    (w) => { if (w?.slug) onWorkItem?.(w.slug) }, [onWorkItem])
  // RETIRED PILE (user spec): archived siblings in a cohort stack into ONE
  // pile so long-running orgs don't fill the canvas with retirees. The FRONT
  // retiree is the interactable card (zoom/desk/inbox/rehire); clicking the
  // visible stack margin opens a picker to bring another to the front.
  const [pileFront, setPileFront] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('orgtree-pile-' + slug)
        || '{}') as Record<string, string>
    } catch { return {} }
  })
  const [pileOpen, setPileOpen] = useState<string | null>(null)  // parent id whose menu is open
  const setFront = useCallback((parent: string, nid: string) => {
    setPileFront((pf) => {
      const nf = { ...pf, [parent]: nid }
      localStorage.setItem('orgtree-pile-' + slug, JSON.stringify(nf))
      return nf
    })
  }, [slug])
  // D-198: collapsing ACTIVE agents into a stack is opt-in and off by default.
  // Read as state (not by calling crowdPilesOn() inline) so flipping the switch
  // re-piles the canvas under live agents instead of waiting for a reload.
  const crowdPiles = useCrowdPiles()
  const piles = useMemo(() => {   // pile key ("<parent>|a"/"<parent>|c") → pile
    const out = new Map<string, Pile>()
    const walk = (n: CanvasNode) => {
      const kids = n.children ?? []
      const arch = kids.filter((c) => c.state === 'archived')
      if (arch.length >= 2) {
        const key = n.id + '|a'
        const want = pileFront[key]
        out.set(key, {
          key, parent: n.id, kind: 'a',
          list: arch.map((c) => c.id),
          front: arch.some((c) => c.id === want) ? want! : arch[arch.length - 1]!.id, // nUIA: some() hit ⇒ want defined; length>=2 checked
        })
      }
      // CROWD pile (user spec 2026-07-31): a WIDE team — more than 8 active
      // reports under one agent — stacks its LEAF reports (no subtree of
      // their own) into one pile, same front/picker mechanics as the retired
      // pile. Non-leaf reports keep their own columns; the draft card never
      // stacks (hiring stays visible at any width).
      // ⚠ OPT-IN since D-198 (user ruling 2026-08-29): OFF unless the reader
      // has turned it on, so a wide team shows every one of its agents by
      // default. Gated HERE, at the one place a crowd pile is constructed,
      // rather than at each consumer: `hidden`, `layout`, `pileByFront`,
      // `pileOfRef`, the picker and the `.pile-stack` render all derive from
      // this map, so an empty map is exactly the shape they already handle for
      // every org with eight reports or fewer. The RETIRED pile above is a
      // separate behaviour and is deliberately untouched.
      const active = kids.filter((c) => c.state !== 'archived' && c.id !== DRAFT)
      if (crowdPiles && active.length > 8) {
        const leaves = active.filter((c) => !(c.children ?? []).length)
        if (leaves.length >= 2) {
          const key = n.id + '|c'
          const want = pileFront[key]
          out.set(key, {
            key, parent: n.id, kind: 'c',
            list: leaves.map((c) => c.id),
            front: leaves.some((c) => c.id === want) ? want! // nUIA: some() hit ⇒ want defined
              : leaves[leaves.length - 1]!.id,               // nUIA: leaves.length >= 2 checked
          })
        }
      }
      kids.forEach(walk)
    }
    walk(vroot)
    return out
  }, [vroot, pileFront, crowdPiles])
  const pileByFront = useMemo(() => {
    const out = new Map<string, Pile>()
    for (const p of piles.values()) out.set(p.front, p)
    return out
  }, [piles])
  // member id → its pile, for focus-brings-to-front (ref: centerOn is a
  // stable callback and must read the CURRENT piles mid-gesture)
  const pileOfRef = useRef(new Map<string, Pile>())
  useEffect(() => {
    const out = new Map<string, Pile>()
    for (const p of piles.values()) for (const m of p.list) out.set(m, p)
    pileOfRef.current = out
  }, [piles])
  const hiddenMemo = useMemo(() => {     // piled-away id → its pile's front id
    const out = new Map<string, string>()
    const bury = (n: CanvasNode, front: string) => {
      out.set(n.id, front)
      ;(n.children ?? []).forEach((c) => bury(c, front))
    }
    const walk = (n: CanvasNode) => {
      const pa = piles.get(n.id + '|a')
      const pc = piles.get(n.id + '|c')
      const crowd = pc ? new Set(pc.list) : null
      ;(n.children ?? []).forEach((c) => {
        if (pa && c.state === 'archived' && c.id !== pa.front) bury(c, pa.front)
        else if (crowd && crowd.has(c.id) && c.id !== pc!.front) {
          out.set(c.id, pc!.front)   // leaves by definition: nothing beneath
        } else walk(c)
      })
    }
    walk(vroot)
    return out
  }, [vroot, piles])
  const hidden = hiddenMemo
  const target = useMemo(() => {
    const t = layout(vroot, hidden)
    for (const n of map.values()) {           // live bearers float ABOVE the successor
      // (clear of its card — overlap made both unclickable)
      if (n.isBearerOf && t.has(n.isBearerOf)) {
        const p = t.get(n.isBearerOf)!
        t.set(n.id, {
          x: p.x + 42 + 18 * n.bearerIndex!,
          y: p.y - (NODE_H + 26) - 20 * n.bearerIndex!,
        })
      }
    }
    // FR-18: watchdogs fan out BELOW their owner like a miniature subtree,
    // in the corridor between the agent and its reports (user revision
    // 2026-08-14 — the old left-side column crossed into an adjacent card
    // by 14px). Rows of 3 centered on the owner: a full row is 162px
    // against the 186px sibling pitch, so it never reaches a neighboring
    // card and clears even a maxed-out sibling's own chips by 24px. Only
    // dogs 7–8 open a third row, which can brush the children's row 200px
    // down — the 8-per-agent cap keeps that the rare case. Having a target
    // position is ALL a spark needs, so launchSpark(dog → owner) works
    // with zero animation code.
    {
      const byOwner: Record<string, number> = {}
      for (const w of tree.watchdogs ?? [])
        if (t.has(w.owner)) byOwner[w.owner] = (byOwner[w.owner] ?? 0) + 1
      const seen: Record<string, number> = {}
      const PER_ROW = 3, GX = 6, GY = 4
      for (const w of tree.watchdogs ?? []) {
        if (!t.has(w.owner)) continue
        const p = t.get(w.owner)!
        const i = seen[w.owner] ?? 0
        seen[w.owner] = i + 1
        const row = Math.floor(i / PER_ROW), col = i % PER_ROW
        const inRow = Math.min(PER_ROW, byOwner[w.owner]! - row * PER_ROW)
        const rowW = inRow * DOG_W + (inRow - 1) * GX
        t.set('dog:' + w.id, {
          x: p.x + NODE_W / 2 - rowW / 2 + col * (DOG_W + GX),
          y: p.y + NODE_H + 8 + row * (DOG_H + GY),
        })
      }
    }
    // the ORG INBOX panel (user spec): up and to the RIGHT of the overseer —
    // "out of the way" of the org structure, not stacked on its axis — and it
    // only exists once the org has received outside mail or granted an inbox
    // audience; until then the canvas is unchanged
    if (tree.org_inbox?.visible) {
      const eye = t.get(USER)
      if (eye) t.set(INBOX, { x: eye.x + USER_W + 260, y: eye.y - INBOX_H - 96 })
    }
    let minY = Infinity
    for (const p of t.values()) minY = Math.min(minY, p.y)
    // headroom for the eye's infinite bar (2× the eye card, fading upward)
    if (minY < 140) for (const p of t.values()) p.y += 140 - minY
    // piled-away retirees sit exactly under their pile's front card (they
    // aren't rendered, but wires/sparks/centerOn need a sane position)
    for (const [hid, front] of hidden) {
      const fp = t.get(front)
      if (fp) t.set(hid, { x: fp.x, y: fp.y })
    }
    return t
  }, [vroot, map, tree.org_inbox?.visible, hidden])
  const [view, setView] = useState<View>(() => {
    // fit-on-load: center the initial tree in a typical viewport (re-fit against
    // the REAL viewport once mounted — see the mount effect below)
    const t = layout(withDraftTree(tree, null))
    let maxX = 0, maxY = 0
    for (const p of t.values()) { maxX = Math.max(maxX, p.x + 300); maxY = Math.max(maxY, p.y + 260) }
    const z = Math.min(1.3, Math.max(0.35, Math.min(1300 / maxX, 780 / maxY)))
    return { x: Math.max(24, (1400 - maxX * z) / 2), y: 24, z }
  })
  const [, setFrame] = useState(0)
  const [dropId, setDropId] = useState<string | null>(null)
  // FR-3: desks pinned to screenspace (pins.tsx). Desktop only — the mobile
  // sheet is the phone's window, and startNodeDrag bails on isMobile for
  // reasons (no hover, no cheap escape under a finger) that apply here too.
  const pins = usePins(slug)
  const modalSurfaces = usePinSurfaces()
  const pinnedIds = useMemo(() => new Set(isMobile ? [] : pins.map((p) => p.id)), [pins])

  const viewportRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const host = viewportRef.current
    if (host) return adoptPinLayer(slug, host)
  }, [slug])
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      setViewportSize(prev => prev.w === rect.width && prev.h === rect.height ? prev : { w: rect.width, h: rect.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const visibleRect = worldViewport(view, viewportSize.w, viewportSize.h)
  const viewRef = useRef(view); viewRef.current = view
  const animRef = useRef<number | null>(null)
  const camIntent = useRef<CamIntent | null>(null)
  const fitGeometry = useRef<{ slug: string; canvas: string; whole: string } | null>(null)
  const animBusyRef = useRef(false)  // a camera animation owns the view
  const focusRef = useRef<string | null>(null)   // №25: the desk the camera rides with
  const followRef = useRef<{ id: string; x: number; y: number } | null>(null)
  // an in-flight background pan. sx/sy is where the finger went down and ox/oy
  // the camera at that moment; the pan then writes the camera ABSOLUTELY, as
  // ox + (clientX - sx). lx/ly track where the pointer is NOW, which is what
  // lets any OTHER camera writer re-base ox/oy onto the camera it just wrote
  // (see rebasePan) instead of leaving this origin stale — a stale origin
  // re-applied at a new zoom is what put the whole world off-screen.
  const panRef = useRef<{
    sx: number; sy: number; lx: number; ly: number
    ox: number; oy: number; moved: boolean } | null>(null)
  const springs = useRef(new Map<string, Spring>())
  // id → {x,y,at}: a node that should MATERIALIZE at a specific spot (a hire
  // replacing its draft card) instead of gliding over from its parent. Lives
  // outside springs because the reaper below deletes any spring whose id the
  // layout doesn't know yet — and the hire response lands frames before the
  // refreshed tree does
  const seedRef = useRef(new Map<string, { x: number; y: number; at: number }>())
  // user feature 2026-08-26: initializing an agent opens ITS desk. The id of a
  // hire made HERE (this browser, from the draft form) that is still waiting
  // for its card to exist and settle; the spring tick below does the opening.
  // Same 10s stale bound as seedRef, and for the same reason — the hire
  // response lands frames before the tree that gives the node a position, and
  // a hire whose node never arrives must not strand a camera jump.
  const hireDeskRef = useRef<{ id: string; at: number } | null>(null)
  const targetRef = useRef(target); targetRef.current = target
  const mapRef = useRef(map); mapRef.current = map
  // The tree payload replaces ids on a full rename. Keep the prior projection
  // just long enough to distinguish that identity transition from a genuine
  // removal followed by a new hire. Explicit websocket rename mappings are
  // authoritative; session_id matching below is only a bounded fallback for
  // payloads that contain it (and is absent from kiosk payloads by design).
  const previousMapRef = useRef<Map<string, CanvasNode>>(new Map())
  const previousSlugRef = useRef(slug)
  const migrateRename = useCallback((from: string, to: string) => {
    if (!from || !to || from === to) return
    renamePin(slug, from, to)
    renameConvo(slug, from, to)
    migrateClientNodeState(slug, from, to)
    renameDrafts(slug, from, to)
    window.dispatchEvent(new window.CustomEvent('orgtree:desk-rename', { detail: { slug, from, to } }))
    setConfigId((v) => v === from ? to : v)
    setLineageId((v) => v === from ? to : v)
    setInboxId((v) => v === from ? to : v)
    setAgentDocketId((v) => v === from ? to : v)
    setSheetId((v) => v === from ? to : v)
  }, [slug])
  const nodeDrag = useRef<{
    id: string; sx: number; sy: number
    bases: Map<string, Pt>; moved: boolean
  } | null>(null)     // {id, sx, sy, ox, oy, moved}
  // mobile pointer bookkeeping (spec §2-⑥): a real per-pointerId map — the
  // desktop path keeps its single panRef untouched. Two pointers = pinch;
  // during a pinch panRef holds a moved:true sentinel so the spring-follow
  // and the tap path both yield (one guard vocabulary, not three).
  const pointersRef = useRef(new Map<number, Pt>())
  const pinchRef = useRef<{ d0: number; z0: number } | null>(null)
  const tapRef = useRef<{ x: number; y: number; t: number; target: Element | null } | null>(null)
  const hiddenRef = useRef(hidden); hiddenRef.current = hidden
  // desktop click-to-focus on the eye (see onPointerDown/onPointerUp): the
  // eye card no longer stops propagation on a bare press — see cards.tsx —
  // so a gesture that starts there now reaches here too. Recorded at
  // pointerDOWN time off the bubbled event's own target, not looked up by
  // world position at release: a stationary press either started on the eye
  // or it didn't, and that fact needs no camera geometry to state.
  const eyePressRef = useRef(false)

  const posOf = (id: string): Pt | undefined =>
    springs.current.get(id) ?? targetRef.current.get(id)

  // ---------------------------------------------- wires: geometry + sparks
  // (the seg builders assert posOf: every caller pre-checks both endpoints)
  const treeSeg = (parentId: string, childId: string): Seg => {
    const a = posOf(parentId)!, b = posOf(childId)!
    const ps = sizeOf(parentId)
    return { kind: 'c', pts: [
      { x: a.x + ps.w / 2, y: a.y + ps.h },
      { x: a.x + ps.w / 2, y: a.y + ps.h + 52 },
      { x: b.x + NODE_W / 2, y: b.y - 52 },
      { x: b.x + NODE_W / 2, y: b.y }] }
  }
  const peerSeg = (lId: string, rId: string): Seg => {
    const a = posOf(lId)!, b = posOf(rId)!
    return { kind: 'l', pts: [
      { x: a.x + sizeOf(lId).w, y: a.y + sizeOf(lId).h * 0.55 },
      { x: b.x, y: b.y + sizeOf(rId).h * 0.55 }] }
  }
  const audSeg = (gId: string, eId: string): Seg => {
    const a = posOf(gId)!, b = posOf(eId)!
    const ga = sizeOf(gId), gb = sizeOf(eId)
    // symmetrical about the grantor (user ruling, made for the overseer):
    // the line leaves the LEFT flank for grantees left of it and the RIGHT
    // flank for grantees right of it — no more always-rightward bulge
    const left = (b.x + gb.w / 2) < (a.x + ga.w / 2)
    const x1 = left ? a.x : a.x + ga.w
    const x2 = left ? b.x : b.x + gb.w
    const y1 = a.y + ga.h / 2, y2 = b.y + gb.h / 2
    const bulge = (64 + Math.abs(y2 - y1) * 0.12) * (left ? -1 : 1)
    return { kind: 'c', pts: [
      { x: x1, y: y1 }, { x: x1 + bulge, y: y1 },
      { x: x2 + bulge, y: y2 }, { x: x2, y: y2 }] }
  }

  const sparksRef = useRef<{
    id: number; segs: (Seg & { rev: boolean })[]; start: number; segDur: number
  }[]>([])
  const sparkId = useRef(0)
  const audSetRef = useRef(new Set<string>())
  audSetRef.current = new Set((tree.audiences ?? []).map((a) => a.grantor + '→' + a.grantee))

  // audience-line life cycle (user ruling): a NEW grant draws itself in,
  // grantor → grantee, over the same 420ms the message spark takes — the two
  // arrive at the new agent together; a REVOKED grant retracts the same way.
  const AUD_DUR = 420
  const audAnimRef = useRef(new Map<string,
    | { phase: 'in'; t0: number }
    | { phase: 'out'; t0: number; grantor: string; grantee: string }
  >())    // 'g→e' → {phase:'in'|'out', t0, grantor, grantee}
  const audPrevRef = useRef<Set<string> | null>(null)   // null until first sync: lines that
                                          // exist at page load never animate in
  const audRafRef = useRef<number | null>(null)
  const kickAudAnim = useCallback(() => {
    if (audRafRef.current) return
    const loop = () => {
      if (audAnimRef.current.size) {
        setFrame((f) => f + 1)
        audRafRef.current = requestAnimationFrame(loop)
      } else {
        audRafRef.current = null
      }
    }
    audRafRef.current = requestAnimationFrame(loop)
  }, [])
  useEffect(() => {
    const cur = audSetRef.current
    if (audPrevRef.current === null) { audPrevRef.current = new Set(cur); return }
    const prev = audPrevRef.current
    const anim = audAnimRef.current
    const now = performance.now()
    for (const k of cur) {
      if (!prev.has(k) && anim.get(k)?.phase !== 'in') anim.set(k, { phase: 'in', t0: now })
    }
    for (const k of prev) {
      if (!cur.has(k)) {
        const [grantor, grantee] = k.split('→') as [string, string] // nUIA: keys are always built as "<grantor>→<grantee>"
        anim.set(k, { phase: 'out', t0: now, grantor, grantee })
      }
    }
    audPrevRef.current = new Set(cur)
    if (anim.size) kickAudAnim()
  }, [tree.audiences, kickAudAnim])   // eslint-disable-line react-hooks/exhaustive-deps

  // a mail event rides the org's wires: down/up the tree, along the peer line
  // between coworkers, or along a direct audience line when one connects the two
  const launchSpark = useCallback((from: string, to: string) => {
    // compact map: sparks re-render the whole canvas at 60fps for 420ms per
    // mail — the worst paint on a mobile GPU for pure decoration (§5.1 perf)
    if (compactRef.current) return
    const m = mapRef.current
    const norm = (x: string) => (!x || x === 'user' || x === 'user_inbox' || x === USER) ? USER : x
    // org-inbox mail (user spec 2026-08-05): a spark rides the mailbox↔node
    // curve — the same facing-sides geometry the audience lines to holders
    // draw — in whichever direction the mail travels
    const isBox = (x: string) => x === 'org_inbox' || x === INBOX
    if (isBox(from) !== isBox(to)) {
      const other = norm(isBox(from) ? to : from)
      const at = posOf(INBOX), bt = posOf(other)
      if (!at || !bt || (other !== USER && !m.has(other))) return
      const ga = sizeOf(INBOX), gb = sizeOf(other)
      const left = (bt.x + gb.w / 2) < (at.x + ga.w / 2)
      const x1 = left ? at.x : at.x + ga.w
      const x2 = left ? bt.x + gb.w : bt.x
      const y1 = at.y + ga.h / 2, y2 = bt.y + gb.h / 2
      const bulge = 64 + Math.abs(y2 - y1) * 0.12
      sparksRef.current.push({
        id: ++sparkId.current,
        segs: [{ kind: 'c', pts: [
          { x: x1, y: y1 }, { x: x1 + (left ? -bulge : bulge), y: y1 },
          { x: x2 + (left ? bulge : -bulge), y: y2 }, { x: x2, y: y2 }],
          rev: !isBox(from) }],
        start: performance.now(), segDur: 420 })
      setFrame((f) => f + 1)
      return
    }
    const a = norm(from), b = norm(to)
    if (a === b) return
    // ⚠ presence in `m` is NOT a position (neoja org, 2026-08-12 — a crash,
    // not a cosmetic gap). The seg builders assert `posOf(id)!` and the
    // contract at the top of this block says every caller pre-checks BOTH
    // endpoints; this caller pre-checked the node map instead. A node that
    // the backend returns but `layout` never places — a live lineage bearer
    // whose successor is archived is the case that bit, since bearers are
    // positioned only relative to a positioned successor — then reached
    // `b.x` on undefined and took the WHOLE canvas down, deterministically,
    // on every spark to or from it. Refreshing could not help.
    //
    // The guard is on the ids actually used, not just the endpoints: the
    // tree path walks ancestors and the sibling path walks a row, and any
    // of those may be unplaced for the same reason. An unplaceable spark is
    // simply not drawn — the animation is decoration, and no decoration is
    // worth a blank canvas.
    const placed = (id: string) => posOf(id) !== undefined
    // D-200: watchdog mail originates at a satellite, not an agent. It is
    // deliberately absent from `map` (which only holds TreeNodes), so the
    // ordinary tree-route guard below would reject `dog:<id>` before it ever
    // asked whether the one-shot tombstone supplied a position. Its owner
    // tether is already a direct line; draw the spark on that same line.
    const aDog = a.startsWith('dog:'), bDog = b.startsWith('dog:')
    if (aDog || bDog) {
      const dog = aDog ? a : b
      const owner = aDog ? b : a
      if (!m.has(owner) || !placed(dog) || !placed(owner)) return
      const dp = posOf(dog)!, op = posOf(owner)!
      sparksRef.current.push({ id: ++sparkId.current, segs: [{ kind: 'l', pts: [
        { x: dp.x + DOG_W / 2, y: dp.y + 4 },
        { x: op.x + NODE_W / 2, y: op.y + NODE_H - 8 },
      ], rev: !aDog }], start: performance.now(), segDur: 420 })
      setFrame((f) => f + 1)
      return
    }
    if (!m.has(a) || !m.has(b)) return
    if (!placed(a) || !placed(b)) return
    const segs: (Seg & { rev: boolean })[] = []
    const aud = audSetRef.current
    if (aud.has(a + '→' + b) || aud.has(b + '→' + a)) {
      const [g, e] = aud.has(a + '→' + b) ? [a, b] : [b, a]
      segs.push({ ...audSeg(g, e), rev: g !== a })
    } else if (a !== USER && b !== USER && m.get(a)?.parent === m.get(b)?.parent) {
      const sibs = (m.get(m.get(a)!.parent!)?.children ?? []).map((c) => c.id)
        .filter((k) => m.has(k) && k !== DRAFT && placed(k))
        .sort((p, q) => (targetRef.current.get(p)?.x ?? 0) - (targetRef.current.get(q)?.x ?? 0))
      const ia = sibs.indexOf(a), ib = sibs.indexOf(b)
      if (ia < 0 || ib < 0) return
      const step = ia < ib ? 1 : -1
      for (let i = ia; i !== ib; i += step) {
        segs.push({ ...peerSeg(sibs[Math.min(i, i + step)]!, sibs[Math.max(i, i + step)]!), // nUIA: i walks ia..ib, both valid indices
          rev: step < 0 })
      }
    } else {
      const chain = (id: string) => {
        const out = [id]
        let c = id
        while (c !== USER) { c = m.get(c)?.parent ?? USER; out.push(c) }
        return out
      }
      const ca = chain(a), cb = chain(b)
      if (!ca.every(placed) || !cb.every(placed)) return
      const inB = new Set(cb)
      const lca = ca.find((k) => inB.has(k))!   // both chains end at USER
      for (let i = 0; ca[i] !== lca; i++) segs.push({ ...treeSeg(ca[i + 1]!, ca[i]!), rev: true }) // nUIA: lca ∈ ca ⇒ i+1 stays in range
      let prev = lca
      for (const k of cb.slice(0, cb.indexOf(lca)).reverse()) {
        segs.push({ ...treeSeg(prev, k), rev: false })
        prev = k
      }
    }
    if (!segs.length) return
    sparksRef.current.push({ id: ++sparkId.current, segs,
      start: performance.now(), segDur: 420 })
    setFrame((f) => f + 1)
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (mailEvt) launchSpark(mailEvt.from, mailEvt.to) },
    [mailEvt, launchSpark])
  useEffect(() => {
    window.__spark = launchSpark        // dev/demo hook
    return () => { if (window.__spark === launchSpark) delete window.__spark }
  }, [launchSpark])

  // org-relative credit scale: sole top-level holder = exactly one card
  // height; with many holders the TYPICAL bar ≈1.25× the card, the biggest
  // clamped at 1.6×. A bar spans the node's WHOLE holding (seat + grant,
  // seat block at the foot).
  // ⚠ Derived from TOP-LEVEL holdings ONLY (user ruling): sub-reallocations
  // re-partition circulation and must never move any other bar.
  const pxPerCredit = useMemo(() => orgPxc(tree), [tree])

  // The websocket carries the authoritative old→new mapping. This is needed
  // when a rename also changes session_id (compaction/reseed/provider handoff),
  // where the polling fallback below cannot safely infer identity.
  useEffect(() => {
    const onRename = (ev: Event) => {
      const d = (ev as CustomEvent<{ slug?: string; renames?: Record<string, string> }>).detail
      if (!d || d.slug !== slug || !d.renames) return
      Object.entries(d.renames).forEach(([from, to]) => migrateRename(from, to))
    }
    window.addEventListener('orgtree:rename', onRename)
    return () => window.removeEventListener('orgtree:rename', onRename)
  }, [migrateRename, slug])

  useEffect(() => {
    if (tree.slug !== slug) return
    if (previousSlugRef.current !== slug) {
      previousSlugRef.current = slug
      previousMapRef.current = map
      return
    }
    const previous = previousMapRef.current
    const oldBySession = new Map<string, string>()
    const sessionOf = (n: CanvasNode): string | null => {
      const sid = (n as CanvasNode & { session_id?: unknown }).session_id
      return typeof sid === 'string' && sid ? sid : null
    }
    for (const [id, n] of previous) {
      const sid = sessionOf(n)
      if (sid && !map.has(id)) oldBySession.set(sid, id)
    }
    for (const [id, n] of map) {
      const sid = sessionOf(n)
      const from = sid ? oldBySession.get(sid) : undefined
      if (!from || previous.has(id)) continue
      migrateRename(from, id)
    }
    previousMapRef.current = map
  }, [map, migrateRename, slug, tree.slug])

  // composer drafts are keyed per node id and freed slugs are re-minted by
  // later hires (review): sweep drafts whose node no longer exists at all,
  // so a namesake never inherits a dead agent's unsent instruction.
  // Archived nodes stay in `map` — their queued-until-rehire drafts survive.
  useEffect(() => {
    // ⚠ props can be mismatched for a commit: on an org switch `slug` is the
    // new org while `tree` is still the old payload (App swaps the tree only
    // when its fetch resolves, and this component is not keyed by slug). A
    // sweep in that window prunes the NEW org's storage against the OLD org's
    // node set — nearly everything. Only sweep when the two agree.
    if (tree.slug !== slug) return
    try {
      preserveRemovedDrafts(slug, map)
      const pre = `orgtree-draft-${slug}-`
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i)
        if (k && k.startsWith(pre) && !map.has(k.slice(pre.length))) {
          localStorage.removeItem(k)
        }
      }
    } catch { /* private mode */ }
  }, [map, slug, tree.slug])

  // G6: the SAME sweep for every other id-keyed client store. `orgtree-eyemin-`
  // (which direct lines are collapsed), `-eyeseen-` (which ones have been seen,
  // so a new one arrives minimized) and `-pile-` (which retiree fronts its
  // stack) all key on node ids and none of them was ever pruned. They grew
  // across the org's entire hire/fire history, and a pile front could name a
  // node that no longer exists. Client-owned state is legitimate — client-owned
  // state that outlives what it refers to is just a slower kind of stale.
  useEffect(() => {
    if (!map.size) return              // never prune against a not-yet-loaded tree
    if (tree.slug !== slug) return     // mismatched-props window — see the draft sweep
    try {
      for (const suffix of ['eyemin', 'eyeseen']) {
        const k = `orgtree-${suffix}-${slug}`
        const raw = localStorage.getItem(k)
        if (!raw) continue
        const ids = JSON.parse(raw) as string[]
        const keep = ids.filter((id) => map.has(id))
        if (keep.length !== ids.length) localStorage.setItem(k, JSON.stringify(keep))
      }
      const pk = `orgtree-pile-${slug}`
      const rawP = localStorage.getItem(pk)
      if (rawP) {
        const pf = JSON.parse(rawP) as Record<string, string>
        const keep = Object.fromEntries(Object.entries(pf)
          .filter(([parent, front]) => map.has(parent) && map.has(front)))
        if (Object.keys(keep).length !== Object.keys(pf).length) {
          localStorage.setItem(pk, JSON.stringify(keep))
        }
      }
    } catch { /* private mode, or a hand-edited value — never fatal */ }
    // `orgtree-pins-<slug>` (FR-3): a pinned window whose agent was DISSOLVED
    // (gone from the tree — a retired agent stays in `map` and keeps its
    // window). Same two guards above; a window vanishing deserves a word.
    for (const id of prunePins(slug, (id) => map.has(id))) {
      dropConvo(slug, id)
      toast([`${id} is gone from the org — its pinned window closed`])
    }
  }, [map, slug, tree.slug, toast])

  // ------------------------------------------------------- the spring engine
  useEffect(() => {
    let raf: number, last = performance.now()
    const tick = (t: number) => {
      const dt = Math.min(0.033, (t - last) / 1000); last = t
      let active = false
      for (const [id, tgt] of targetRef.current) {
        let s = springs.current.get(id)
        if (!s) {
          const seed = seedRef.current.get(id)
          if (seed) seedRef.current.delete(id)
          const par = mapRef.current.get(id)?.parent
          const ps = !seed && par && springs.current.get(par)
          s = seed ? { x: seed.x, y: seed.y, vx: 0, vy: 0 }
            : ps ? { x: ps.x, y: ps.y, vx: 0, vy: 0 }
                 : { x: tgt.x, y: tgt.y, vx: 0, vy: 0 }
          springs.current.set(id, s)
          active = true
        }
        if (nodeDrag.current?.moved && nodeDrag.current.bases?.has(id)) continue
        const ax = SPRING_K * (tgt.x - s.x) - SPRING_C * s.vx
        const ay = SPRING_K * (tgt.y - s.y) - SPRING_C * s.vy
        s.vx += ax * dt; s.vy += ay * dt
        s.x += s.vx * dt; s.y += s.vy * dt
        if (!atRest(s, tgt)) active = true
        else { s.x = tgt.x; s.y = tgt.y; s.vx = 0; s.vy = 0 }
      }
      for (const id of [...springs.current.keys()]) {
        if (!targetRef.current.has(id)) springs.current.delete(id)
      }
      for (const [id, sd] of seedRef.current) {   // a hire that never landed
        if (t - sd.at > 10000) seedRef.current.delete(id)
      }
      // self-heal native scroll: the viewport pans by transform only, but
      // focusing an off-screen element (a spawned draft's name input) makes
      // the browser scroll the overflow:hidden box — which shears the HUD and
      // tray off the canvas and corrupts every centerOn until reload
      const vpEl = viewportRef.current
      if (vpEl && (vpEl.scrollLeft || vpEl.scrollTop)) {
        vpEl.scrollLeft = 0
        vpEl.scrollTop = 0
      }
      // №25: the camera rides the focused desk. A hire ANYWHERE re-anchors
      // the whole layout (eye at x=6000), which used to slide the desk you
      // were typing into ~1000 screen px out of the window — follow the
      // focused node's per-frame spring delta instead. Camera animations and
      // manual pans own the view; the follow yields to them.
      //
      // ENGAGING ONLY AT REST. Cancelling the spring delta holds the node at a
      // FIXED SCREEN OFFSET — whatever offset it had on the frame the follow
      // engaged. That is the whole point while the layout re-anchors under a
      // settled node, and it is a trap the moment the follow engages on a node
      // still in flight: the distance the spring had left to travel is exactly
      // the distance the node is off-centre, and cancelling that motion freezes
      // it there for good. The card never arrives.
      //
      // The reachable case is a camera animation, because it suppresses the
      // follow while it runs and hands it back the instant it lands: centerOn
      // aims at the node's layout TARGET, so if the spring is still short of
      // that target when the glide ends, the follow engages on precisely the
      // gap and pins it. A fresh hire is the common way in — the card's birth
      // spring is still gliding in from the draft's seed.
      //
      // So gate ENGAGEMENT on the node having arrived. Once engaged it stays
      // engaged and rides every later disturbance exactly as before, which is
      // what keeps №25 intact; a node that is still travelling is simply left
      // alone to finish, and the camera holds still while it lands.
      const fid = focusRef.current
      if (fid && !animBusyRef.current && !panRef.current) {
        const s = springs.current.get(fid)
        const tgt = targetRef.current.get(fid)
        if (s && tgt) {
          const prev = followRef.current
          if (prev && prev.id === fid) {
            const dx = s.x - prev.x, dy = s.y - prev.y
            if (dx || dy) {
              const z = viewRef.current.z
              setView((v) => ({ ...v, x: v.x - dx * z, y: v.y - dy * z }))
            }
            followRef.current = { id: fid, x: s.x, y: s.y }
          } else if (atRest(s, tgt)) {
            followRef.current = { id: fid, x: s.x, y: s.y }
          }
        }
      } else {
        followRef.current = null
      }
      // a fresh hire opens its own desk (user feature 2026-08-26). The hire
      // response carries only an id: the card does not exist until the
      // refreshed tree lands, and its birth spring then glides in from the
      // draft's seed. BOTH have to finish before the camera moves —
      //  · no layout entry yet, and there is nothing to centre on;
      //  · a card still travelling is a card the camera would centre on where
      //    it is going to be, not where it is.
      // ⚠ The second half is now BELT-AND-BRACES, and deliberately kept. It
      // was load-bearing when written: the follow above froze whatever screen
      // offset it engaged at, so centring mid-glide left the card off-centre
      // permanently. `6ad71b3` fixed that at the source — the follow only
      // ENGAGES on a node that has arrived — so the freeze can no longer
      // happen here even without this wait (its author verified that by
      // removing this condition against the fix: green). Kept anyway, for one
      // reason worth more than the frame it costs: it makes this feature
      // correct on its own terms rather than by borrowing a guarantee from a
      // gate three blocks up that nothing here would notice losing. If you
      // remove it, `deskinit.test.tsx` §5 is the check that should fail.
      // Yields to a live gesture exactly as that follow does: a drag, a pinch
      // or another camera animation owns the view, and the hire waits a frame.
      const hd = hireDeskRef.current
      if (hd) {
        // (stamped and compared on the SAME clock — `performance.now()`, not
        // the rAF timestamp `t`. The two share an origin in a browser, so
        // either reads correctly there; only one of them does under a rig
        // whose rAF hands out a mocked `Date.now()`, and a bound that expires
        // instantly under test is a feature no test can reach.)
        if (performance.now() - hd.at > 10000) hireDeskRef.current = null
        else if (sheetGate()) {
          // the sheet IS the desk here (D-123/D-125) and needs no camera —
          // only a node the tree already knows about
          if (mapRef.current.has(hd.id)) {
            hireDeskRef.current = null
            setSheetId(hd.id)
          }
        } else if (!animBusyRef.current && !panRef.current) {
          // (the spring loop at the top of this same tick has already created
          // a spring for every laid-out id, so a target with no spring means
          // the card is not real yet — wait, don't centre on a phantom)
          // `atRest`, not a threshold of this block's own: arrival is defined
          // once, next to the loop that snaps on it, and the follow reads the
          // same predicate. The hand-rolled `|Δpos| < 1` that stood here was a
          // second spelling of the same idea AND a weaker one — position-only,
          // so it admitted a card travelling at speed through a near-target
          // frame, which is the one case where "settled" was most wrong.
          const tp = targetRef.current.get(hd.id)
          const sp = springs.current.get(hd.id)
          if (tp && sp && atRest(sp, tp)) {
            hireDeskRef.current = null
            centerRef.current?.(hd.id)
          }
        }
      }
      if (sparksRef.current.length) {
        const now = performance.now()
        sparksRef.current = sparksRef.current.filter(
          (sp) => now < sp.start + sp.segs.length * sp.segDur + 60)
        active = true
      }
      if (active || nodeDrag.current?.moved) setFrame((f) => f + 1)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ------------------------------------------------------------- camera math

  // THE CAMERA INVARIANT (user bug 2026-08-26 — "the drag location is updated
  // to a dramatically far away location, making all panels invisible").
  //
  // A background pan does not accumulate deltas; it re-derives the camera from
  // the origin captured at pointerdown, `x = ox + (clientX - sx)`. That makes
  // the pan authoritative over x/y for as long as a finger is down — so ANY
  // other writer of the camera must leave `ox/oy` agreeing with what it wrote,
  // or the very next pointermove silently reverts it. Reverting an x/y that
  // was computed for one zoom level back onto a different zoom level is not a
  // small jitter: the correct x for a world point is `mx - wx*z`, and wx runs
  // into the thousands (the eye sits at world x=6000), so a single wheel notch
  // mid-drag threw the world tens of thousands of px off-screen.
  //
  // Two writers are subject to this: the wheel (below) and animateTo (here).
  // pointerdown already cancels a running animation, so the animation case is
  // only reachable when a glide STARTS during a drag — which centerOn's buried
  // pile-member path does, by deferring itself two frames.
  //
  // Call this after every camera write, with the view actually written. The
  // pan continues from there, still carrying the delta the user has already
  // travelled (lx/ly - sx/sy).
  const rebasePan = useCallback((nv: View) => {
    const d = panRef.current
    if (!d) return
    d.ox = nv.x - (d.lx - d.sx)
    d.oy = nv.y - (d.ly - d.sy)
  }, [])

  const animateTo = useCallback((to: View, ms = 460) => {
    // every glide drops the intent; the command that ordered it re-asserts
    // afterwards, so an UNCLAIMED camera move releases the follow
    camIntent.current = null
    cancelAnimationFrame(animRef.current!)
    animBusyRef.current = true
    const from = { ...viewRef.current }
    const t0 = performance.now()
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms), e = ease(k)
      const nv = {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        z: from.z + (to.z - from.z) * e,
      }
      // the glide owns the camera frame by frame, so the re-base is per frame
      // too — and the ref write keeps a pointerdown landing mid-glide from
      // snapshotting a camera one commit out of date
      rebasePan(nv)
      viewRef.current = nv
      setView(nv)
      if (k < 1) animRef.current = requestAnimationFrame(step)
      else animBusyRef.current = false
    }
    animRef.current = requestAnimationFrame(step)
  }, [rebasePan])

  // w14aace89: the region every camera command aims at — the largest pin-free
  // rectangle of the viewport, chosen by AREA and INDEPENDENT of what is being
  // focused (user ruling 2026-09-05). Agent focus, the switchboard, full view
  // and zoom buttons therefore all agree on one visible free space; the target
  // is fitted or anchored inside it afterwards rather than choosing it.
  //
  // Pins are viewport-local (pins.tsx `clampRect` bounds x into [0, vp.w-w],
  // and PinLayer sets left/top straight from the rect), which is the same
  // space `focusView` already does its `vp.width / 2` arithmetic in — so they
  // drop in with no transform. Desktop only: `pinnedIds` above empties on
  // mobile, and so does this.
  //
  // ⚠ THE PINS COME THROUGH A REF ON PURPOSE. `focusView`/`fitView` are built
  // with an EMPTY dependency list, and `centerOn` -> the `focusAgent` effect
  // hangs off their identity. Depending on `pins` directly would rebuild those
  // callbacks every time a pin moved and re-fire that effect, snapping the
  // camera back to the focused agent mid-drag. Reading the latest pins through
  // a ref keeps the identities stable while still using current geometry.
  const pinRectsRef = useRef<PinRect[]>([])
  pinRectsRef.current = isMobile ? [] : [...pins.map((p) => p.rect), ...modalSurfaces.filter(p => p.org === slug && p.modal).map(p => p.rect)]
  // same reason as the rects above: `centerOn` is built with a stable identity
  // and must not be rebuilt every time a pin moves
  const pinnedIdsRef = useRef<Set<string>>(new Set())
  pinnedIdsRef.current = pinnedIds
  // MEASURED COST (review 2026-09-05): the search is 0.191 ms/call at PIN_MAX
  // = 8 pins with all-distinct edges, on a 1920x1080 viewport — 0.005 ms at
  // one pin. That is affordable once, but this is read from `nearestId` and
  // from the eye's render, both of which re-run on EVERY animation frame while
  // the camera glides. The region does not depend on the camera at all: only
  // on the viewport size and the pin geometry. So cache on exactly those, and
  // a whole glide costs one search instead of one per frame.
  const regionCache = useRef<{ key: string; val: Region } | null>(null)
  const regionOf = useCallback((vp: { width: number; height: number }): Region => {
    const box = { x: 0, y: 0, w: vp.width, h: vp.height }
    const key = `${vp.width}x${vp.height}|` + pinRectsRef.current
      .map((p) => `${p.x},${p.y},${p.w},${p.h}`).join(';')
    const hit = regionCache.current
    if (hit && hit.key === key) return hit.val
    // ⚠ AN UNMEASURED VIEWPORT IS NOT AN OBSTRUCTED ONE (regression caught by
    // swbrecenter.test.tsx). Before first paint — and under jsdom, which
    // reports every rect as zero — `getBoundingClientRect()` is 0x0.
    // `clearRegion` correctly calls a zero-area viewport 'blocked', because a
    // rectangle with no area genuinely holds nothing; but the CALLER must not
    // read "I have not measured yet" as "pins cover everything" and refuse to
    // move the camera. It reports the full box instead, which is exactly the
    // pre-w14aace89 behaviour for that case.
    if (box.w <= 0 || box.h <= 0) return { rect: box, status: 'full' }
    const val = clearRegion(box, pinRectsRef.current)
    regionCache.current = { key, val }
    return val
  }, [])

  // WHERE THE CANVAS'S OWN CONTROLS ANCHOR (user 2026-09-12, opt-in and off
  // by default). `regionOf` is already this app's answer to "what is left of
  // the canvas once pins and desks have taken their bite" - the camera, the
  // switchboard fit and the zoom origin all read it - so this reuses it
  // rather than deriving a second, quietly different rectangle.
  //
  // The dependencies ARE the region's own inputs: the measured viewport (a
  // ResizeObserver on the element, so app layout changes count too) and the
  // pinned windows and modal surfaces. That is what keeps the controls
  // following a pin as it is dragged, and `regionOf`'s cache means a repeat
  // call inside one glide costs nothing.
  const anchorPref = useCanvasAnchor()
  // ⚠ NOT `regionOf`, AND THE DIFFERENCE IS DELIBERATE (perf-review, 2026-09-12).
  // `regionOf` feeds the CAMERA, and it reads persisted pin geometry, which is
  // committed at pointer-up. That is right for a camera: it must not chase a
  // window the user is still dragging. It is wrong here, because these
  // controls are being placed relative to what the user can SEE right now —
  // with the persisted rect, dragging a desk from 400 to 600 wide left the
  // controls anchored at the old edge until the gesture ended.
  //
  // So: the same `clearRegion`, over the LIVE registry instead. `PinWindow`
  // publishes its clamped rect through `usePinSurface(slug, pin.id, rect,
  // false)` on every move, and modals publish theirs with `modal: true`; both
  // bound the canvas, so both are obstacles here.
  //
  // ⚠ AND NEVER BOTH COPIES OF ONE WINDOW. A persisted pin is only added when
  // its window has not registered a live rect yet — the first paint, before
  // any surface has mounted — because counting a desk twice at two different
  // sizes would carve the canvas up with a rectangle that is not on screen.
  const anchorObstacles = useMemo(() => {
    if (isMobile) return []
    const live = modalSurfaces.filter(p => p.org === slug)
    const registered = new Set(live.filter(p => !p.modal).map(p => pinSnapId(p)))
    return [...live.map(p => p.rect),
      ...pins.filter(p => !registered.has(p.id)).map(p => p.rect)]
  }, [pins, modalSurfaces, slug])
  const freeAnchor = useMemo(() => {
    if (!anchorPref.enabled || isMobile) return null
    if (!(viewportSize.w > 0 && viewportSize.h > 0)) return null
    const box = { x: 0, y: 0, w: viewportSize.w, h: viewportSize.h }
    return freeInsets(clearRegion(box, anchorObstacles), { w: viewportSize.w, h: viewportSize.h })
  }, [anchorPref.enabled, viewportSize, anchorObstacles])

  // the HUD ± buttons zoom about the FREE CANVAS CENTER — when pinned windows
  // bound the usable canvas, anchor on the center of the available bounded
  // rectangle (clearRegion), falling back to the whole viewport center when
  // unobstructed or blocked
  const zoomStep = useCallback((factor: number) => {
    const vp = viewportRef.current?.getBoundingClientRect()
    const v = viewRef.current
    const lim = compactRef.current ? { min: 0.3, max: 1.6 } : { min: 0.24, max: Z_MAX }
    const z = Math.min(lim.max, Math.max(lim.min, v.z * factor))
    if (!vp || z === v.z) return
    const reg = regionOf(vp)
    const r = reg.status !== 'blocked' && reg.rect.w > 0 && reg.rect.h > 0
      ? reg.rect : { x: 0, y: 0, w: vp.width, h: vp.height }
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2
    const wx = (cx - v.x) / v.z, wy = (cy - v.y) / v.z
    animateTo({ x: cx - wx * z, y: cy - wy * z, z }, 220)
  }, [animateTo, regionOf])

  // the camera that FOCUSES `id` — the desk (or, for the eye, the
  // switchboard) filling the viewport. Split from `centerOn` (D-228) so the
  // startup path can land there without a glide: the switchboard an org
  // opens on is the same switchboard the HUD eye button reaches, by
  // construction, because both ask this one function.

  /** The eye cell's WORLD width for a given region — ONE definition, shared by
   *  the camera, the eye-focus gate and the render, because they disagreeing
   *  is precisely the bug below.
   *
   *  ⚠ THE `USER_W` FLOOR IS WHY ASPECT ALONE IS NOT ENOUGH (browser probe
   *  §D, review 2026-09-05). In a region narrower than it is tall the
   *  aspect-derived width falls BELOW `USER_W` and is clamped up to it. The
   *  cell is then wider, relative to its height, than the region is — so a
   *  zoom chosen to fill the region's HEIGHT (as the old code did, height
   *  being the eye's only fit axis when it could always widen freely)
   *  overflows the region's WIDTH. Measured: an 811px-wide switchboard in a
   *  748px region, escaping 29px left and 31px right. The camera must
   *  therefore fit BOTH axes against this width. */
  const eyeWorldW = useCallback((r: { w: number; h: number } | null): number => {
    const h = r ? r.h - 48 : 0
    const raw = r && h > 0
      ? Math.round(USER_H * Math.max(1, r.w - 48) / h)
      : Math.round(USER_H * 16 / 9)
    return Math.max(raw, USER_W)
  }, [])

  const focusView = useCallback((id: string, z: number | null = null): View | null => {
    const p = targetRef.current.get(id)
    const vp = viewportRef.current?.getBoundingClientRect()
    if (!p || !vp) return null
    // entirely covered by pins: there is nowhere to put the card, so keep the
    // camera exactly where it is rather than animating somewhere invisible.
    // The caller says so (`focusBlocked` below); returning null is the same
    // "no camera" answer this function already gives for an unknown id.
    const reg = regionOf(vp)
    if (reg.status === 'blocked') return null
    const r = reg.rect
    // click-to-focus fills the window with the card, small margin all round.
    // The EYE fits on BOTH AXES against `eyeWorldW` (w14aace89). It used to
    // fit by HEIGHT ONLY, which was correct while it could widen freely to the
    // screen's aspect ratio — but its width is floored at USER_W, so in a
    // region narrower than it is tall the cell is relatively wider than the
    // space and a height-derived zoom overflowed sideways (measured in a
    // browser: an 811px switchboard in a 748px region).
    // audit 2026-08-01 (found by the mobile sweep, but a live DESKTOP bug):
    // on short/narrow windows the fit-derived zoom lands BELOW Z_DESK — the
    // camera animates and no desk (or switchboard) ever opens, silently.
    // Floor the focus zoom at the desk threshold: overflowing the viewport
    // beats a focus gesture that cannot focus.
    // …fitted into the free region rather than the whole viewport. With no
    // pins `r` IS the viewport, so this is byte-for-byte the previous camera.
    const zz = z ?? Math.max(Z_DESK, id === USER
      // the eye fits on BOTH axes against its real cell width — see
      // `eyeWorldW`. Height alone overflowed a tall/narrow region.
      ? Math.min(Z_MAX, (r.h - 48) / USER_H, (r.w - 48) / eyeWorldW(r))
      : Math.min(Z_MAX, (Math.min(r.w, r.h) - 48) / NODE_H))
    return {
      x: r.x + r.w / 2 - (p.x + NODE_W / 2) * zz,
      y: r.y + r.h / 2 - (p.y + NODE_H / 2) * zz,
      z: zz,
    }
  }, [eyeWorldW, regionOf])
  /** `onCanvas` is the ONE caller that means the canvas literally: the
   *  pinned window's own "Show on canvas" (user bug 2026-09-11). Every other
   *  jump stays generic and keeps preferring the open window. */
  const centerOn = useCallback((id: string, z: number | null = null,
    onCanvas = false) => {
    // ⚠ A PINNED AGENT'S DESTINATION IS ITS WINDOW, NOT ITS CARD. The card
    // renders a placeholder while the agent is pinned (`pinnedFocusId`), so
    // gliding there lands the reader on the placeholder while the real chat
    // sits somewhere else, unraised. Raise it instead — the same `showPin`
    // the placeholder and the switchboard tab already call.
    // …unless the reader ASKED FOR THE CANVAS. Then the placeholder is the
    // point: it is the card's designed pinned state, it says where the agent
    // sits in the org, and the window stays open and unraised behind it.
    if (!onCanvas && pinnedIdsRef.current.has(id)) {
      showPin(slug, id, vpSizeNow())
      return
    }
    // a HIDDEN retiree (hide-retired setting) is revealed by ANY jump to it —
    // desk-nav chips, tray rows, mail sender links, the retired-list token —
    // then the glide lands once the re-layout gives it a position. Archived
    // ancestors hidden with it are revealed too, or the card would have no
    // column to appear in. Same two-frame retry as the pile-front case below.
    if (prunedRef.current.has(id)) {
      const add: string[] = []
      let cur: string | undefined = id
      while (cur && prunedRef.current.has(cur)) {
        add.push(cur)
        cur = mapRef.current.get(cur)?.parent ?? undefined
      }
      setShownRetired((s) => new Set([...s, ...add]))
      requestAnimationFrame(() => requestAnimationFrame(() =>
        centerRef.current?.(id, z, onCanvas)))
      return
    }
    // focusing a BURIED pile member brings it to the front first (user spec
    // 2026-08-05), then finishes the glide once the re-layout gives it a
    // position (two frames: state commit, then layout)
    const pile = pileOfRef.current.get(id)
    if (pile && pile.front !== id) {
      setFront(pile.key, id)
      requestAnimationFrame(() => requestAnimationFrame(() =>
        centerRef.current?.(id, z, onCanvas)))
      return
    }
    const to = focusView(id, z)
    // w14aace89: a camera command that cannot be honoured must SAY SO. Silence
    // here is the bad outcome the whole item exists to fix — the old code
    // animated somewhere the card was invisible; refusing to move without a
    // word would be no better, just quieter.
    if (!to) {
      const vp = viewportRef.current?.getBoundingClientRect()
      if (vp && regionOf(vp).status === 'blocked') {
        toast(['the pinned windows cover the whole canvas — '
          + 'move or close one to focus there'])
      }
      return
    }
    // THE READABLE-DESK MINIMUM IS KEPT, NOT NEGOTIATED. focusView floors the
    // zoom at Z_DESK on purpose (audit 2026-08-01: overflowing beats a focus
    // gesture that cannot focus), so a cramped region does not silently
    // produce an unreadable desk — it produces a readable one that overflows
    // the free space. That is a deliberate trade the user cannot see from the
    // result alone, so name the cause once, here.
    const vpNow = viewportRef.current?.getBoundingClientRect()
    if (vpNow) {
      const reg = regionOf(vpNow)
      if (reg.status === 'reduced'
        && fitZoom(reg.rect, NODE_W, NODE_H, 48) < Z_DESK) {
        toast(['the pinned windows leave too little room for a full desk — '
          + 'showing it at readable size, overflowing behind them'])
      }
    }
    animateTo(to)
    // the focus STICKS: claim the camera back from `animateTo`, as `fitAll`
    // does for the whole org. After the glide starts, never before.
    camIntent.current = { kind: 'focus', id, z, onCanvas }
  }, [animateTo, focusView, regionOf, setFront, toast])

  /** the pinned window's "Show on canvas": navigate the CANVAS to the agent
   *  and leave the window open (user bug 2026-09-11 - it used to raise the
   *  window it was invoked from, which is where the reader already was). */
  const showOnCanvas = useCallback((id: string) => { centerOn(id, null, true) },
    [centerOn])

  // Re-aim an ALREADY FOCUSED target after the canvas changed under it.
  // NOT `centerOn`: a refit is not a focus gesture, so it reveals no hidden
  // retiree, re-fronts no pile, raises no pin and repeats none of centerOn's
  // toasts (a window drag fires this many times a second).
  const refocus = useCallback((id: string, z: number | null,
    onCanvas = false) => {
    // a STALE intent - target retired, hidden, or now a pinned window - is
    // dropped rather than fired at forever. A card the reader deliberately
    // showed ON THE CANVAS is not stale just because it is also pinned.
    if (!targetRef.current.has(id) || hiddenRef.current.has(id)
      || (!onCanvas && pinnedIdsRef.current.has(id))) {
      camIntent.current = null
      return
    }
    const to = focusView(id, z)
    // pins cover everything: hold still but KEEP the intent, so moving a
    // window off again re-fits
    if (!to) return
    animateTo(to, 320)     // the same glide length the whole-org refit uses
    camIntent.current = { kind: 'focus', id, z, onCanvas }
  }, [animateTo, focusView])
  const centerRef = useRef<typeof centerOn | null>(null)
  centerRef.current = centerOn

  // ---- canonical references, wherever the canvas renders prose
  //
  // The canvas is the one surface that can reach all four destinations: it
  // holds the mail router, the document reader and the camera, and the shell
  // above it owns the docket. So `handles` is full here — except for `item`,
  // which follows `onWorkItem` the way it does everywhere else, because the
  // docket is not ours to open if nobody handed us the route.
  //
  // ⚠ NO ITEM OR DOCUMENT INDEX. The canvas holds neither list; the docket
  // states an item it does not have and the reader reports a document it
  // cannot fetch. Agents and node mailboxes it CAN answer for, from `map`.
  //
  // ⚠ `centerRef`, NOT `centerOn`. The camera takes (id, zoom) and reads
  // `zoom ?? fit`, so anything non-null in the second argument becomes the
  // zoom; every route here passes exactly one.
  const canvasRefs = useRefRoutes(slug, map, {
    onOpenItem: onWorkItem ? (s: string) => onWorkItem(s) : undefined,
    onFocusAgent: (id: string) => { centerRef.current?.(id) },
    onOpenDoc: (id: string) => setDocView(id),
    onOpenMail: (r: TypedRef) => { openMailRef.current?.(mailRefTarget(r)) },
    // the canvas is not AT any agent, so every name here is somewhere to
    // go; it can say what each one is running
    tierOf: (id: string) => map.get(id)?.tier,
  })
  // the DOCUMENT READER's own copy: same world, same routes, plus the one
  // thing that belongs to the reader rather than to the canvas — a document
  // opening another document SWAPS the reader, while everything else lives
  // BEHIND it, so the reader closes first or the click looks like it did
  // nothing.
  const docRefs = useMemo(() => ({
    world: canvasRefs.world,
    onOpen: (r: ResolvedRef) => {
      if (r.ref.kind === 'doc') { setDocView(r.ref.id); return }
      setDocView(null)
      canvasRefs.onOpen(r)
    },
  }), [canvasRefs])

  useEffect(() => {
    if (!focusAgent) return
    if (hidden.has(focusAgent)) {
      const par = map.get(focusAgent)?.parent
      const node = map.get(focusAgent)
      if (par && node) {
        setFront(par + (node.state === 'archived' ? '|a' : '|c'), focusAgent)
      }
    }
    if (sheetGate()) {
      setSheetId(focusAgent)
    } else {
      centerOn(focusAgent)
    }
    onFocusAgentHandled?.()
  }, [focusAgent, map, hidden, setFront, centerOn, onFocusAgentHandled])

  // a REAL fit: the camera that puts the whole org inside the actual viewport
  const fitView = useCallback((): View | null => {
    const vp = viewportRef.current?.getBoundingClientRect()
    if (!vp) return null
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0
    for (const p of targetRef.current.values()) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + NODE_W + 40); maxY = Math.max(maxY, p.y + NODE_H + 40)
    }
    // same free region as focusView (w14aace89) — one region, every command
    const reg = regionOf(vp)
    if (reg.status === 'blocked') return null
    const r = reg.rect
    if (!isFinite(minX)) return null
    // extra top margin: the eye's infinite bar fades 110px above its card.
    // №23: NO zero-clamp — past ~64 leaf columns the leftmost nodes go
    // negative (the eye is pinned at x=6000) and a clamp silently cut them
    // out of "fit all"
    minX -= 60; minY -= 130
    const z = Math.min(1.3, Math.max(0.24,
      Math.min((r.w - 48) / (maxX - minX), (r.h - 48) / (maxY - minY))))
    return {
      x: r.x + (r.w - (maxX - minX) * z) / 2 - minX * z,
      y: r.y + (r.h - (maxY - minY) * z) / 2 - minY * z,
      z,
    }
  }, [regionOf])
  const fitAll = useCallback((animate = true, ms = 320) => {
    const to = fitView()
    if (!to) {
      // same rule as centerOn: only the fully-covered case is worth a word,
      // and only when a viewport exists at all (fitView also returns null
      // before first layout and for an empty org, which are not obstructions)
      const vp = viewportRef.current?.getBoundingClientRect()
      if (vp && regionOf(vp).status === 'blocked') {
        toast(['the pinned windows cover the whole canvas — '
          + 'move or close one to fit the org here'])
      }
      return
    }
    if (animate) animateTo(to, ms)
    else { viewRef.current = to; setView(to) }
    camIntent.current = { kind: 'org' }
  }, [animateTo, fitView, regionOf, toast])
  // mobile zoom range (spec §5.1): compact retires Z_DESK — the map never
  // reaches desk zoom, so the camera-derived focusId never fires and the
  // sheet is the only desk. Desktop keeps [0.24, Z_MAX] untouched.
  const zLim = () => compactRef.current
    ? { min: 0.3, max: 1.6 } : { min: 0.24, max: Z_MAX }
  // mobile spec §2-⑦: nothing re-ran on resize — on rotate the camera math
  // targeted the old rect forever. Mobile-only: re-render on any resize and
  // re-fit the camera once it settles (visualViewport covers the iOS soft
  // keyboard, where window.resize never fires).
  useEffect(() => {
    if (!isMobile) return
    let t: ReturnType<typeof setTimeout> | null = null
    const onR = () => {
      setVpTick((v) => v + 1)
      if (t) clearTimeout(t)
      t = setTimeout(() => { fitAll(false) }, 250)
    }
    window.addEventListener('resize', onR)
    window.visualViewport?.addEventListener('resize', onR)
    return () => {
      if (t) clearTimeout(t)
      window.removeEventListener('resize', onR)
      window.visualViewport?.removeEventListener('resize', onR)
    }
  }, [fitAll])
  // sub-panels reset whenever the sheet's subject changes or it closes
  useEffect(() => { setSheetDogs(false); setHireOpen(false) }, [sheetId])
  // the hardware/gesture BACK closes the sheet before leaving the org (spec
  // §5.2): opening pushes a history entry; back pops it and closes; closing
  // via ✕ consumes the entry so the next back doesn't no-op visibly
  useEffect(() => {
    if (!sheetId || !isMobile) return
    window.history.pushState({ sheet: sheetId }, '')
    const onPop = () => setSheetId(null)
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      const st: unknown = window.history.state
      if (st && typeof st === 'object' && (st as { sheet?: string }).sheet === sheetId) {
        window.history.back()
      }
    }
  }, [sheetId])
  // opening an org (D-228): where the camera lands, and whether it glides.
  //   'org'          the whole tree           — the historical default
  //   'switchboard'  the eye's desk           — same camera the HUD eye reaches
  //   'remember'     wherever it was last     — restored exactly, never a glide
  // The glide ("wake on the eye, then drift") is the zoom toggle's business
  // for the first two. 'remember' consults it never: a saved camera comes
  // back as-is, and an org this browser has NO camera for — a new org, or
  // the first open since the setting existed — plays the intro once anyway,
  // because there is nothing to restore and the drift is how the org shows
  // its shape. Wheel and drag both cancel the shared camera animation, so
  // the intro is interruptible at any moment. Keyed on the LOADED org's slug
  // — switching orgs keeps this component mounted, so a mount-only intro
  // left the camera wherever the previous org parked it and the drift ran
  // from way off-tree.
  useEffect(() => {
    const vp = viewportRef.current?.getBoundingClientRect()
    const eye = targetRef.current.get(USER)
    if (!vp || !eye) { fitAll(false); return }
    const mode = startView()
    camIntent.current = null
    // an org SWITCH restores the org's saved camera whatever the start-view
    // mode; only the session's first org keeps the configured intro (an org
    // with no saved camera still introduces itself below, as in 'remember')
    if (firstCanvasSlug === null) firstCanvasSlug = tree.slug
    else if (firstCanvasSlug !== tree.slug) leftFirstOrg = true
    const saved = mode === 'remember' || leftFirstOrg ? savedView(tree.slug) : null
    if (saved) {
      viewRef.current = saved
      setView(saved)
      return
    }
    // the switchboard is a desk, and compact never reaches desk zoom (§5.1:
    // the sheet is the only desk there) — so on a phone it opens on the org
    const swb = mode === 'switchboard' && !compactRef.current
      ? focusView(USER) : null
    const dest = swb ?? fitView()
    if (!dest) return
    // the intent records where the camera ACTUALLY went, hence `swb` rather
    // than the mode: a switchboard focus refused by pins fell back to the fit
    const intent: CamIntent = swb ? { kind: 'focus', id: USER, z: null } : { kind: 'org' }
    camIntent.current = intent
    if (mode !== 'remember' && !startZoomOn()) {
      viewRef.current = dest
      setView(dest)
      return
    }
    const z0 = 1.6                       // close, but under the desk threshold
    const v0 = {
      x: vp.width / 2 - (eye.x + USER_W / 2) * z0,
      y: vp.height / 2 - (eye.y + USER_H / 2) * z0,
      z: z0,
    }
    // write the ref FIRST: the rAF'd glide reads viewRef for its start frame,
    // and if it fires before React commits setView the drift would launch
    // from the stale camera instead of the eye
    viewRef.current = v0
    setView(v0)
    const raf = requestAnimationFrame(() => { animateTo(dest, 1700); camIntent.current = intent })
    return () => cancelAnimationFrame(raf)
  }, [tree.slug])   // eslint-disable-line react-hooks/exhaustive-deps

  // A late inbox/roster payload can move the whole tree after its opening
  // fit. Restored modal pins register after the opening camera effect too.
  // Keep the REQUESTED camera honoured as layout, pins or viewport change;
  // manual pan/zoom relinquishes that intent, and focusing something else
  // retargets it.
  useEffect(() => {
    // THE AVAILABLE CANVAS: the viewport box (a ResizeObserver on the
    // ELEMENT, so app layout changes count, not just window.resize) plus the
    // pinned windows and modals that eat into it. These are exactly
    // `regionOf`'s inputs, so this changes when the free region can have.
    const canvas = `${viewportSize.w}:${viewportSize.h}|pins:` + pinRectsRef.current
      .map(p => `${p.x}:${p.y}:${p.w}:${p.h}`).join('|')
    // ...plus the org's own extent, the other half of a whole-org fit
    const whole = canvas + '|nodes:' + [...target]
      .map(([id, p]) => `${id}:${p.x}:${p.y}`).join('|')
    const previous = fitGeometry.current
    fitGeometry.current = { slug: tree.slug, canvas, whole }
    const intent = camIntent.current
    if (!previous || previous.slug !== tree.slug || !intent) return
    if (intent.kind === 'org') {
      if (previous.whole !== whole) fitAll()
      return
    }
    // A FOCUSED DESK RIDES THE AVAILABLE CANVAS, NOT THE TREE: its size is
    // fixed, so only the space it is fitted INTO can un-fit it. Keying this
    // on the tree too would let any unrelated update move the camera while
    // the user reads (measured: 524px on a hire three branches away). A
    // focused card that MOVES is already handled by the per-frame spring
    // follow (No25), which translates the camera with it.
    // ⚠ the `isMobile` half is INERT in this build - `mobile.tsx` exports
    // `isMobile = false` outright - and is kept only so that restoring it
    // does not set this follow fighting the rotate refit above. It guards
    // nothing today; do not read it as a tested branch.
    if (isMobile || previous.canvas === canvas) return
    refocus(intent.id, intent.z, intent.onCanvas)
  }, [target, tree.slug, viewportSize.w, viewportSize.h, pins, modalSurfaces, isMobile, fitAll, refocus])

  // …and the camera is REMEMBERED (D-228), whatever the startup mode: the
  // position is saved in every mode so that switching to 'remember' later
  // finds one, rather than treating a long-lived org as brand new. Debounced,
  // because a pan or a glide writes the view every frame — so a glide in
  // flight never lands a mid-air frame; the write happens once the camera
  // has held still. The pending write is landed — not dropped — when the org
  // changes underneath it (that is the previous org's "where I left off")
  // and on pagehide (a closed tab is exactly the case the setting exists
  // for).
  // ⚠ reads `viewRef`, not `view`: on an org switch the intro effect above
  // has already re-aimed the ref for the NEW slug in this same commit, while
  // the `view` state still holds the OLD org's camera for one render.
  // ⚠ NO FLUSH ON UNMOUNT. It looked free, and it was the bug the browser
  // probe caught: under StrictMode's dev double-mount the cleanup ran
  // between the intro effect's two runs, wrote the eye-park frame under the
  // slug, and the second run "restored" it — an org that never glided. The
  // last 250ms before a deliberate leave is not worth a write that can race
  // the intro; pagehide covers the case that matters.
  const saveRef = useRef<{ slug: string; view: View; t: ReturnType<typeof setTimeout> } | null>(null)
  const flushSave = useCallback(() => {
    const p = saveRef.current
    if (!p) return
    clearTimeout(p.t)
    saveRef.current = null
    saveView(p.slug, p.view)
  }, [])
  useEffect(() => {
    const p = saveRef.current
    if (p && p.slug !== slug) flushSave()
    else if (p) clearTimeout(p.t)
    const v = viewRef.current
    saveRef.current = {
      slug, view: v,
      t: setTimeout(() => { saveRef.current = null; saveView(slug, v) }, 250),
    }
  }, [view, slug, flushSave])
  useEffect(() => {
    window.addEventListener('pagehide', flushSave)
    return () => window.removeEventListener('pagehide', flushSave)
  }, [flushSave])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // wheel inside a modal always scrolls the modal. Inside a desk it NEVER
      // zooms (user ruling, reversing the earlier fall-through-to-zoom): the
      // wheel is scroll-only there, even when nothing can scroll — zoom by
      // moving the cursor off the desk first.
      // (native listener — it fires before React's delegated handlers, so
      // component-level stopPropagation can't guard it)
      if ((e.target as Element | null)?.closest?.('.overlay')) return
      if ((e.target as Element | null)?.closest?.('.desk-over')) return
      // the agents tray is a real scroll container (.tray, overflow-y:auto) —
      // same carve-out as .overlay/.desk-over, or this native listener (fires
      // ahead of React, so a component-level stopPropagation can't reach it)
      // preventDefaults every wheel over it and the canvas zooms instead of
      // the list scrolling
      if ((e.target as Element | null)?.closest?.('.tray')) return
      // a PINNED desk window (pins.tsx) renders `bare`, i.e. WITHOUT
      // .desk-over — so it needs its own carve-out here or scrolling its
      // chat zooms the canvas underneath it
      if ((e.target as Element | null)?.closest?.('.pinwin')) return
      e.preventDefault()
      camIntent.current = null
      cancelAnimationFrame(animRef.current!)
      animBusyRef.current = false
      const v = viewRef.current
      const factor = Math.exp(-e.deltaY * 0.0012)
      const z = Math.min(Z_MAX, Math.max(0.24, v.z * factor))
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left, my = e.clientY - r.top
      const wx = (mx - v.x) / v.z, wy = (my - v.y) / v.z
      const nv = { x: mx - wx * z, y: my - wy * z, z }
      // zooming MID-DRAG: keep the pan's origin agreeing with the camera this
      // zoom just wrote, or the next pointermove reverts it — see the camera
      // invariant above rebasePan. This is the doorway the user's bug came in.
      rebasePan(nv)
      // synchronous ref coherence, same reason as the pinch path below: several
      // wheel events can land inside one commit, and each must zoom off the
      // LAST write rather than the last render or the notches cancel out
      viewRef.current = nv
      setView(nv)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [rebasePan])   // stable (useCallback []) — the listener still attaches once

  const toWorld = (e: { clientX: number; clientY: number }): Pt => {
    const r = viewportRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (e.clientX - r.left - v.x) / v.z, y: (e.clientY - r.top - v.y) / v.z }
  }

  // background pan (+ mobile pinch/tap — desktop keeps the exact old path)
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    camIntent.current = null
    cancelAnimationFrame(animRef.current!)
    animBusyRef.current = false
    if (isMobile) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointersRef.current.size === 2) {
        // second finger: any pan/tap in flight ABORTS (spec §2-⑥c) and the
        // gesture becomes a pinch. The sentinel panRef keeps the follow off.
        const [a, b] = [...pointersRef.current.values()] as [Pt, Pt]
        pinchRef.current = { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: viewRef.current.z }
        panRef.current = { sx: 0, sy: 0, lx: 0, ly: 0, ox: 0, oy: 0, moved: true }
        tapRef.current = null
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
      // remember the touch for tap arbitration on release — cards take no
      // capture on mobile, so a finger landing on one can still pan (§2-⑤)
      tapRef.current = { x: e.clientX, y: e.clientY, t: performance.now(),
        target: e.target as Element }
    }
    eyePressRef.current = !isMobile && !!(e.target as Element).closest('.sq.user')
    panRef.current = { sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY,
      ox: viewRef.current.x, oy: viewRef.current.y, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile && pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }
    if (pinchRef.current) {
      if (pointersRef.current.size < 2) return
      const [a, b] = [...pointersRef.current.values()] as [Pt, Pt]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const pin = pinchRef.current
      if (d <= 0 || pin.d0 <= 0) return
      const lim = zLim()
      const z = Math.min(lim.max, Math.max(lim.min, pin.z0 * (d / pin.d0)))
      const r = viewportRef.current?.getBoundingClientRect()
      if (!r) return
      const v = viewRef.current
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top
      const wx = (mx - v.x) / v.z, wy = (my - v.y) / v.z
      const nv = { x: mx - wx * z, y: my - wy * z, z }
      // synchronous ref coherence (§2-⑥b): several moves land per commit at
      // 120Hz, and each must compute from the LAST write, not the last render
      viewRef.current = nv
      setView(nv)
      return
    }
    const d = panRef.current
    if (!d) return
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy
    // where the pointer is NOW — rebasePan needs it to work out how much of
    // the gesture is already spent when some other writer moves the camera
    d.lx = e.clientX; d.ly = e.clientY
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    if (d.moved) setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }))
  }
  const onPointerUp = (e?: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile && e) {
      pointersRef.current.delete(e.pointerId)
      if (pinchRef.current) {
        if (pointersRef.current.size < 2) { pinchRef.current = null; panRef.current = null }
        return
      }
      // tap arbitration: a still finger that landed on a card opens it —
      // as the full-screen sheet under the D-123 gate, or the classic
      // zoom-to-desk glide on larger tablets. Interactive elements (buttons,
      // the mailbox tile, piles, chips) already handle their own clicks.
      const tap = tapRef.current
      tapRef.current = null
      if (tap && !panRef.current?.moved && e.type !== 'pointercancel'
          && performance.now() - tap.t < 600
          && !tap.target?.closest(
            'button, input, textarea, select, a, .wd-chip, .sq.orginbox, '
            + '.desk-over, .overlay, .cbar, .hsof, .doc-chips, .pile-stack')) {
        const w = toWorld({ clientX: tap.x, clientY: tap.y })
        let hit: string | null = null
        for (const [id] of targetRef.current) {
          if (id === DRAFT || id === INBOX || id.startsWith('dog:')) continue
          if (hiddenRef.current.has(id)) continue
          if (!mapRef.current.has(id)) continue
          const p = posOf(id)
          if (!p) continue
          const { w: cw, h: ch } = sizeOf(id)
          if (w.x >= p.x && w.x <= p.x + cw && w.y >= p.y && w.y <= p.y + ch) { hit = id; break }
        }
        if (hit === USER) {
          // compact hides the switchboard (§5.1) — the eye tap opens the
          // user inbox instead; tablets keep the zoom-in
          if (compactRef.current) onInbox?.()
          else centerOn(USER)
        } else if (hit && mapRef.current.get(hit)?.state !== 'draft') {
          if (sheetGate()) setSheetId(hit)
          else centerOn(hit)
        }
      }
    } else if (e && !isMobile && eyePressRef.current && !panRef.current?.moved
        && e.type !== 'pointercancel' && focusId !== USER) {
      // desktop click-to-focus on the eye. UserNode's own onPointerDown no
      // longer unconditionally stops propagation — a plain press there must
      // still be able to become a background pan (user bug 2026-09-03: "I
      // can drag for a fraction of a second, but my mouse lets go after only
      // a few pixels" — the eye sits centrally in the layout, a natural
      // place to grab to pan, and its old stopPropagation killed that
      // gesture before it ever reached this handler). But every pointerdown
      // here also calls setPointerCapture on the viewport, and once that
      // capture is live, UserNode's OWN onPointerUp — a descendant of the
      // now-capturing element — never fires again for this pointer: bubble
      // dispatch only walks up from the capturing element, not through it.
      // So a stationary click that lands on the eye has to be recognised
      // here instead, the same way mobile's tap arbitration above already
      // recognises one landing on any card — off `eyePressRef` (where the
      // gesture STARTED), not a world-position hit-test at release: this
      // path runs on every plain pointerup, including ones nowhere near the
      // eye, and geometry would also misfire the instant the eye's own
      // layout slot is reused by a pan that lands another node under the
      // release point.
      centerOn(USER)
    }
    // The flag describes where THIS gesture started, so it ends with the
    // gesture. It used to be written only in onPointerDown — and a press on
    // an agent card never gets there (startNodeDrag stops propagation), while
    // the card's release DOES bubble up to this handler. So one eye click left
    // `true` behind, and once the switchboard was zoomed away from (the
    // `focusId !== USER` guard above closes only while it is open), every
    // later agent click glided to the agent and then, from here, to the eye —
    // until a press on the empty canvas rewrote the flag. User bug 2026-09-07
    // 11:23Z: "clicking any agent focuses the switchboard; dragging the canvas
    // fixes it". eyepressleak.test.tsx.
    eyePressRef.current = false
    panRef.current = null
  }

  // ----------------------------------------------------------- node dragging
  const descendantsOf = (id: string) => {
    const out = new Set<string>()
    const walk = (k: string) => mapRef.current.get(k)?.children.forEach((c) => { out.add(c.id); walk(c.id) })
    walk(id)
    return out
  }

  const dropTargetAt = (world: Pt, dragId: string): string | null => {
    const banned = descendantsOf(dragId); banned.add(dragId); banned.add(DRAFT)
    // C0: the org-inbox panel is a drop target too — dropping an agent on it
    // GRANTS the org-inbox audience (reorder-style interaction, user ruling).
    // posOf(INBOX) exists only while the panel is laid out (= visible), which
    // keeps this check ref-safe inside a drag.
    {
      const p = posOf(INBOX)
      if (p) {
        const { w, h } = sizeOf(INBOX)
        if (world.x >= p.x && world.x <= p.x + w
          && world.y >= p.y && world.y <= p.y + h) return INBOX
      }
    }
    for (const [id] of targetRef.current) {
      if (banned.has(id)) continue
      const n = mapRef.current.get(id)
      if (id !== USER && n?.state !== 'live') continue
      const p = posOf(id)!
      const { w, h } = sizeOf(id)
      if (world.x >= p.x && world.x <= p.x + w && world.y >= p.y && world.y <= p.y + h) return id
    }
    return null
  }

  const startNodeDrag = (e: React.PointerEvent<HTMLDivElement>, id: string) => {
    if (e.button !== 0) return
    // mobile: drag-to-reparent/reorder is desktop-only (spec §6 — no hover
    // preview, no unoccluded drop target, no cheap escape under a finger).
    // No capture and no stopPropagation: the press bubbles to the viewport,
    // which pans on move and opens the card on a still release.
    if (isMobile) return
    // UX7: `.hsof-bridge` is a DOM child of `.sq` positioned OUTSIDE the
    // card's box with unconditional pointer-events, so a press on it (open
    // canvas beside the card, visually) bubbled here and dragged the whole
    // subtree. Excluded like `.cbar`/`.desk-body`; hover reach is unchanged.
    if ((e.target as Element).closest('button, input, textarea, select, .cbar, .desk-body, .hsof-bridge')) return
    if (mapRef.current.get(id)?.isBearerOf) {   // lineage cards are not org nodes
      e.stopPropagation()
      nodeDrag.current = { id, sx: e.clientX, sy: e.clientY, bases: new Map(), moved: false }
      return
    }
    e.stopPropagation()
    // the grabbed node carries its FULL subtree (user ruling) — record every
    // member's position so they all move as one rigid group
    const bases = new Map<string, Pt>()
    for (const k of [id, ...descendantsOf(id)]) {
      const p = posOf(k)
      if (p) bases.set(k, { x: p.x, y: p.y })
    }
    nodeDrag.current = { id, sx: e.clientX, sy: e.clientY, bases, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const moveNodeDrag = (e: React.PointerEvent<HTMLDivElement>, id: string) => {
    const d = nodeDrag.current
    if (!d || d.id !== id) return
    const z = viewRef.current.z
    // №23: edge-pan — in a wide org, drag source and target don't fit one
    // screen and the drag used to dead-stop at the window edge. Nearing an
    // edge pans the camera; the pan shifts the world under the cursor, so
    // it also counts into the node's drag delta (sx/sy compensate).
    const vp = viewportRef.current?.getBoundingClientRect()
    if (vp) {
      const M = 48, SPEED = 14
      let px = 0, py = 0
      if (e.clientX < vp.left + M) px = SPEED
      else if (e.clientX > vp.right - M) px = -SPEED
      if (e.clientY < vp.top + M) py = SPEED
      else if (e.clientY > vp.bottom - M) py = -SPEED
      if (px || py) {
        setView((v) => ({ ...v, x: v.x + px, y: v.y + py }))
        d.sx += px; d.sy += py
      }
    }
    const dx = (e.clientX - d.sx) / z, dy = (e.clientY - d.sy) / z
    if (Math.abs(dx) + Math.abs(dy) > 5 / z) d.moved = true
    if (!d.moved) return
    for (const [k, b] of d.bases) {
      const s = springs.current.get(k)
      if (s) { s.x = b.x + dx; s.y = b.y + dy; s.vx = 0; s.vy = 0 }
    }
    setDropId(dropTargetAt(toWorld(e), id))
  }
  const abortNodeDrag = (_e: React.PointerEvent<HTMLDivElement>, id: string) => {
    // pointercancel path: restore the recorded bases and commit NOTHING —
    // see the NodeSquare comment (a cancel routed through endNodeDrag's
    // no-drop branch issued an unconditional reorder POST)
    const d = nodeDrag.current
    if (!d || d.id !== id) return
    nodeDrag.current = null
    setDropId(null)
    for (const [k, b] of d.bases) {
      const s = springs.current.get(k)
      if (s) { s.x = b.x; s.y = b.y; s.vx = 0; s.vy = 0 }
    }
    setFrame((f) => f + 1)
  }
  const endNodeDrag = (e: React.PointerEvent<HTMLDivElement>, id: string,
    node: CanvasNode, focused: boolean) => {
    const d = nodeDrag.current
    if (!d || d.id !== id) return
    nodeDrag.current = null
    const drop = dropId
    setDropId(null)
    if (!d.moved) {                       // a plain click → walk to the desk
      if (!focused && id !== USER && node.state !== 'draft') centerOn(id)
      return
    }
    if (node.state === 'draft' || id === USER) return
    const parent = mapRef.current.get(id)?.parent
    const ancestors: string[] = []
    let cur = parent
    while (cur != null) { ancestors.push(cur); cur = mapRef.current.get(cur)?.parent }

    const finish = () => setFrame((f) => f + 1)   // springs glide back/onward
    if (drop === INBOX) {
      // dropping on the mailbox grants the org-inbox audience, never reparents
      audienceAction(slug, 'grant', id, 'extern')
        .then(() => toast([`${id} now reads and answers the org inbox`],
          () => audienceAction(slug, 'revoke', id, EXTERN).catch(() => {})))
        .catch((err: Error) => toast([`error: ${err.message}`]))
        .finally(finish)
      return
    }
    if (drop && drop !== parent) {
      const body = drop === USER
        ? { op: 'promote', node: id, new_parent: null }
        : ancestors.includes(drop)
          ? { op: 'promote', node: id, new_parent: drop }
          : { op: 'demote', node: id, new_parent: drop }
      // №17: a re-parent is one mis-drag away — the toast carries the reverse
      op(body).then(() => toast(
        [`${id} now reports to ${drop === USER ? 'you' : drop}`],
        () => op({ op: 'move', node: id, new_parent: parent ?? null })
          .catch(() => {})))
        .catch(() => {}).finally(finish)
      return
    }
    // no (new) target → cosmetic reorder among the current cohort by dropped x
    const cohort = (mapRef.current.get(parent!)?.children ?? [])
      .map((c) => c.id).filter((k) => k !== DRAFT)
    // RETIRED STACK (user note 2026-08-06): dragging the front drags the
    // WHOLE stack — every member moves as one contiguous block in canonical
    // (child-list) order, committed member-by-member behind the same anchor.
    // Anchors are always NON-members: buried cards are invisible and their
    // layout positions alias the front's, so they cannot order anything.
    const pile = pileOfRef.current.get(id)
    const block = pile && pile.kind === 'a' && pile.front === id
      ? pile.list : [id]
    const members = new Set(block)
    const sibs = cohort.filter((k) => !members.has(k))
    if (!sibs.length) { finish(); return }
    const first = block[0]!
    const oldIdx = cohort.indexOf(first)
    const beforeOld = cohort.slice(0, Math.max(oldIdx, 0)).reverse()
      .find((k) => !members.has(k))
    const oldReq = beforeOld ? { after: beforeOld }
      : { before: sibs.find((k) => cohort.indexOf(k) > oldIdx) ?? sibs[0]! }
    const x = springs.current.get(id)?.x ?? 0
    const beforeSib = sibs.find((k) => (targetRef.current.get(k)?.x ?? 0) > x)
    const req = beforeSib ? { before: beforeSib } : { after: sibs[sibs.length - 1] }
    const chain = async (lead: { before?: string; after?: string }) => {
      let prev: string | null = null
      for (const m of block) {
        await reorderNode(slug, m, prev ? { after: prev } : lead)
        prev = m
      }
    }
    // №17: a successful accidental reorder used to be completely silent
    chain(req)
      .then(() => toast([block.length > 1
        ? `${id} reordered (with its ${block.length - 1} stacked sibling`
          + (block.length > 2 ? 's)' : ')')
        : `${id} reordered`],
        () => chain(oldReq).catch(() => {})))
      .catch((err: Error) => toast([`error: ${err.message}`])).finally(finish)
  }

  // ------------------------------------------------------- focus (the desk)
  // `nearestId` is the card the camera is on; `focusId` is the desk that
  // OPENS. They differ in exactly one case — FR-3, user ruling 2026-09-04,
  // "PINNED MEANS PINNED": a pinned node's desk lives in its screen-space
  // window and NOWHERE ELSE, so the camera landing on its card opens nothing
  // (the card shows a placeholder — see `pinnedFocusId` below). Two mounted
  // desks for one node would share one `orgtree-draft-<slug>-<nid>` composer
  // key and silently fight over it.
  //   Deliberately NOT "skip pinned ids in the nearest search" (as the plan
  // first sketched): at desk zoom the focus radius is 1.6 cards, so skipping
  // would hand focus to the pinned card's NEIGHBOUR while the camera sits
  // squarely on the pinned card — zooming into A would open B's desk.
  const nearestId = useMemo(() => {
    if (view.z < Z_DESK) return null
    const vp = viewportRef.current?.getBoundingClientRect()
    // ⚠ THE SEARCH CENTRE MUST BE THE REGION'S, NOT THE VIEWPORT'S
    // (w14aace89, review 2026-09-05). This asks "which card is the camera
    // sitting on"; `focusView` now parks the focused card at the centre of
    // the FREE REGION, so measuring from the viewport centre asks about a
    // point the camera was never aiming at. With a pin taking one side, the
    // focused card sits an entire half-viewport away from `vp.width / 2` —
    // far enough to exceed the 1.6-card radius below and open NO desk, or to
    // hand focus to whichever card happens to lie nearer the middle instead.
    const nvReg = vp ? regionOf(vp) : null
    const nvR = nvReg && nvReg.status !== 'blocked' ? nvReg.rect : null
    const cw = nvR ? nvR.x + nvR.w / 2 : (vp ? vp.width / 2 : 500)
    const ch = nvR ? nvR.y + nvR.h / 2 : (vp ? vp.height / 2 : 350)
    let best: string | null = null, bestD = Infinity
    for (const [id] of target) {
      if (id === DRAFT) continue         // the EYE can be a desk too (switchboard)
      if (hidden.has(id)) continue       // piled-away retirees never take focus
      const p = posOf(id)!
      const sx = (p.x + NODE_W / 2) * view.z + view.x
      const sy = (p.y + NODE_H / 2) * view.z + view.y
      const d = Math.hypot(sx - cw, sy - ch)
      if (d < bestD) { bestD = d; best = id }
    }
    // the SWITCHBOARD is a full-screen surface (user ruling): the eye's desk
    // triggers only when the zoom actually approaches screen-filling — far
    // later than an agent's desk; below that the eye stays a plain card
    if (best === USER) {
      // ⚠ MEASURE "SCREEN-FILLING" AGAINST THE SAME SPACE THE CAMERA AIMED AT
      // (w14aace89). This gate asks whether the zoom approaches the one that
      // FILLS the surface; `focusView` now fills the free region rather than
      // the whole viewport, so leaving `vp.height` here compared the camera's
      // achieved zoom against a target it was never trying to reach. With a
      // pin taking half the height the eye focused at ~2.7 while the gate
      // still demanded ~5.2, and the switchboard could never open at all while
      // any pin was up. Caught by focusspace.test.tsx §5, which measured the
      // eye's RENDERED width and found the unfocused square.
      const fillR = vp ? regionOf(vp).rect : null
      const zFill = fillR
        ? Math.min(Z_MAX, (fillR.h - 48) / USER_H,
          (fillR.w - 48) / eyeWorldW(fillR))
        : Z_MAX
      if (view.z < zFill * 0.85) return null
    }
    return bestD < NODE_W * 1.6 * view.z ? best : null
    // `pins` is a dependency because the two region reads above move with it:
    // pinning or dragging a window changes both the search centre and the
    // eye's fill threshold WITHOUT the camera moving, and `view` alone would
    // leave this memo holding a verdict computed against the old free space.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, target, hidden, pins])
  const pinnedFocusId = nearestId && pinnedIds.has(nearestId) ? nearestId : null
  const focusId = pinnedFocusId ? null : nearestId
  focusRef.current = focusId

  // FR-3 — world → VIEWPORT px for one node's card, read NOW (the position is
  // derived from the tree and moves under a pin at any time; pins.tsx never
  // stores it). Null when the node has no position: gone from the tree.
  const cardRectOf = useCallback((id: string): PinRect | null => {
    if (!mapRef.current.has(id)) return null
    const p = posOf(id)
    if (!p) return null
    const v = viewRef.current
    const { w, h } = sizeOf(id)
    return { x: p.x * v.z + v.x, y: p.y * v.z + v.y, w: w * v.z, h: h * v.z }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const vpSizeNow = () => {
    const r = viewportRef.current?.getBoundingClientRect()
    return r && r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : null
  }
  /** the desk header's pin button: detach this desk into a window placed
   *  exactly over the card it came from — the camera does not move, and the
   *  card underneath turns into the placeholder on the same frame */
  const pinDesk = (id: string) => {
    const at = cardRectOf(id)
    if (!at) return
    const r = addPin(slug, id, clampRect(at, vpSizeNow()))
    if (!r.ok) toast([r.reason])
  }

  // THE AGENTS LIST ROW'S CONTEXT MENU (user request 2026-09-12: a row must
  // offer exactly what the agent's own card offers, "with the same ordering,
  // labels, availability, authority checks and behavior"). The entry LIST is
  // not written here — canvas/agentmenu.tsx holds the one copy the card uses
  // too, so the two cannot drift. What is written here is the row's own
  // handlers, which are the canvas's existing ones: the very calls the card
  // is given a few hundred lines below.
  //
  // `go` is the row's navigation (it brings a piled-away agent to the front of
  // its pile first, and at compact it opens the sheet) — the row's answer to
  // the card's "re-centre on me".
  const trayRowMenu = (n: CanvasNode, go: () => void,
    ask: (a: { id: string; kind: RetireKind }) => void,
    deskNow: ReturnType<typeof useDeskActionsNow>): MenuEntry[] => {
    // read at menu-open time, never subscribed to (deskhosts.tsx)
    const desk = deskNow(n)
    return agentMenuEntries(n, {
      onOpenDesk: go,
      onInbox: () => toggleNodeSurface('node-inbox', n.id, setInboxId),
      onDocket: () => toggleNodeSurface('agent-docket', n.id, setAgentDocketId),
      onPresentations: onOpenAgentGallery
        ? () => onOpenAgentGallery(n.id) : undefined,
      onLineage: () => toggleNodeSurface('lineage', n.id, setLineageId),
      onSettings: () => toggleConfig(n.id),
      // the same gate the card gets: there is no pinning on mobile
      onPin: !isMobile ? () => pinDesk(n.id) : undefined,
      onShowPin: () => showPin(slug, n.id, vpSizeNow()),
      // ⚠ THE ROW'S POPOUT IS WHAT THE ROW'S ↗ BUTTON USED TO BE, verbatim
      // (user 2026-09-12 removed those buttons in favour of this menu): ask
      // the desk registry to pop out, and when that desk is not mounted yet,
      // ALSO walk to the agent — the request is retained until the desk
      // registers, and walking there is what mounts it.
      onPopout: !isMobile && desk.valid
        ? () => { desk.requestPopout(); if (!desk.present) go() }
        : undefined,
      onShowWindow: desk.show,
      // the hire chips live ON THE CARD, so this walks to the agent and asks
      // its card to open them — the same reveal the card's own entry runs
      onHire: () => { go(); setHireReveal((h) => ({ id: n.id, seq: (h?.seq ?? 0) + 1 })) },
      onRetireAsk: (kind) => ask({ id: n.id, kind }),
    }, {
      pinned: pinnedIds.has(n.id),
      detached: desk.detached,
      // a piled agent's card is (or becomes, once the row brings it to the
      // front) a pile front, and a pile front hires nowhere: its edges are the
      // stack. Same answer the card gives, decided before the walk.
      piled: pileByFront.has(n.id) || hidden.has(n.id),
    })
  }

  // edge JUMP CARDS (user spec 2026-08-17): at desk zoom the focused agent's
  // coworkers (live siblings) are usually off-screen — one small card per
  // side hugs the FREE REGION's edge at the neighbor's own screen elevation
  // (clamped into it) and glides the camera there on click. Only the NEXT
  // sibling over in each direction, and only while that sibling is genuinely
  // not clickable — a visible card needs no proxy.
  //
  // user bug 2026-09-05: BOTH the placement and the "is it already visible?"
  // test use the region, not the window. A sibling under a pin is on-screen
  // but unreachable, so counting it visible suppressed its proxy entirely.
  const edgeJumps = useMemo(() => {
    if (!focusId || compact) return []
    const me = map.get(focusId)
    if (!me || me.id === USER || me.isBearerOf) return []
    const vp = viewportRef.current?.getBoundingClientRect()
    if (!vp || !vp.width) return []
    // ⚠ 'blocked' = pins cover the viewport and `rect` is empty; placing
    // against it would put the cards off the top of the screen. Nowhere is
    // better than the window, so fall back to it. A region too small for the
    // tab form is the same deal: degraded, never dropped.
    const reg = regionOf(vp)
    const free = reg.status === 'blocked'
      ? { x: 0, y: 0, w: vp.width, h: vp.height }
      : reg.rect
    const sibs = (map.get(me.parent ?? '')?.children ?? [])
      .map((c) => c.id)
      .filter((k) => k !== DRAFT && map.get(k)?.state === 'live'
        && !map.get(k)?.isBearerOf && !hidden.has(k) && target.has(k))
      .sort((p, q) => (target.get(p)?.x ?? 0) - (target.get(q)?.x ?? 0))
    const at = sibs.indexOf(focusId)
    if (at < 0) return []
    // the FOCUSED desk's own screen rect — every placement is measured against
    // this, not against the window (user bug 2026-08-26)
    const mp = posOf(focusId)
    if (!mp) return []
    const ms = sizeOf(focusId)
    const desk = {
      x0: mp.x * view.z + view.x, y0: mp.y * view.z + view.y,
      x1: (mp.x + ms.w) * view.z + view.x, y1: (mp.y + ms.h) * view.z + view.y,
    }
    const out: {
      n: CanvasNode; side: 'l' | 'r'; y: number; inset: number
      form: EJForm; band: boolean
    }[] = []
    for (const [k, side] of [[sibs[at - 1], 'l'], [sibs[at + 1], 'r']] as const) {
      if (!k) continue
      const n = map.get(k), p = posOf(k)
      if (!n || !p) continue
      const { w, h } = sizeOf(k)
      const x0 = p.x * view.z + view.x, y0 = p.y * view.z + view.y
      const x1 = (p.x + w) * view.z + view.x, y1 = (p.y + h) * view.z + view.y
      // reachable without a proxy = it shows in the free region (unpinned,
      // `free` is the viewport and this is the old test term for term)
      if (x1 > free.x && x0 < free.x + free.w
        && y1 > free.y && y0 < free.y + free.h) continue
      const put = edgeJumpPlacement(side, desk, vp, (y0 + y1) / 2, free)
      out.push({ n, side, y: put.y, inset: put.inset, form: put.form, band: put.band })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, map, target, hidden, view, compact, pins, regionOf])

  const lod = view.z < Z_MINI ? 'mini' : 'norm'

  const bounds = useMemo(() => {
    let mx = 900, my = 700
    for (const p of target.values()) { mx = Math.max(mx, p.x + 560); my = Math.max(my, p.y + 640) }
    return { w: mx, h: my }
  }, [target])

  // coworkers are wired: adjacent live siblings share a lateral line (§7.6
  // peers may message directly)
  const peerLinks = useMemo(() => {
    const links: [string, string][] = []
    for (const n of map.values()) {
      if (!n.children || n.children.length < 2 || n.isBearerOf) continue
      const sibs = n.children.map((c) => c.id)
        .filter((k) => map.get(k)?.state === 'live')
        .sort((p, q) => (target.get(p)?.x ?? 0) - (target.get(q)?.x ?? 0))
      for (let i = 0; i + 1 < sibs.length; i++) links.push([sibs[i]!, sibs[i + 1]!])
    }
    return links
  }, [map, target])

  // at most ONE audience line per DRAWN pair (user bug 2026-08-24): buried
  // pile members sit at exactly their front card's position, so every holder
  // in a retired pile contributed a fully coincident stroke and the stacked
  // alpha made the pile glow. Collapse by the VISUAL pair — endpoints mapped
  // through the pile — keeping the front card's own grant when it is itself a
  // holder, so the surviving raw key is the one whose card is on screen; a
  // pair whose two ends collapse to the same card would be a line to itself
  // and draws nothing.
  const audLines = useMemo(() => {
    const keep = new Map<string, AudienceGrant>()
    for (const a of tree.audiences ?? []) {
      if (!map.has(a.grantor) || !map.has(a.grantee)) continue
      const vg = hidden.get(a.grantor) ?? a.grantor
      const ve = hidden.get(a.grantee) ?? a.grantee
      if (vg === ve) continue
      const vk = vg + '→' + ve
      if (!keep.has(vk) || (a.grantor === vg && a.grantee === ve)) keep.set(vk, a)
    }
    return [...keep.values()]
  }, [tree.audiences, map, hidden])

  const spawn = (parentId: string, tier: string) => {
    setDraft({ parent: parentId === USER ? null : parentId, tier })
    // roughly OVERVIEW scale start to finish (user ruling): the form is
    // authored on a 200px virtual surface (scale .6 into the card), so
    // z ≈ 1.7 already renders authored px ≈ screen px — no screen-fill dive.
    // Clamped from ABOVE too: spawning from a desk (chips live there now)
    // must glide OUT to overview, not render the form at desk fill
    setTimeout(() => centerOn(
      DRAFT, Math.min(2.05, Math.max(1.7, viewRef.current.z))), 60)
  }
  // F-03: hire a COWORKER — same superior, placed to the chosen side of the
  // anchor. Top-level agents side-hire more top-levels (parent is the user).
  const spawnBeside = (n: CanvasNode, tier: string, side: 'left' | 'right') => {
    setDraft({ parent: !n.parent || n.parent === USER ? null : n.parent, tier,
               beside: { anchor: n.id, side } })
    setTimeout(() => centerOn(
      DRAFT, Math.min(2.05, Math.max(1.7, viewRef.current.z))), 60)
  }
  // FR-25: insert a SUPERIOR — hired under the anchor's own superior (the
  // exact parent resolution spawnBeside uses); the hire op carries the anchor
  // and the server splices atomically (hire + ordinal pin + move, one save).
  // The draft meanwhile WRAPS the anchor in the preview tree (withDraftTree),
  // so the form already sits in the final shape and confirm causes no reflow.
  const spawnAbove = (n: CanvasNode, tier: string) => {
    setDraft({ parent: !n.parent || n.parent === USER ? null : n.parent, tier,
               above: { anchor: n.id } })
    setTimeout(() => centerOn(
      DRAFT, Math.min(2.05, Math.max(1.7, viewRef.current.z))), 60)
  }
  const confirmDraft = (name: string, grant: number, charter: string,
    scope: DraftScope | null) => {
    op({ op: 'hire', parent: draft!.parent, tier: draft!.tier, grant, name,
         charter: charter?.trim() || undefined,
         // FR-25: the anchor rides the hire op — the SERVER splices the new
         // node in as its superior atomically (one save, one broadcast), so
         // the old client-chained hire→move two-step (and its half-done
         // failure mode) is gone
         above: draft!.above?.anchor,
         // pre-hire permissions (user spec): staged in the draft's modal,
         // applied atomically WITH the hire — effort included (review: the
         // old post-hire /scope call is 403'd through the kiosk gateway,
         // and its failure was swallowed silently)
         ...(scope ? { add_dirs: scope.add_dirs, tools: scope.tools,
                       org_visibility: scope.org_visibility,
                       effort: scope.effort || undefined,
                       // item 12: the draft's "Prefer reserve" box (luna
                       // only; omitted = the default, reserve first)
                       ...(scope.prefer_reserve === undefined ? {}
                         : { prefer_reserve: scope.prefer_reserve }),
                       ...(scope.account !== undefined ? { account: scope.account } : {}) } : {}) })
      .then((r) => {
        // the real card replaces the draft IN PLACE — seed its birth position
        // from the draft's spring. Via seedRef, NOT a direct springs.set: the
        // reaper deletes unknown-id springs every tick, and the refreshed tree
        // (which makes the id known) lands frames after this response — a
        // direct set died instantly and the node glided in from its parent
        const ds = springs.current.get(DRAFT)
        // (typeof-narrows the op result's open dict: hire returns {node: str})
        const born = r?.node
        if (typeof born === 'string' && born && ds) {
          seedRef.current.set(born, { x: ds.x, y: ds.y, at: performance.now() })
        }
        // user feature 2026-08-26: initializing an agent walks you to its
        // desk. A hire is only half the gesture — the agent sits idle until
        // someone messages it, and the desk is where that message is typed;
        // the draft form used to leave you at overview zoom with the new card
        // among its siblings and no way in but a second click.
        // Deliberately armed HERE and not off the tree refresh: this fires for
        // hires made in THIS browser only. An agent hiring its own subordinate
        // arrives by the same broadcast, and yanking the camera across the org
        // for something the user did not initiate is a different feature.
        if (typeof born === 'string' && born) {
          hireDeskRef.current = { id: born, at: performance.now() }
        }
        // F-03: pin the ordering the side chip promised. Best-effort — the
        // hire itself already succeeded, and reorder is cosmetic (its own
        // ruling); a failure leaves the hire appended at the end.
        const beside = draft?.beside
        if (typeof born === 'string' && born && beside) {
          void reorderNode(slug, born, beside.side === 'left'
            ? { before: beside.anchor } : { after: beside.anchor })
            .catch(() => {})   // the broadcast refetch shows the final order
        }
        // (FR-25's splice needs nothing here anymore — it happened inside
        // the hire op itself, atomically; the broadcast refetch already
        // carries the final shape, which the draft was previewing in place)
        setDraft(null)
      }).catch((e: Error) => toast([`hire failed: ${e.message}`]))
  }

  // the eye's bar on hover. Every credit in circulation is, recursively,
  // either locked in some live node's SEAT or sitting FREE in some node's
  // grant (committed grants just contain the child's seat+free again) — so
  // circulation = Σ seats + Σ free, and those are the honest labels.
  const kioskRemaining = tree.kiosk?.credits != null
    ? Math.max(0, tree.kiosk.credits - (tree.audit?.top_level_holds ?? 0))
    : null

  // D-125 ②: at compact the watchdog chips leave the map; owners carry the
  // count as a dot and the sheet header lists them
  const dogsByOwner = useMemo(() => {
    const out: Record<string, { total: number; oneShot: number }> = {}
    for (const w of tree.watchdogs ?? []) {
      const own = out[w.owner] ?? { total: 0, oneShot: 0 }
      own.total += 1
      if (w.once) own.oneShot += 1
      out[w.owner] = own
    }
    return out
  }, [tree.watchdogs])

  const orgStats = useMemo(() => {
    let free = 0
    const walk = (n: TreeNode) => {
      // (const extraction: `free` is null on non-live nodes — ledger.py:2524)
      const f = n.free
      if (n.state === 'live' && f != null && f > 0) free += f
      n.children.forEach(walk)
    }
    tree.roots.forEach(walk)
    const circ = tree.audit?.top_level_holds ?? 0
    return { circ, seats: circ - free, free }
  }, [tree])

  return (
    <DeskHosts map={map} slug={slug} treeSlug={tree.slug}><div style={freeAnchor ?? undefined} className={'viewport' + (tree.sandboxed ? ' sandboxed' : '')
      + (tree.headless ? ' headless' : '')
      // api_fallback (user feature 2026-08-19): the office border goes red
      // while the org's own API key is the lane being billed. Whole-canvas,
      // because the fact is org-wide — the per-agent red below says which
      // turns are actually spending it.
      + (fallbackActive(tree) ? ' onfallback' : '')} data-culling={visibleRect ? 'active' : 'unmeasured'} data-pin-org={slug} ref={viewportRef}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      /* onPointerCancel routes to onPointerUp, which nulls panRef — correct,
         but it means ANY pointercancel kills the gesture outright. The one
         that used to fire here came from the browser starting a native drag
         of an invisible canvas-wide text selection left behind by the
         previous pan; that is now prevented in CSS, at `.viewport`'s
         user-select rule in styles.css. Read that comment before adding a
         text surface to the canvas. */
      onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onScroll={(e) => {
        // the viewport pans by TRANSFORM only — any native scroll is the
        // browser force-scrolling an overflow:hidden box to reach a focused
        // element (the draft's name input, off-screen when spawning from a
        // desk). A real scrollLeft/Top here shears every screen-space anchor
        // (HUD, tray) off the canvas and corrupts centerOn math; zero it.
        e.currentTarget.scrollLeft = 0
        e.currentTarget.scrollTop = 0
      }}>
      {/* parallax backdrop (user feature 2026-09-03): the dot grid pans at a
          fraction of the foreground's rate — PARALLAX_BG below — so a drag
          reads as depth instead of a flat sheet sliding under the cards. Zoom
          still scales it 1:1 with the world; only the pan rate differs. */}
      <div className="canvas-bg" style={{
        backgroundPosition: `${view.x * PARALLAX_BG}px ${view.y * PARALLAX_BG}px`,
        backgroundSize: `${28 * view.z}px ${28 * view.z}px`,
        '--dot-r': `${Math.max(1, 1.1 * view.z).toFixed(2)}px`,
      }} />
      <div className="space" style={{
        width: bounds.w, height: bounds.h,
        transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
        '--invz': Math.min(2.4, Math.max(1 / Z_MAX, 1 / view.z)).toFixed(3),
        // UNCLAMPED counter-scale for the hire chips (user report 2026-08-04:
        // "the chips disappear too soon when zooming out"). The 2.4 clamp let
        // chips shrink with the world below z≈0.42 while the card was still
        // usable; the hire gesture stays screen-constant for as long as the
        // card exists. Other --invz users keep the clamp — a screen-constant
        // badge on a distant card is noise, a screen-constant CONTROL is not.
        '--invzf': Math.max(1 / Z_MAX, 1 / view.z).toFixed(3),
      }}>
        <svg className="edges" width={bounds.w} height={bounds.h}>
          {[...map.values()].filter((n) => n.parent && !n.isBearerOf
            && !hidden.has(n.id)).map((n) => {
            if (!posOf(n.parent!) || !posOf(n.id)) return null
            return <ViewportPath viewport={visibleRect} key={n.id} d={segD(treeSeg(n.parent!, n.id))}
              className={'edge' + (n.state === 'archived' ? ' faded' : '')
                // dashed on BOTH sides of a draft: its own parent edge, and —
                // for an insert-superior draft, which wraps its anchor — the
                // edge down to the anchor it would adopt
                + (n.state === 'draft' || n.parent === DRAFT
                  ? ' draftedge' : '')} />
          })}
          {peerLinks.map(([l, r]) => (
            posOf(l) && posOf(r) &&
            <ViewportPath viewport={visibleRect} key={'p' + l + r} d={segD(peerSeg(l, r))} className="edge peer" />
          ))}
          {(() => {
            const nowT = performance.now()
            const anim = audAnimRef.current
            const out: ReactNode[] = []
            const vpair = (g: string, e: string) =>
              (hidden.get(g) ?? g) + '→' + (hidden.get(e) ?? e)
            const drawn = new Set<string>()   // raw keys rendered this frame
            const drawnV = new Set<string>()  // visual pairs occupied by them
            for (const a of audLines) {
              if (!posOf(a.grantor) || !posOf(a.grantee)) continue
              const k = a.grantor + '→' + a.grantee
              drawn.add(k)
              drawnV.add(vpair(a.grantor, a.grantee))
              const st = anim.get(k)
              let dash: number | null = null
              if (st?.phase === 'in') {
                const t = (nowT - st.t0) / AUD_DUR
                if (t >= 1) anim.delete(k)
                else dash = 1 - smooth(Math.max(0, t))   // draw toward the grantee
              }
              out.push(<ViewportPath viewport={visibleRect} key={'a' + k} d={segD(audSeg(a.grantor, a.grantee))}
                pathLength={dash != null ? 1 : undefined}
                style={dash != null
                  ? { strokeDasharray: 1, strokeDashoffset: dash } : undefined}
                className={'edge aud-line' + (a.grantor === USER ? ' from-user' : '')} />)
            }
            for (const [k, st] of anim) {
              if (st.phase !== 'out') {
                // an 'in' whose line was collapsed into a pile's single
                // stroke (or filtered out) never renders, so the loop above
                // never reaches its delete — and one live entry keeps the
                // rAF loop repainting the whole canvas forever
                if (!drawn.has(k)) anim.delete(k)
                continue
              }
              const t = (nowT - st.t0) / AUD_DUR
              if (t >= 1 || !posOf(st.grantor) || !posOf(st.grantee)
                // a revoked grant whose visual pair a surviving pile-mate
                // still draws: retracting a stroke over the persistent line
                // is exactly the double-draw this collapse exists to prevent
                || drawnV.has(vpair(st.grantor, st.grantee))) {
                anim.delete(k)
                continue
              }
              out.push(<ViewportPath viewport={visibleRect} key={'a' + k} d={segD(audSeg(st.grantor, st.grantee))}
                pathLength={1}
                style={{ strokeDasharray: 1, strokeDashoffset: smooth(t) }}
                className={'edge aud-line'
                  + (st.grantor === USER ? ' from-user' : '')} />)
            }
            return out
          })()}
          {[...map.values()].filter((n) => n.isBearerOf).map((n) => {
            const a = posOf(n.isBearerOf!), b = posOf(n.id)
            if (!a || !b) return null
            return <ViewportPath viewport={visibleRect} key={'t' + n.id}
              d={`M ${a.x + NODE_W - 10} ${a.y + 8} L ${b.x + 10} ${b.y + NODE_H - 8}`}
              className="edge tether" />
          })}
          {/* FR-18: the watchdog wire — the user's spec verbatim ("connected
              to their owner with a wire"); the spark rides it on each fire.
              Hidden at compact with the chips (D-125 ②). */}
          {!compact && (tree.watchdogs ?? []).map((w) => {
            const a = posOf('dog:' + w.id), b = posOf(w.owner)
            if (!a || !b) return null
            return <ViewportPath viewport={visibleRect} key={'w' + w.id}
              d={`M ${a.x + DOG_W / 2} ${a.y + 4} L ${b.x + NODE_W / 2} ${b.y + NODE_H - 8}`}
              className={'edge tether wd'
                + (w.state !== 'armed' && !w.spent ? ' off' : '')
                + (w.once ? ' oneshot' : '')
                + (w.spent ? ' spent' : '')} />
          })}
          {tree.org_inbox?.visible && posOf(INBOX) && (() => {
            // no box↔eye tether (user revision) — the panel stands alone;
            // only audience lines to its holders. Those connect FACING sides:
            // an agent left of the box joins from its RIGHT side (user spec),
            // an agent right of it from its left.
            const out: ReactNode[] = []
            for (const h of tree.org_inbox.holders ?? []) {
              if (!map.has(h) || !posOf(h)) continue
              const a = posOf(INBOX)!, b = posOf(h)!
              const ga = sizeOf(INBOX), gb = sizeOf(h)
              const left = (b.x + gb.w / 2) < (a.x + ga.w / 2)
              const x1 = left ? a.x : a.x + ga.w
              const x2 = left ? b.x + gb.w : b.x
              const y1 = a.y + ga.h / 2, y2 = b.y + gb.h / 2
              const bulge = 64 + Math.abs(y2 - y1) * 0.12
              out.push(<ViewportPath viewport={visibleRect} key={'oi' + h} d={segD({ kind: 'c', pts: [
                { x: x1, y: y1 }, { x: x1 + (left ? -bulge : bulge), y: y1 },
                { x: x2 + (left ? bulge : -bulge), y: y2 }, { x: x2, y: y2 }] })}
                className="edge aud-line" />)
            }
            return out
          })()}
          {sparksRef.current.map((sp) => {
            const el = (performance.now() - sp.start) / sp.segDur
            const i = Math.max(0, Math.min(sp.segs.length - 1, Math.floor(el)))
            const t = smooth(Math.max(0, Math.min(1, el - i)))
            const seg = sp.segs[i]! // nUIA: i clamped to 0..len-1 and segs is never empty (guarded at push)
            const p = segPoint(seg, seg.rev ? 1 - t : t)
            if (!intersectsViewport({ x: p.x - 4, y: p.y - 4, w: 8, h: 8 }, visibleRect)) return null
            return <circle key={sp.id} className="spark" cx={p.x} cy={p.y} r="3.4" />
          })}
        </svg>
        {[...map.values()].map((n) => {
          const p = posOf(n.id)
          if (!p) return null
          // Keep the single eye (its credit bar extends beyond its card), the draft,
          // focused composer and captured drag alive. Ordinary offscreen cards do not mount.
          if (n.id !== USER && n.id !== DRAFT && n.id !== focusId && n.id !== nodeDrag.current?.id
            && !intersectsViewport({ ...p, ...sizeOf(n.id) }, visibleRect)) return null
          if (n.id === USER) {
            if (compact) {
              // §5.1: the switchboard is desktop-idea-shaped (N-up parallel
              // desks) — at compact the eye is a plain marker; tapping it
              // opens the user inbox (viewport tap arbitration above)
              return <div key={USER} className="sq user maplod eye-map"
                style={{ transform: `translate(${p.x}px, ${p.y}px)`,
                         width: USER_W, height: USER_H }}>
                <span className="map-name">you</span>
                {(() => {
                  const pip = attentionPip(tree)
                  return pip && <b className={'eye-count' + (pip.urgent ? ' asks' : '')}
                    title={pip.title}>{pip.count}</b>
                })()}
              </div>
            }
            const vp = viewportRef.current?.getBoundingClientRect()
            // the eye is the ONLY cell that expands in width to the screen's
            // FULL aspect ratio when focused (user spec — room for the
            // switchboard). The credit bar keeps its normal outboard spot:
            // offscreen at focus, but still rendered — pan sideways and it
            // is there (user ruling; never force it on screen).
            // w14aace89 (user, 2026-09-05): the switchboard must EXPAND ONLY
            // INTO THE FREE RECTANGLE, not merely be centred in it. `eyeW` is
            // the eye cell's real laid-out width, so constraining it here is a
            // LAYOUT change — the switchboard's rendered bounds shrink to the
            // space the pins leave, instead of rendering full-width and having
            // its edges sit underneath a pin.
            // Aspect comes from the region for the same reason focusView fits
            // to the region: the two must agree, or the camera would frame a
            // width the cell does not actually have. No pins => region IS the
            // viewport => identical to the previous expression.
            const eyeReg = vp ? regionOf(vp) : null
            const eyeR = eyeReg && eyeReg.status !== 'blocked' ? eyeReg.rect : null
            // ONE definition, shared with the camera and the focus gate:
            // `eyeWorldW` also guards the divisor (a region thinner than the
            // 48px margin would otherwise hand the layout an Infinity width)
            // and applies the USER_W floor.
            const eyeW = eyeWorldW(eyeR)
            return <UserNode key={USER} pos={p} isDrop={dropId === USER} seats={seats}
              codexHire={codexHire} antigravityHire={antigravityHire}
              openrouterHire={openrouterHire}
              claudeHire={claudeHire} onNoHarness={onAccounts}
              stats={orgStats}
              kiosk={tree.kiosk} pub={!!tree.public} kioskRemaining={kioskRemaining}
              kioskSegs={tree.roots.filter((n) => n.state === 'live')
                .map((n) => ({ seat: n.seat, grant: n.grant }))}
              pxc={pxPerCredit} zoom={view.z}
              focused={focusId === USER} eyeW={Math.max(eyeW, USER_W)}
              onFocus={() => centerOn(USER)}
              posX={(id) => posOf(id)?.x ?? 0}
              onJump={(id) => centerOn(id)}
              map={map} op={op} slug={slug} toast={toast}
              /* a pinned agent already has a live chat on screen: the
                 switchboard shows its TAB but no second panel, and the tab
                 raises the existing window (same call the card placeholder
                 makes). User ruling 2026-09-05. */
              pinnedIds={pinnedIds}
              onShowPin={(id) => showPin(slug, id, vpSizeNow())}
              compactAt={tree.compact_at} maxTop={tree.max_top_grant ?? 1000}
              /* the pip is DECIDED HERE and handed down (D-169): asks +
                 urgent mail outrank plain unread, and `asks_open` already
                 covers pending credit requests as well as open questions
                 (adding credit_requests too would double-count). One call,
                 so the eye, the map marker and the chrome bell cannot
                 disagree.
                 ⚠ The eye's ✉ and ⚙ appear only with agent-card shortcuts
                 turned on, and its CONTEXT MENU reaches the same two places
                 either way — that gating is UserNode's, deliberately, so
                 this side stays "here is how to open those things" and does
                 not also have to know when they are on screen. */
              pip={attentionPip(tree)}
              onInbox={() => {
                const nw = tree.user_inbox_newest ?? new Date().toISOString()
                localStorage.setItem('orgtree-inbox-seen-' + slug, nw)
                setInboxSeen(nw)
                onInbox?.()
              }}
              onGear={onOrgSettings}
              onMailLink={openMail} onWorkLink={openWork} onOpenDoc={setDocView}
              /* switchboard panel headers mirror the desk header identically
                 (user spec 2026-08-19): the gen badge and gear in each panel
                 open the same canvas-level lineage/config surfaces */
              onNodeLineage={(id) => toggleNodeSurface('lineage', id, setLineageId)} onNodeConfig={toggleConfig}
              onSpawn={(t) => spawn(USER, t)} />
          }
          if (n.id === DRAFT) {
            return <DraftNode key={DRAFT} pos={p} draft={draft!} map={map} seats={seats}
              maxTop={tree.max_top_grant ?? 1000} kioskRemaining={kioskRemaining}
              defaultTop={tree.default_top_grant ?? 50} tree={tree}
              zoom={view.z} pxc={pxPerCredit}
              onConfirm={confirmDraft} onCancel={() => setDraft(null)} />
          }
          if (hidden.has(n.id)) return null   // piled-away: no card, no space
          const pileHere = pileByFront.get(n.id)
          const square = (
            <NodeSquare key={n.id} node={n} pos={p} lod={lod} focused={n.id === focusId}
              /* FR-3: the camera is on this card but its desk is a pinned
                 window — placeholder instead of a (second) desk */
              pinnedFocus={n.id === pinnedFocusId}
              pinned={pinnedIds.has(n.id)}
              onPin={!isMobile ? () => pinDesk(n.id) : undefined}
              onShowPin={() => showPin(slug, n.id, vpSizeNow())}
              dragging={nodeDrag.current?.id === n.id && nodeDrag.current!.moved}
              isDrop={dropId === n.id}
              seats={seats} codexHire={codexHire} antigravityHire={antigravityHire}
              openrouterHire={openrouterHire}
              claudeHire={claudeHire} onNoHarness={onAccounts}
              map={map} op={op} slug={slug} toast={toast}
              pxc={pxPerCredit} zoom={view.z}
              onSpawn={(t) => spawn(n.id, t)}
              onSpawnSide={(t, side) => spawnBeside(n, t, side)}
              onSpawnTop={(t) => spawnAbove(n, t)}
              onConfig={() => toggleConfig(n.id)}
              onInbox={() => toggleNodeSurface('node-inbox', n.id, setInboxId)} onLineage={() => toggleNodeSurface('lineage', n.id, setLineageId)}
              onDocket={() => toggleNodeSurface('agent-docket', n.id, setAgentDocketId)}
              onOpenDoc={setDocView}
              onOpenAgentGallery={onOpenAgentGallery}
              onMailLink={openMail} onWorkLink={openWork}
              onRecenter={() => centerOn(n.id)}   /* recenter AND re-zoom to fill */
              onJump={centerOn}                   /* F-01 nav chips */
              pub={!!tree.public} kioskRemaining={kioskRemaining}
              cascadeAlloc={tree.cascade_alloc !== false}
              maxTop={tree.max_top_grant ?? 1000} maxTier={tree.kiosk?.max_tier}
              pile={pileHere} compactAt={tree.compact_at}
              onDragStart={startNodeDrag} onDragMove={moveNodeDrag}
              onDragEnd={endNodeDrag} onDragCancel={abortNodeDrag}
              mapMode={compact} dogs={dogsByOwner[n.id]?.total ?? 0}
              oneShotDogs={dogsByOwner[n.id]?.oneShot ?? 0}
              /* the Agents List row's "Hire a subordinate…" — the chips are
                 here, so the row asks this card to open them */
              revealHire={hireReveal?.id === n.id ? hireReveal.seq : undefined}
              onHireRevealed={() => setHireReveal(null)} />
          )
          if (!pileHere) return square
          // the pile's stack layers render BEHIND the front card as real
          // elements (box-shadows can't be clicked): the exposed margin is
          // the hit target that opens the picker, and the whole stack eases
          // outward slightly on hover (user spec). Retired piles and live
          // CROWD piles share the mechanics; the crowd wears a live tint.
          const layers = Math.min(pileHere.list.length - 1, 3)
          const pTitle = pileHere.kind === 'c'
            ? `${pileHere.list.length} teammates stacked — click to choose who's in front`
            : `${pileHere.list.length} retired here — click to choose who's in front`
          return (
            <span key={n.id}>
              <div className={'pile-stack' + (pileHere.kind === 'c' ? ' crowd' : '')}
                style={{ transform: `translate(${p.x}px, ${p.y}px)`,
                         width: NODE_W, height: NODE_H }}>
                {Array.from({ length: layers }, (_, i) => layers - i).map((i) => (
                  <button key={i} className={'pile-layer l' + i}
                    title={pTitle}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); setPileOpen(pileHere.key) }} />
                ))}
                <button className="pile-count"
                  title={pTitle}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); setPileOpen(pileHere.key) }}>
                  {pileHere.list.length}</button>
              </div>
              {square}
            </span>
          )
        })}
        {/* hide-retired: the retired-list TOKEN — the one place hidden
            retirees surface on the canvas. It sits under the parent card
            that has retired subordinates; clicking lists them (the same
            picker the retired pile uses) and picking one reveals it. */}
        {[...prunedView.retiredByParent.entries()].map(([pid, gone]) => {
          const p = posOf(pid)
          if (!p) return null
          const size = sizeOf(pid)
          if (!intersectsViewport({ ...p, ...size }, visibleRect)) return null
          return (
            <button key={'rt' + pid} className="retired-token"
              style={{ transform: `translate(${p.x + 6}px, ${p.y + size.h + 4}px)` }}
              title={`${gone.length} retired agent${gone.length === 1 ? '' : 's'} hidden here — click to list`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); setRetiredOpen(pid) }}>
              {gone.length} retired
            </button>
          )
        })}
        {/* FR-18: watchdog chips — tiny satellite cards beside their owner
            (the user's spec: named; click for the detail + sent-events
            panel). Not agents: no chrome beyond name + state glyph.
            D-125 ②: HIDDEN at compact — 7px names are illegible and 50×26
            untappable at any phone-fitting zoom; the owner card carries a
            count-dot and the sheet header carries the list. */}
        {!compact && (tree.watchdogs ?? []).map((w) => {
          const p = posOf('dog:' + w.id)
          if (!p || hidden.has(w.owner) || !intersectsViewport({ ...p, w: DOG_W, h: DOG_H }, visibleRect)) return null
          return (
            <button key={'dog' + w.id}
              className={'wd-chip ' + w.state
                + (w.once ? ' oneshot' : '')
                + (w.spent ? ' spent' : '')}
              style={{ transform: `translate(${p.x}px, ${p.y}px)`,
                       width: DOG_W, height: DOG_H }}
              title={`${w.once ? 'one-shot dog' : 'watchdog'} "${w.name}" (${w.kind}) — `
                + `${w.spent ? 'departing after its spark' : w.state}; `
                + 'click for detail'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); toggleDog(w.id) }}>
              <span className="wd-glyph">{w.state === 'armed' ? '◉'
                : w.state === 'paused' ? '◫' : w.spent ? '↗' : '✕'}</span>
              {w.once && <span className="wd-once" aria-label="one-shot dog">1×</span>}
              <span className="wd-name">{w.name}</span>
            </button>
          )
        })}
        {tree.org_inbox?.visible && posOf(INBOX) && (
          <div className={'sq orginbox' + (dropId === INBOX ? ' drop' : '')}
            style={{
              transform: `translate(${posOf(INBOX)!.x}px, ${posOf(INBOX)!.y}px)`,
              width: USER_W, height: INBOX_H,
            }}
            title="the org inbox — outside mail addressed to this organization"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              if (pinnedModalBehind('org-inbox', slug)) { raisePinnedModal('org-inbox', slug); return }
              setOiOpen((v) => isModalPinned('org-inbox', slug) ? !v : true)
            }}>
            <div className="oi-head">
              {/* the label is its own element so it can ELLIPSIS instead of
                  wrapping. As a bare text node it was an anonymous flex item
                  that wrapped to two lines the moment the unread badge
                  competed for width — measured 13.5px → 25.5px — which
                  flex-shrank .oi-last to 2.3px inside the fixed-height tile
                  and clipped the last recipient (user bug 2026-08-07) */}
              <PublicIcon fontSize="inherit" />
              <span className="oi-title">org inbox</span>
              {(() => {   // F-06: hub connectivity at a glance on the mailbox
                const hubs = (tree.net?.hubs ?? [])
                  .filter((h) => h.enabled && !h.hidden)
                if (!hubs.length) return null
                const up = hubs.filter((h) => h.connected).length
                const cls = up === hubs.length ? ' ok' : up > 0 ? ' mix' : ''
                return <span className={'oi-dot' + cls}
                  title={hubs.map((h) => `${h.name || h.address}: `
                    + (h.connected ? 'connected' : h.error || 'connecting…'))
                    .join(' · ')} />
              })()}
              {/* NO unread badge here (user 2026-08-10). Org-inbox mail is
                  addressed to the ORGANIZATION and answered by its agents —
                  the user is not its reader. An unread count asks them to
                  clear something that was never theirs to clear, which is a
                  standing obligation invented by the UI. The tile still shows
                  the last correspondent and opens on click, so nothing is
                  hidden; only the demand is gone. The `unread` field itself
                  stays — the server and the agents use it. */}
            </div>
            <div className="oi-last">
              {(() => {
                const e = tree.org_inbox.entries?.[tree.org_inbox.entries.length - 1]
                if (!e) return 'no mail yet'
                return `${e.dir === 'in' ? '⭠' : '⭢'} ${e.peer.replace(/^@/, '')}`
              })()}
            </div>
          </div>
        )}
      </div>
      {/* stop pointerdown: the viewport's pan pointer-capture retargets clicks
          and silently kills these buttons */}
      {/* FR-3: desks PINNED TO SCREENSPACE — a screen-space sibling of
          .space, like the HUD below, so pan and zoom cannot touch it by
          construction. Rendered only once `tree` and `slug` agree: in the
          org-switch props window the pins are the new org's and `map` is
          still the old org's. Desktop only (see `pinnedIds`). */}
      {!isMobile && tree.slug === slug && (
        <PinLayer slug={slug} map={map} viewportRef={viewportRef}
          targetOf={cardRectOf} op={op} toast={toast} pub={!!tree.public}
          compactAt={tree.compact_at} maxTop={tree.max_top_grant ?? 1000}
          pxc={pxPerCredit} onMailLink={openMail} onWorkLink={openWork} onOpenDoc={setDocView}
          onLineage={(id) => toggleNodeSurface('lineage', id, setLineageId)} onConfig={toggleConfig} onJump={centerOn}
          onShowOnCanvas={showOnCanvas} />
      )}
      {/* nav cluster (user spec): bottom-LEFT beside the agents tray, so
          every zoom target lives in one stack — ordered top to bottom:
          switchboard · full view · zoom in · zoom out */}
      <div className="zoomhud" onPointerDown={(e) => e.stopPropagation()}>
        <button className="hud-eye" title="jump to the switchboard"
          onClick={() => centerOn(USER)}>
          <svg viewBox="0 0 48 26">
            <path d="M 2 13 C 13 2, 35 2, 46 13 C 35 24, 13 24, 2 13 Z" />
            <circle className="iris" cx="24" cy="13" r="6.5" />
            <circle className="pupil" cx="24" cy="13" r="2.6" />
          </svg>
        </button>
        <button title="fit the whole org" onClick={() => fitAll()}><FullscreenIcon fontSize="inherit" /></button>
        <button title="zoom in" onClick={() => zoomStep(1.3)}><AddIcon fontSize="inherit" /></button>
        <button title="zoom out" onClick={() => zoomStep(1 / 1.3)}><RemoveIcon fontSize="inherit" /></button>
      </div>
      {/* edge jump cards: the focused desk's off-screen coworkers, one per
          side at the neighbor's own elevation (pointerdown stopped — the
          pan pointer-capture would swallow the click, see above) */}
      {edgeJumps.map((e) => (
        <button key={e.n.id}
          /* the card's whole accent surface — highlight, hover/focus wash,
             the shed-form mail dot and the unread count — wears the JUMP
             TARGET's provider theme, never the focused desk's (user spec
             2026-09-01: a Codex-hosted jump card pointing at a Claude agent
             is Claude orange) */
          className={'edge-jump ' + e.side + ' ej-' + e.form
            + ' prov-' + providerOf(e.n.tier ?? '')
            + (e.band ? ' ej-band' : '')
            + ((e.n.mail_pending ?? 0) > 0 ? ' ej-mail' : '')}
          /* inline because it is data: the window-to-region distance on this
             side, over the stylesheet's 6px (which is the unpinned value) */
          style={{ top: e.y, ...(e.side === 'l' ? { left: e.inset } : { right: e.inset }) }}
          title={`jump to ${e.n.id}`}
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={() => centerOn(e.n.id)}>
          {e.side === 'l' && <ChevronLeftIcon fontSize="inherit" />}
          <span className={'tier t-' + e.n.tier}>{TIER_LETTER[e.n.tier!] ?? '?'}</span>
          {e.n.pending_switch &&
            <span className="queued-mark" title={queuedSwitchTitle(e.n)}>
              →{TIER_LETTER[e.n.pending_switch.tier] ?? '?'}</span>}
          <span className="ej-name">{e.n.id}</span>
          {e.n.busy && <DestinationBusy tier={e.n.tier} />}
          {(e.n.mail_pending ?? 0) > 0 &&
            <b className={'eye-count prov-' + providerOf(e.n.tier ?? '')}>
              {e.n.mail_pending}</b>}
          {e.side === 'r' && <ChevronRightIcon fontSize="inherit" />}
        </button>
      ))}
      {/* the agent TRAY (user spec): every agent — tier token, name, context
          wheel, working state — in the nodes' own visual language; a row
          click glides to that agent. FR-16 (2026-08-11): listed by HIERARCHY
          — each superior immediately followed by its subtree, indented per
          depth — not by canvas position */}
      <MaybePortal>
      <div ref={trayWrapRef} className="tray-wrap"
        onPointerDown={(e) => e.stopPropagation()}>
        {trayOpen && (
          <PinFrame inline kind="agent-list" title="Agents" panel="tray-panel"
            close={() => setTrayOpen(false)} dialogLabel="Agents">
          <div className="tray">
            <input className="mail-filter tray-filter" placeholder="filter agents…"
              value={trayQ} onChange={(e) => setTrayQ(e.target.value)} />
            {/* archived rows are HIDDEN by default (user spec 2026-07-31) —
                the count row folds them in and out */}
            {(() => {
              const archN = [...map.values()].filter((n) =>
                n.id !== USER && n.id !== DRAFT && !n.isBearerOf
                && n.state !== 'live').length
              return archN > 0 && (
                <button className="tray-arch"
                  onClick={() => setTrayArch((v) => !v)}>
                  {trayArch ? '▾ hide' : '▸ show'} {archN} archived
                </button>
              )
            })()}
            <AgentListMenuHost map={map} op={op} slug={slug} toast={toast}
              render={(menu, ask, deskNow) => {
              // FR-16 (user request 2026-08-06): the tray lists by HIERARCHY —
              // every direct report immediately after its superior, indented a
              // step — replacing the old canvas-position sort, which put a
              // child hired far from its parent nowhere near it in the list.
              // Sibling order keeps the position sort, so the tray still
              // tracks the canvas arrangement locally.
              const all = [...map.values()]
                .filter((n) => n.id !== USER && n.id !== DRAFT && !n.isBearerOf)
              const q = trayQ.trim().toLowerCase()
              const match = (n: CanvasNode) =>
                (trayArch || n.state === 'live')
                && (!q || n.id.toLowerCase().includes(q))
              const kids = new Map<string, CanvasNode[]>()
              for (const n of all) {
                const p = n.parent && map.has(n.parent) && n.parent !== USER
                  ? n.parent : USER
                kids.set(p, [...(kids.get(p) ?? []), n])
              }
              const byPos = (a: CanvasNode, b: CanvasNode) => {
                const pa = posOf(a.id) ?? { x: 0, y: 0 }
                const pb = posOf(b.id) ?? { x: 0, y: 0 }
                return pa.y - pb.y || pa.x - pb.x
              }
              // a filtered-out ANCESTOR of a matching row still renders, as a
              // dim ghost: with indentation carrying meaning, dropping it
              // would leave the descendant indented under a gap with no
              // visible parent (the docket's own open question — resolved
              // toward keeping the indent readable)
              const anyMatch = (n: CanvasNode): boolean =>
                match(n) || (kids.get(n.id) ?? []).some(anyMatch)
              const rows: { n: CanvasNode; depth: number; ghost: boolean }[] = []
              const walk = (id: string, depth: number) => {
                for (const c of (kids.get(id) ?? []).sort(byPos)) {
                  if (!anyMatch(c)) continue
                  rows.push({ n: c, depth, ghost: !match(c) })
                  walk(c.id, depth + 1)
                }
              }
              walk(USER, 0)
              return rows.map(({ n, depth, ghost }) => {
                // a piled-away agent comes to the FRONT of its pile when
                // picked from the tray, then the glide lands on it — the key
                // names the pile KIND (retired |a vs live crowd |c)
                const go = () => {
                  if (hidden.has(n.id)) {
                    const par = map.get(n.id)?.parent
                    setFront(par! + (n.state === 'archived' ? '|a' : '|c'), n.id)
                  }
                  // mobile sheet gate: the tray is primary navigation at
                  // compact (§5.3) — a row opens the desk sheet directly
                  // (centerOn would glide past the compact zoom clamp)
                  if (sheetGate()) { setSheetId(n.id); setTrayOpen(false) }
                  else centerOn(n.id)
                }
                // №13: the status summary is TEXT here, not a tooltip — and a
                // finished status survives the next turn as prev_status (dim)
                const stat: (NodeStatus & { _stale?: boolean }) | null = n.last_status
                  ?? (n.prev_status ? { ...n.prev_status, _stale: true } : null)
                const lastTurn = n.turns?.[n.turns.length - 1]
                return (
                /* ⚠ THE ROW IS NOT ITSELF A BUTTON, which is what lets its
                   summary carry reference controls: a button inside a
                   `role="button"` is invalid nesting. The row navigates on
                   click, the MAIN LINE is the focusable button (Enter/Space
                   arrive as a click and bubble to the row's one handler, so
                   activation cannot fire twice), and the summary is a sibling
                   of that button. Nothing in the main line is interactive:
                   ContextWheel is only a button when given `onCompact`, which
                   the tray does not pass. */
                <div key={n.id} data-copy-agent-name={n.id}
                  className={'tray-row' + (n.state !== 'live' ? ' off' : '')
                    + (ghost ? ' ghost' : '')
                    + (n.tier && CODEX_TIERS.includes(n.tier) ? ' prov-openai'
                       : n.tier && ANTIGRAVITY_TIERS.includes(n.tier)
                         ? ' prov-google' : '')}
                  style={{ paddingLeft: 8 + depth * 14 }}
                  title={ghost
                    ? 'shown for context — this row does not match the '
                      + 'current filter, but a report under it does'
                    : undefined}
                  onClick={go}
                  /* the row's menu is the agent's own (canvas/agentmenu.tsx),
                     opened from the ROW — not from the main-line button —
                     because the summary line and the pin/popout controls are
                     part of the same object. NOT at compact, exactly where the
                     card itself has no menu either: there the card is a map
                     marker with no desk, no chips and no handlers (mapMode in
                     cards.tsx), so there would be nothing to be at parity
                     with. A right-click never navigates: `contextmenu` is not
                     `click`, and `go` is on the click. */
                  onContextMenu={(e) => {
                    if (!compact) menu.open(e, () => trayRowMenu(n, go, ask, deskNow))
                  }}>
                  <div className="tray-primary">
                    <button type="button" className="tray-main"
                    title={`go to ${n.id}`}>
                    <span className={'tier t-' + n.tier}>{TIER_LETTER[n.tier!] ?? '?'}</span>
                    {n.pending_switch &&
                      <span className="queued-mark" title={queuedSwitchTitle(n)}>
                        →{TIER_LETTER[n.pending_switch.tier] ?? '?'}</span>}
                    <span className="tray-name"
                      title={charterLine(n) || n.id}>{n.id}</span>
                    <ContextWheel occ={n.occupancy} cw={n.context_window}
                      est={n.occupancy_est} compactAt={tree.compact_at} />
                    <TrayStatus node={n} turn={lastTurn} live={n.state === 'live'} />
                    </button>
                  {/* ⚠ NO PER-AGENT CONTROLS HERE ANY MORE (user ruling
                      2026-09-12): the row's ⌖ pin and ↗ popout buttons are
                      gone, and both actions live in the row's context menu
                      with everything else the agent can do. The row is one
                      object again — a name you press to go there — rather
                      than a name with two tiny controls competing for the
                      same press. */}
                  </div>
                  {/* ⚠ THE WHOLE SUMMARY, MATCHED BEFORE ANY TRUNCATION: a
                      slice here cuts tokens in half, and the clipping is the
                      stylesheet's job (`.tray-sum-text` is ellipsis-clipped).
                      The AGE is its own element so the ellipsis eats the
                      summary's tail rather than the one fact beside it that
                      the summary does not contain. */}
                  {stat?.summary && (
                    <div className={'tray-sum' + (stat._stale ? ' stale' : '')}
                      title={stat.summary}>
                      <span className="tray-sum-text">
                        {stat.status}: <Written text={stat.summary} refs={canvasRefs} />
                      </span>
                      {stat.at && <span className="tray-sum-at"> · {ago(stat.at)} ago</span>}
                    </div>
                  )}
                </div>
                )
              })
            }} />
          </div>
          </PinFrame>
        )}
        <button className="tray-toggle" title="every agent, by hierarchy"
          onClick={() => setTrayOpen((o) => !o)}>
          <ViewListIcon fontSize="inherit" /> agents
        </button>
      </div>
      </MaybePortal>
      {/* every overlay rides MaybePortal (mobile wave §2-②): `.viewport`
          carries touch-action:none, and a scroller nested inside it can
          never scroll by touch — the portal moves the overlay out of that
          DOM subtree ON MOBILE ONLY; desktop renders exactly as before. */}
      {configId && map.get(configId) && (
        /* §4.8: an archived seat arrives summarised and this panel needs its
           `scope`, so it waits for the detail fetch rather than throwing */
        <MaybePortal><NodeDetailGate slug={slug} node={map.get(configId)!}>
          {(n) => (
        <NodeConfig node={n} map={map} tree={tree} slug={slug}
          op={op} toast={toast} codexProvider={codexProvider}
          antigravityProvider={antigravityProvider} openrouterProvider={openrouterProvider}
          presence={presence}
          close={() => setConfigId(null)} />)}
        </NodeDetailGate></MaybePortal>
      )}
      {lineageId && map.get(lineageId) && (
        <MaybePortal><NodeDetailGate slug={slug} node={map.get(lineageId)!}>
          {(ln) => (
        <LineagePanel node={ln} op={op} slug={slug}
          presence={presence} userDisabled={userDisabled}
          map={map} onFocusAgent={centerOn}
          close={() => setLineageId(null)} />)}
        </NodeDetailGate></MaybePortal>
      )}
      {dogView && (tree.watchdogs ?? []).some((w) => w.id === dogView) && (
        <MaybePortal><WatchdogPanel slug={slug} toast={toast}
          dog={(tree.watchdogs ?? []).find((w) => w.id === dogView)!}
          close={() => setDogView(null)} /></MaybePortal>
      )}
      {restoredDocs.map(row => <DocReader key={row.key} slug={slug} docId={row.restore!.document!}
        pinKind={row.kind} toast={toast} refs={docRefs} close={() => {
          closeSavedWindow(row.key); setRestoredDocs(old => old.filter(r => r.key !== row.key))
        }} />)}
      {docView && (
        <MaybePortal><DocReader slug={slug} docId={docView} toast={toast}
          refs={docRefs}
          close={() => setDocView(null)} /></MaybePortal>
      )}
      {inboxId && map.get(inboxId) && (
        <MaybePortal><NodeInboxModal node={map.get(inboxId)!} slug={slug}
          toast={toast}
          tierOf={(id) => map.get(id)?.tier}
          hasAgent={(id) => map.has(id)}
          refs={canvasRefs}
          jumpTo={nodeInboxJump?.id ?? null} jumpSeq={nodeInboxJump?.seq}
          onFocusAgent={centerOn}
          close={() => { setInboxId(null); setNodeInboxJump(null) }} /></MaybePortal>
      )}
      {agentDocketId && map.has(agentDocketId) && (
        <MaybePortal><AgentDocketModal key={`${slug}/${agentDocketId}`} slug={slug}
          nid={agentDocketId} tree={tree} toast={toast} refs={canvasRefs}
          close={() => setAgentDocketId(null)} /></MaybePortal>
      )}
      {pileOpen && piles.get(pileOpen) && (
        <MaybePortal><PilePicker pile={piles.get(pileOpen)!} map={map} op={op} toast={toast}
          onPick={(nid) => { setFront(pileOpen, nid); setPileOpen(null) }}
          close={() => setPileOpen(null)} /></MaybePortal>
      )}
      {/* hide-retired: the token's list — the same picker the retired pile
          uses (ordering, turn stats, the op-gated delete-all row), fed a
          synthesized pile of the HIDDEN retirees under this parent. Picking
          one routes through centerOn, whose reveal hook shows the card and
          glides to it. */}
      {retiredOpen && prunedView.retiredByParent.has(retiredOpen) && (
        <MaybePortal><PilePicker map={map} op={op} toast={toast}
          pile={{ key: retiredOpen + '|h', parent: retiredOpen, kind: 'a',
            list: prunedView.retiredByParent.get(retiredOpen)!.map((c) => c.id),
            front: prunedView.retiredByParent.get(retiredOpen)![0]!.id }}
          onPick={(nid) => { setRetiredOpen(null); centerOn(nid) }}
          close={() => setRetiredOpen(null)} /></MaybePortal>
      )}
      {oiOpen && (
        <MaybePortal><OrgInboxModal inbox={tree.org_inbox} net={tree.net} map={map} slug={slug} toast={toast}
          jumpTo={oiJump?.id ?? null} jumpSeq={oiJump?.seq}
          refs={canvasRefs}
          onFocusAgent={centerOn}
          close={() => {
            setOiOpen(false); setOiJump(null)
            // closing the panel acknowledges the whole log (same idiom as the
            // eye's glow: opening acknowledges attention)
            if (tree.org_inbox?.unread) orgInboxRead(slug).catch(() => {})
          }} /></MaybePortal>
      )}
      {/* ---- the desk SHEET (D-123, mobile only): full-screen, portaled,
          authored 1:1 — DeskChat's `bare` mode is exactly the unscaled desk
          body the sheet needs. Explicit state; the camera never moves. */}
      {sheetId && map.get(sheetId) && (() => {
        const n = map.get(sheetId)!
        const myDogs = (tree.watchdogs ?? []).filter((w) => w.owner === sheetId)
        const sheetLastTurn = n.turns?.[n.turns.length - 1]
        return (
          <MaybePortal>
            <div className="mobsheet">
              <header className="mobsheet-head">
                <span className={'tier t-' + n.tier}>{TIER_LETTER[n.tier ?? ''] ?? '?'}</span>
                <b className="ms-name" data-copy-agent-name={n.id}>{n.id}</b>
                <TrayStatus node={n} turn={sheetLastTurn} live={n.state === 'live'} />
                <span className="spacer" />
                {myDogs.length > 0 &&
                  <button className="ms-btn" onClick={() => setSheetDogs((v) => !v)}>
                    ◉ {myDogs.length}</button>}
                {n.state === 'live' && !tree.public &&
                  <button className="ms-btn" title="hire a report"
                    onClick={() => setHireOpen(true)}>＋</button>}
                <button className="ms-btn" title="inbox"
                  onClick={() => toggleNodeSurface('node-inbox', sheetId, setInboxId)}>✉</button>
                {!tree.public &&
                  <button className="ms-btn" title="permissions & settings"
                    onClick={() => toggleConfig(sheetId)}>⚙</button>}
                <button className="ms-btn ms-close" onClick={() => setSheetId(null)}>✕</button>
              </header>
              {sheetDogs && myDogs.length > 0 && (
                <div className="ms-doglist">
                  {myDogs.map((w) => (
                    <button key={w.id} className={(w.once ? 'oneshot ' : '') + w.state}
                      onClick={() => { toggleDog(w.id); setSheetDogs(false) }}>
                      <span className="wd-glyph">{w.state === 'armed' ? '◉'
                        : w.state === 'paused' ? '◫' : w.spent ? '↗' : '✕'}</span>
                      {w.once && <span className="wd-once" aria-label="one-shot dog">1×</span>}
                      {w.name} · {w.once ? 'one-shot dog · ' : ''}
                      {w.spent ? 'departing' : w.state}
                    </button>
                  ))}
                </div>
              )}
              <div className="mobsheet-body">
                <DeskChat bare node={n} map={map} op={op} slug={slug}
                  toast={toast} pub={!!tree.public} compactAt={tree.compact_at}
                  maxTop={tree.max_top_grant ?? 1000} pxc={pxPerCredit}
                  onMailLink={openMail} onWorkLink={openWork} onOpenDoc={setDocView}
                  onLineage={() => toggleNodeSurface('lineage', sheetId, setLineageId)}
                  onConfig={() => toggleConfig(sheetId)}
                  onJump={(id) => {
                    if (id !== USER && mapRef.current.has(id)) setSheetId(id)
                  }} />
              </div>
            </div>
          </MaybePortal>
        )
      })()}
      {hireOpen && sheetId && map.get(sheetId) && (
        <MaybePortal>
          <HireSheet anchor={map.get(sheetId)!} seats={seats} codexHire={codexHire}
            antigravityHire={antigravityHire} claudeHire={claudeHire}
            openrouterHire={openrouterHire}
            defaultGrant={!map.get(sheetId)!.parent ? (tree.default_top_grant ?? 50) : 0}
            onClose={() => setHireOpen(false)}
            onSettings={onAccounts ? () => {
              setHireOpen(false); onAccounts()
            } : undefined}
            onHire={(tier, name, grant, placement) => {
              const a = map.get(sheetId)!
              const parentOf = !a.parent || a.parent === USER ? null : a.parent
              const parent = placement === 'below' ? a.id : parentOf
              op({ op: 'hire', parent, tier, grant, name })
                .then((r) => {
                  const born = r?.node
                  if (typeof born === 'string' && born) {
                    // same follow-ups as the desktop chips: side = pin the
                    // promised ordering (best-effort, cosmetic); above = the
                    // FR-25 splice (loud on failure — it IS the point)
                    if (placement === 'left' || placement === 'right') {
                      void reorderNode(slug, born, placement === 'left'
                        ? { before: a.id } : { after: a.id }).catch(() => {})
                    }
                    if (placement === 'above') {
                      op({ op: 'move', node: a.id, new_parent: born })
                        .catch((e: Error) => toast([
                          `hired ${born}, but the splice failed: ${e.message}`]))
                    }
                    toast([`hired ${born}`])
                  }
                  setHireOpen(false)
                })
                .catch((e: Error) => toast([`hire failed: ${e.message}`]))
            }} />
        </MaybePortal>
      )}
      {restoreDesks.filter(([, id, generation]) => map.get(id)?.generation === generation).map(([, id, generation]) => {
        const n = map.get(id)!
        return <div className="popout-recovery restored-desk" key={JSON.stringify([id, generation])}>
          <div className="row"><b data-copy-agent-name={id}>{id} restored desk</b><button onClick={() => {
            centerOn(id); setRestoreDesks(old => old.filter(([, other]) => other !== id))
          }}>Return to canvas</button></div>
          <DeskChat bare node={n} map={map} op={op} slug={slug} toast={toast} pub={false}
            compactAt={tree.compact_at} maxTop={tree.max_top_grant ?? 1000} pxc={pxPerCredit}
            onMailLink={openMail} onWorkLink={openWork} onOpenDoc={setDocView} onJump={centerOn} />
        </div>
      })}
    </div></DeskHosts>
  )
}

/** compact hire form (D-125 ③): the four edge-gated chip sets depend on
 *  cursor-proximity tracking with no touch equivalent, so at compact hiring
 *  is a full-screen form — and it carries PLACEMENT, so the F-03 side-hire
 *  and FR-25 splice semantics survive: below (report), left/right (coworker
 *  ordering), above (new superior — the anchor moves under the hire). */
// exported for the rendered-surface tests, the same way `NodeConfig`,
// `LineagePanel` and `UsageModal` are: a hire is CHOSEN here, so the
// capability note this sheet draws needs a control that mounts the real
// component rather than a helper standing in for it.
export function HireSheet({ anchor, seats, codexHire, antigravityHire, claudeHire, openrouterHire,
  defaultGrant,
  onHire, onSettings,
  onClose }: {
  anchor: CanvasNode
  seats: Record<string, number>
  codexHire?: HireState | null
  antigravityHire?: HireState | null
  claudeHire?: HireState | null
  openrouterHire?: HireState | null
  defaultGrant: number
  onHire: (tier: string, name: string, grant: number,
    placement: 'below' | 'left' | 'right' | 'above') => void
  onSettings?: () => void
  onClose: () => void
}) {
  // D-199: which families this sheet may show, by the one shared rule.
  const famRows = useMemo(() => ([
    { key: 'claude', label: 'model tier — Claude', tiers: TIERS,
      letters: TIER_LETTER, hire: claudeHire,
      seatOf: (t: string) => seats[t] ?? TIER_SEAT[t] ?? 0 },
    { key: 'codex', label: 'Codex', tiers: CODEX_TIERS,
      letters: CODEX_TIER_LETTER, hire: codexHire,
      seatOf: (t: string) => seats[t] ?? CODEX_TIER_SEAT[t] ?? 0 },
    { key: 'antigravity', label: 'Antigravity', tiers: ANTIGRAVITY_TIERS,
      letters: ANTIGRAVITY_TIER_LETTER, hire: antigravityHire,
      seatOf: (t: string) => seats[t] ?? ANTIGRAVITY_TIER_SEAT[t] ?? 0 },
    // the OpenRouter family: the favorites, from the registry the payload
    // fills (their letters already live in TIER_LETTER)
    { key: 'openrouter', label: 'OpenRouter', tiers: openrouterTierIds(),
      letters: TIER_LETTER, hire: openrouterHire,
      seatOf: (t: string) => seats[t] ?? anyTierSeat(t) },
  ] as const)
    .map((f) => ({ ...f, offer: familyOffer(f.hire),
                   reason: f.hire?.reason ?? 'hiring is not enabled yet' }))
    // an OpenRouter row with no favorites yet has no buttons to draw
    .filter((f) => f.offer !== 'hide' && f.tiers.length > 0),
  // the registry is not React state: its ids ride the deps so a favorite
  // added while this sheet is open reaches the rows on the next payload
  [claudeHire, codexHire, antigravityHire, openrouterHire, seats,   // eslint-disable-line react-hooks/exhaustive-deps
   openrouterTierIds().join(',')])
  // ⚠ THE DEFAULT TIER IS THE FIRST OFFERABLE ONE, NOT A CONSTANT. It was the
  // literal 'sonnet', so on a machine with only Codex set up this sheet opened
  // pre-selected on a model that could not run — the same bug as the buttons,
  // one field over: the form's own initial value asserted an availability
  // nobody had checked. Falls back to '' when nothing is offerable, which the
  // submit guard below already treats as not-ready.
  // a codex row can carry tiers that are individually hidden (a legacy
  // token, an unconfirmed rollout tier — `tierOffer`), so the default can't
  // just be "the family's first tier" — it has to be the first tier that is
  // ITSELF offerable.
  const tierOffer = (f: (typeof famRows)[number], t: string): FamilyOffer =>
    f.key === 'codex' ? codexTierOffer(f.hire, t) : f.offer
  const firstOfferable = famRows
    .flatMap((f) => f.tiers.filter((t) => tierOffer(f, t) === 'offer'))[0] ?? ''
  const providersOff = [claudeHire, codexHire, antigravityHire, openrouterHire]
    .some((h) => h?.userEnabled === false)
  const [tier, setTier] = useState(firstOfferable)
  // the payload arrives after mount, so the first offerable tier can appear a
  // beat later; adopt it only while the user has not chosen for themselves
  const touched = useRef(false)
  useEffect(() => {
    if (!touched.current && firstOfferable && tier !== firstOfferable)
      setTier(firstOfferable)
  }, [firstOfferable])   // eslint-disable-line react-hooks/exhaustive-deps
  const pickTier = (t: string) => { touched.current = true; setTier(t) }
  const [name, setName] = useState('')
  const [grant, setGrant] = useState(defaultGrant)
  const [placement, setPlacement] =
    useState<'below' | 'left' | 'right' | 'above'>('below')
  const ok = /^[a-z][a-z0-9-]{1,29}$/.test(name.trim()) && !!tier
  return (
    <ModalOverPins><div className="overlay" onPointerDown={(e) => e.stopPropagation()}>
      <div className="settings hire-sheet">
        <h3>Hire{placement === 'below' ? ` under ${anchor.id}`
          : placement === 'above' ? ` above ${anchor.id}`
          : ` beside ${anchor.id}`}</h3>
        {/* each provider's tiers on their own row (user spec 2026-08-28) —
            the compact form's version of the canvas's mirrored rows.
            D-199: the SAME offer rule as the canvas chips, from the same
            `familyOffer` — a row whose CLI is not installed is not rendered
            at all, a row that is installed-but-signed-out renders disabled
            with its reason. This sheet used to show all three unconditionally
            and Claude always enabled. */}
        {famRows.map((f) => (
          <Fragment key={f.key}>
            <div className="field-label">
              {f.offer === 'offer' ? f.label : `${f.label} — ${f.reason}`}</div>
            <div className="hs-tiers">
              {f.tiers.map((t) => {
                const tOffer = tierOffer(f, t)
                // 'hide' is a tier that leaves the sheet entirely, not one
                // rendered disabled — user ruling 2026-09-02 about the
                // gpt-reserve token (now a legacy token no surface offers),
                // applied here from the same `codexTierOffer` the canvas
                // chips read.
                if (tOffer === 'hide') return null
                // the OpenRouter catalog's tool declaration, from the ONE
                // shared formatter ('' for every static tier). The sheet is
                // where a hire is actually chosen, so the note belongs here
                // and not only back in the catalog picker. Visible text, and
                // the tooltip too where the row is not already explaining a
                // refusal - a disabled row's reason keeps priority.
                // All three declarations since unit C (2026-09-05).
                const tools = tierCapabilityNotes(t)
                return (
                  <button key={t}
                    className={'hs-tier t-' + t + (tier === t ? ' on' : '')}
                    disabled={tOffer !== 'offer'}
                    title={tOffer === 'offer' ? (tools || undefined) : f.reason}
                    onClick={() => pickTier(t)}>
                    <span className={'tier t-' + t}>{f.letters[t]}</span>
                    {tierLabel(t)} · seat {fmtCredits(f.seatOf(t))}
                    {tools ? <span className="dim"> · {tools}</span> : null}
                  </button>
                )
              })}
            </div>
          </Fragment>
        ))}
        {!famRows.length && (
          providersOff && onSettings
            ? <button className="hs-none hs-none-row" onClick={onSettings}>
              providers are off · App settings → Providers
            </button>
            : <div className="field-label hs-none-row">
              {providersOff
                ? 'providers are off · App settings → Providers'
                : 'no agent harness is set up on this machine'}
            </div>
        )}
        <div className="field-label">placement</div>
        <div className="hs-place">
          {([['below', 'report — under ' + anchor.id],
             ['left', 'coworker — before it'],
             ['right', 'coworker — after it'],
             ['above', 'superior — ' + anchor.id + ' moves under the hire']] as const)
            .map(([p, lbl]) => (
              <button key={p} className={'ask-row' + (placement === p ? ' on' : '')}
                onClick={() => setPlacement(p)}>
                <span className={'ask-dot' + (placement === p ? ' on' : '')} />
                <span className="ask-row-body">{lbl}</span>
              </button>
            ))}
        </div>
        <div className="field-label">name</div>
        <input value={name} placeholder="lowercase-slug"
          onChange={(e) => setName(e.target.value.toLowerCase())} />
        <div className="field-label">credit grant</div>
        <input type="number" min={0} value={grant}
          onChange={(e) => setGrant(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
        <div className="row">
          <button className="primary" disabled={!ok}
            onClick={() => onHire(tier, name.trim(), grant, placement)}>hire</button>
          <button onClick={onClose}>cancel</button>
        </div>
      </div>
    </div></ModalOverPins>
  )
}
