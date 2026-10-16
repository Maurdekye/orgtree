/* EPIC Mode — the director. LOADED ONLY WHILE EPIC MODE IS ON.

   sync.ts imports this module the moment the switch turns on (never before),
   and `startEpic` wires up the whole show for one window:

   • the STAGE — a canvas over the window (stage.ts), plus one more in every
     popped-out window, so an effect lands wherever its subject is drawn;
   • the SYNTH — one AudioContext (audio.ts); every sound is generated;
   • the TAPS — App.tsx hands over every org-socket frame and every published
     org tree (tap.ts). Trees are reduced to snapshots and diffed (diff.ts):
     hires, retirements, moves, freezes, halts, turns, tools, questions,
     documents, credits, the docket, the inbox, watchdogs…;
   • the HANDS — capture-phase, passive listeners for what the user does:
     clicks, typing, scrolling the canvas, dragging cards, menus, copy and
     paste; and one MutationObserver for what pops up: dialogs, menus, toasts.

   Every one of them is undone by the stop function. While EPIC Mode is off
   none of this module's code has even been loaded.

   THE PLAYBOOK below gives every event its own picture and its own sound —
   the user's examples first: FREEZE is an ice spike, an INTERRUPT is a stop
   sign slammed down, a MESSAGE SPARK is a lightning zap.

   THE FINAL VERSION (docs/rust-engine/epic-mode-final.md) is the Opus take's
   director with the best of the other three folded in, as one system:
   • RISING PITCH — the frequent little sounds climb up to an octave
     through a burst, so a busy organization audibly heats up;
   • WEIGHT — a medium event shakes the window lightly and blurs its edges,
     a heavy one shakes it and blurs it whole (user 2026-10-15: "more screen
     shake effects and screen blurs"), within the stage's comfort bounds;
   • LINGER and PROGRESS — what a strike leaves lingers (the stage's
     residue, and an afterglow where each medium or heavy event happened),
     and the session's progression (epic/progress.ts: momentum, charge,
     level, chains) grows the show with the org's activity (user
     2026-10-15: "more lingering effects that remain on screen for longer",
     "more progressive idle game mechanics");
   • WHO — impact words carry the agent's name (the Argon and Astra takes);
   • the crystal ice spike (Argon), the summoning portal (Astra, Argon), the
     watchdog radar and ping (Astra, Argon), streamed text played as each
     agent's own pentatonic run (Argon), the button pop and confirming
     clicks (Wonder Full);
   • REFUSED — a change the engine turns down gets its own alarm, and an
     interrupt gets its stop sign only once the engine accepted it (Astra);
   • OTHER ORGS — the app feed's notices from organizations this window does
     not draw (Wonder Full, Astra), in the window the user is looking at;
   • a usage reading of 100% is a reading, never a limit (Astra; user
     2026-10-14): only a frozen or limit-locked agent says LIMIT HIT. */
import { EpicSynth, type AudioContextCtor, type PlayOptions, type SoundName } from './audio'
import { Stage, type Rect } from './stage'
import { setEpicTaps } from './tap'
import * as progress from './progress'
import {
  diffOrg, isInboxEnd, isUserEnd, pulseEvent, snapshotOrg, sparkEvent, streamEvent,
  type EpicEvent, type EventKind, type OrgSnap,
} from './diff'
import { locate, spotOfElement, type Spot } from './locate'
import { openSurfaces, subscribeWindows } from '../windowlife'
import { appNoticesNow, appValueNow, watchAppFeed } from '../appfeed'
import type { UsagePeek } from '../types'

/** Host readouts carry identity beside their limits; aggregate peeks may not. */
type UsageReading = UsagePeek & {
  account?: string
  email?: string | null
  label?: string | null
  observed_at?: string | null
}
const USAGE_FRESH_S = 900 // engine usage.rs PEEK_MAX
const usageWindow = (limit: NonNullable<UsagePeek['limits']>[number]): string =>
  JSON.stringify([limit.kind, limit.group ?? '', limit.label ?? '', limit.model ?? ''])

export interface EpicOptions {
  /** the window to run in (default: this one) */
  view?: Window
  /** the AudioContext constructor: default the window's own; null for a
   *  silent show (or where the platform has none) */
  audio?: AudioContextCtor | null
  /** how EPIC Mode arrived: the user just turned it on, or a window opened
   *  with it already on */
  greet?: 'enable' | 'launch' | 'none'
}

export interface EpicShow {
  /** End the show. `farewell` plays the power-down first, then tears down;
   *  `quiet` keeps that power-down silent (a window that only followed the
   *  switch from another window). */
  stop(opts?: { farewell?: boolean; quiet?: boolean }): void
  /** for tests and the curious: how many effects have been staged */
  readonly staged: number
  /** a direct cue, for anything outside the taps */
  cue(kind: Kind, ev?: Partial<Omit<Act, 'kind'>> & { spot?: Spot | null }): void
}

/** user actions, seen by the listeners rather than the org's data */
export type DomKind =
  | 'click' | 'toggle' | 'select' | 'tab' | 'type' | 'enter' | 'erase'
  | 'zoomIn' | 'zoomOut' | 'pan' | 'grab' | 'drop' | 'menu' | 'copy' | 'paste'
  | 'dialogOpen' | 'dialogClose' | 'toast' | 'toastError' | 'popup' | 'fileDrop'
  | 'send' | 'destroy' | 'epicOn' | 'epicLaunch' | 'epicOff'
  | 'scroll' | 'focus' | 'undo' | 'redo' | 'shortcut' | 'doubleClick'
  // a click on a control that confirms: save, apply, create, OK … (Wonder Full)
  | 'confirm'
  // arrow, page, home and end keys outside text fields (Astra)
  | 'navigate'
  // staged by the director itself: a usage limit learned just after the ice
  | 'brownout'
  // the org socket dropping and coming back (an engine restart, a sleep)
  | 'linkDown' | 'linkUp'
  // the app feed's usage readings crossing a line: 90%, 100% (a reading,
  // never a limit), and back under 100%
  | 'usageWarn' | 'usageMax' | 'usageReset'
  // a change the engine refused (api.ts's request tap)
  | 'refused'
  // another org's routine notice (the app feed)
  | 'notice'

/** everything the playbook knows how to stage */
export type Kind = EventKind | DomKind

/** one thing to stage: an org event, or something the user did */
export interface Act extends Omit<EpicEvent, 'kind'> {
  kind: Kind
  /** who it happened to, written under the effect's word (default: `node`) */
  caption?: string
  /** the app feed notice it came from (another org's): an alarm it starts
   *  ends when that notice goes, its mail read */
  notice?: string
}

/* Burst pitch: private event count only, with no meter or milestone effects. */
const BURST_DECAY_MS = 2500
/** continuous gestures and shutdown do not raise the pitch */
const UNCOUNTED: ReadonlySet<Kind> = new Set<Kind>(['pan', 'epicOff'])
/** the frequent little sounds climb up to an octave at 36 events */
const CLIMB: ReadonlySet<SoundName> = new Set<SoundName>([
  'click', 'type', 'tick', 'blip', 'toolDone', 'warp', 'grab', 'scribble', 'clack', 'notice', 'tool', 'confirm',
])
export const climbFor = (burst: number): number => 2 ** (Math.min(Math.max(burst, 0), 36) / 36)

/** an agent's streamed text as notes (the Argon take's arpeggio): up and down
 *  the major pentatonic, each agent from its own degree so several writers
 *  sound like one chord */
const PENTA = [0, 2, 4, 7, 9]
const RUN = [0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1]
export function noteRatio(agent: string, step: number): number {
  let h = 0
  for (let i = 0; i < agent.length; i++) h = (h * 31 + agent.charCodeAt(i)) | 0
  const degree = RUN[step % RUN.length]! + (Math.abs(h) % 5)
  const semis = 12 * Math.floor(degree / 5) + PENTA[degree % 5]!
  return 2 ** (semis / 12)
}

/** what another org's notice is staged as (DesktopNotification kinds) */
const NOTICE_KINDS: Record<string, Kind> = {
  question: 'question', 'urgent-mail': 'urgent', 'terminal-failure': 'error', 'agent-frozen': 'freeze',
  'work-attention': 'attention', document: 'docs', routine: 'notice',
}
interface NoticeRow { id?: unknown; org?: unknown; agent?: unknown; kind?: unknown }

const GOLD = '#ffd34d'
const ICE = '#bfefff'
const RED = '#ff3b3b'
const GREEN = '#3dff8a'
const PURPLE = '#c58bff'
const CYAN = '#5fe3ff'
const ORANGE = '#ff8a2a'
const PINK = '#ff5ccf'
const GREY = '#9aa3ad'

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo)
const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!

/** a theater is one window's stage and the listeners on its document */
interface Theater {
  view: Window
  doc: Document
  stage: Stage
  detach: () => void
}

/** an effect's context: where it happens, and the event itself */
interface Cue {
  ev: Act
  /** the org it happened in, when it came from the org's data */
  org: string | null
  /** where the event happened (a fallback spot when nothing was found) */
  at: Spot
  /** the other end, for two-ended events, when it could be found */
  from: Spot | null
  t: Theater
  show: Show
}

/** the minimum gap (ms) between two cues of one kind for one subject */
const GAP: Partial<Record<Kind, number>> = {
  type: 22, erase: 40, zoomIn: 70, zoomOut: 70, pan: 45, tool: 60, toolDone: 60,
  // writing plays one note of its agent's run per gap: a melody, not a buzz
  thinking: 900, writing: 240, credits: 250, cost: 3000, queued: 300, mailbox: 300,
  ready: 400, wake: 300, sleep: 300, settings: 400, reorder: 300, toast: 120,
  dialogOpen: 150, dialogClose: 150, popup: 120, menu: 120, scroll: 140, focus: 80, shortcut: 120, navigate: 70,
  linkDown: 4000, linkUp: 4000, confirm: 60, refused: 400, notice: 300,
  // an interrupt is seen by the API tap and again as the killed turn
  interrupt: 3000,
}

/** sounds kept quieter so the loud events stay readable over them */
const SOFT: Partial<Record<SoundName, number>> = {
  type: 0.7, tick: 0.5, blip: 0.6, toolDone: 0.6, warp: 0.5, scribble: 0.5,
}

class Show implements EpicShow {
  readonly view: Window
  readonly doc: Document
  private main: Theater
  private extra = new Map<Window, Theater>()
  private synth: EpicSynth | null = null
  private snaps = new Map<string, OrgSnap>()
  private lastAt = new Map<string, number>()
  private lastRect = new Map<string, Rect>()
  private linkDown = new Set<string>()
  private usage = new Map<string, number>()
  /** other orgs' notices already seen (null until the first read: the baseline) */
  private noticed: Set<string> | null = null
  /** each agent's place in its pentatonic run */
  private runs = new Map<string, number>()
  /** where and when the user last pressed, for effects with no subject */
  private pressed: { x: number; y: number; doc: Document; at: number } | null = null
  private cleanups: (() => void)[] = []
  /** urgent mail's alarm while it sounds: whose mail it is (this window's org,
   *  or another org's notice), and how to end it */
  private alarm: { org: string | null; notice: string | null; end: () => void } | null = null
  private ended = false
  private count = 0
  /** the lift of the event being staged (progression), for the little sounds' climb */
  private lift = 1
  private burstN = 0
  private burstAt = -Infinity

  constructor(opts: EpicOptions) {
    this.view = opts.view ?? window
    this.doc = this.view.document
    const Ctor = opts.audio === undefined
      ? ((this.view as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }).AudioContext
        ?? (this.view as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext ?? null)
      : opts.audio
    if (Ctor) {
      try { this.synth = new EpicSynth(Ctor) } catch { this.synth = null }
    }
    this.main = this.theater(this.view)
    // the org's own data, handed over by App.tsx and api.ts
    setEpicTaps({
      frame: (org, frame) => this.onFrame(org, frame),
      tree: (org, tree) => this.onTree(org, tree),
      action: (org, kind, node) => this.onAction(org, kind, node),
      refused: (_path, status) => this.onRefused(status),
    })
    this.cleanups.push(() => setEpicTaps(null))
    // the app feed: usage readings crossing 90% and 100%, and resetting; and
    // the notices of every other org
    this.cleanups.push(watchAppFeed(() => this.onAppFeed()))
    this.onAppFeed()
    // popped-out windows each get their own stage and listeners
    const sync = () => this.syncWindows()
    this.cleanups.push(subscribeWindows(sync))
    sync()
    const greet = opts.greet ?? 'none'
    if (greet === 'enable') this.cue('epicOn')
    else if (greet === 'launch') this.cue('epicLaunch')
  }

  get staged(): number { return this.count }

  get burst(): number { return performance.now() - this.burstAt < BURST_DECAY_MS ? this.burstN : 0 }

  /** Keep the pitch climb's count on the event path: no timers or readouts. */
  private feedBurst(kind: Kind): void {
    if (UNCOUNTED.has(kind)) return
    const now = performance.now()
    this.burstN = now - this.burstAt < BURST_DECAY_MS ? this.burstN + 1 : 1
    this.burstAt = now
  }

  /** the next note of an agent's pentatonic run, as a pitch multiplier */
  noteFor(agent: string): number {
    const step = this.runs.get(agent) ?? 0
    if (this.runs.size > 400) this.runs.clear()
    this.runs.set(agent, step + 1)
    return noteRatio(agent, step)
  }

  /** where the user last pressed, while that is recent enough to be the
   *  place an effect without a subject belongs */
  pressedSpot(ms = 4000): Spot | null {
    const p = this.pressed
    return p && performance.now() - p.at < ms ? { x: p.x, y: p.y, rect: null, el: null, doc: p.doc } : null
  }
  notePress(x: number, y: number, doc: Document): void { this.pressed = { x, y, doc, at: performance.now() } }

  /* ── windows ──────────────────────────────────────────────────────── */

  private theater(view: Window): Theater {
    const doc = view.document
    const stage = new Stage(doc)
    stage.afterimages = progress.unlocked().includes('afterimages')
    const t: Theater = { view, doc, stage, detach: () => {} }
    t.detach = attachHands(this, t)
    return t
  }

  private syncWindows(): void {
    if (this.ended) return
    const live = new Set<Window>()
    for (const s of openSurfaces()) {
      const w = s.window
      let closed = false
      try { closed = w.closed } catch { closed = true }
      if (!w || closed || w === this.view || !w.document?.body) continue
      live.add(w)
      if (!this.extra.has(w)) {
        try { this.extra.set(w, this.theater(w)) } catch { /* a window that is going away */ }
      }
    }
    for (const [w, t] of this.extra) {
      if (!live.has(w)) { this.extra.delete(w); t.detach(); t.stage.destroy() }
    }
  }

  private theaters(): Theater[] { return [this.main, ...this.extra.values()] }
  private theaterOf(doc: Document): Theater {
    for (const t of this.theaters()) if (t.doc === doc) return t
    return this.main
  }
  /** the theater drawing a document (the main window's when it has none) */
  theaterFor(doc: Document): Theater { return this.theaterOf(doc) }

  /* ── the taps ─────────────────────────────────────────────────────── */

  private onFrame(org: string, frame: unknown): void {
    if (this.ended) return
    const link = frame as { type?: unknown; up?: unknown } | null
    if (link?.type === 'epic_link') {
      // the first open of a window's socket is not news; a drop and its
      // return are
      if (link.up === false) { this.linkDown.add(org); this.cue('linkDown') }
      else if (this.linkDown.delete(org)) this.cue('linkUp')
      return
    }
    const ev = sparkEvent(frame) ?? pulseEvent(frame) ?? streamEvent(frame)
    if (!ev) return
    // a turn's end and a freeze are also seen in the next tree: the first
    // sighting wins and the echo is swallowed by the gate
    this.stageEvent(org, ev)
  }

  private onTree(org: string, tree: Parameters<typeof snapshotOrg>[0]): void {
    if (this.ended) return
    let snap: OrgSnap
    try { snap = snapshotOrg(tree) } catch { return }
    const prev = this.snaps.get(org)
    this.snaps.set(org, snap)
    // an urgent mail was read: its alarm stops
    if (prev && snap.urgent < prev.urgent && this.alarm?.org === org) this.alarm.end()
    const events = diffOrg(prev, snap)
    // a burst of hundreds (a whole subtree moved) is staged as its first few
    for (const ev of events.slice(0, 40)) this.stageEvent(org, ev)
    this.rememberRects(org, snap)
  }

  private onAction(org: string, kind: string, node: string): void {
    if (this.ended) return
    if (kind === 'interrupt') this.stageEvent(org, { kind: 'interrupt', node })
  }

  /** A change the engine refused: where the user just pressed, if they did. */
  private onRefused(status: number): void {
    if (this.ended) return
    this.cue('refused', { spot: this.pressedSpot(), text: status ? `HTTP ${status}` : undefined })
  }

  private onAppFeed(): void {
    if (this.ended) return
    this.onUsage()
    this.onNotices()
  }

  /** Other orgs' notices (the Wonder Full and Astra takes): the app feed's
   *  cross-org attention projection, the rows native notifications come
   *  from. An org this window draws is staged from its own tree instead, and
   *  every window holds the same feed, so a notice plays only in the window
   *  the user is looking at. The first read is the baseline. */
  private onNotices(): void {
    let read: { current: boolean; notices: unknown[] }
    try { read = appNoticesNow() } catch { return }
    const now = new Map<string, NoticeRow>()
    for (const raw of read.notices) {
      const n = raw as NoticeRow | null
      if (n && typeof n.id === 'string' && typeof n.org === 'string') now.set(JSON.stringify([n.org, n.id]), n)
    }
    // the baseline is the first COMPLETE copy: what waited before EPIC Mode
    // turned on is history, not news
    if (!this.noticed) { if (read.current) this.noticed = new Set(now.keys()); return }
    const fresh: [string, NoticeRow][] = []
    for (const [key, n] of now) if (!this.noticed.has(key)) { this.noticed.add(key); fresh.push([key, n]) }
    // a resolved notice is forgotten, so the set never grows with history;
    // the alarm its urgent mail started ends with it: that mail was read
    for (const key of this.noticed) {
      if (now.has(key)) continue
      this.noticed.delete(key)
      if (this.alarm?.notice === key) this.alarm.end()
    }
    if (!fresh.length || !this.looking()) return
    for (const [key, n] of fresh.slice(0, 4)) {
      const org = n.org as string
      if (this.snaps.has(org)) continue
      const kind = NOTICE_KINDS[typeof n.kind === 'string' ? n.kind : ''] ?? 'notice'
      const docs = this.theaters().map(t => t.doc)
      const caption = [typeof n.agent === 'string' ? n.agent : '', org].filter(Boolean).join(' · ')
      this.cue(kind, { spot: anchorFor(kind, docs), caption, notice: key })
    }
  }

  /** whether the user is looking at one of this show's windows */
  private looking(): boolean {
    for (const t of this.theaters()) {
      try { if (t.doc.hasFocus()) return true } catch { /* a window going away */ }
    }
    return false
  }

  /** Usage readings (the same cache-only peeks the header's usage button
   *  reads): the first sight of each limit is the baseline; crossing 90% and
   *  100% and dropping back under 100% are staged at the usage button. A
   *  reading of 100% is staged as a reading, never as a limit: an account at
   *  100% can still have credit to spend (the Astra take; user 2026-10-14). */
  private onUsage(): void {
    if (this.ended) return
    for (const key of USAGE_KEYS) {
      const peek = appValueNow<UsageReading>(key)
      // The host readout and its peek publish separately. Keep identity and
      // limits from one document, rather than pairing a new login with an
      // older peek. Older feeds exposing only a peek still work.
      const full = appValueNow<UsageReading>(key.replace(/_peek$/, ''))
      if (peek && !peek.available) continue
      if (peek?.age !== undefined && (!Number.isFinite(peek.age) || peek.age >= USAGE_FRESH_S)) continue
      // Peeks can project an expired window as unknown (Muse). A changed
      // raw readout can also arrive before its matching peek. Accept a full
      // window only when the peek confirms that same value, never copying
      // an old peek's percent into the new account's document.
      const reading = full && peek ? { ...full, limits: full.limits?.filter(limit =>
        peek.limits?.some(p => usageWindow(p) === usageWindow(limit) && p.percent === limit.percent)) } : full ?? peek
      this.readUsage(key, reading, peek?.provider)
    }
    // The glow's combined OpenRouter peek flattens identical credit windows
    // from different accounts. Its named cache is the account-safe source.
    const keys = appValueNow<Record<string, UsageReading>>('openrouter_keys_usage')
    for (const [account, reading] of Object.entries(keys ?? {})) {
      this.readUsage('openrouter_keys_usage', reading, 'openrouter', account)
    }
  }

  private readUsage(key: string, reading: UsageReading | undefined, provider?: string, account?: string): void {
    if (!reading?.available) return
    if (reading.age !== undefined && (!Number.isFinite(reading.age) || reading.age >= USAGE_FRESH_S)) return
    if (reading.observed_at) {
      const observed = Date.parse(reading.observed_at)
      if (!Number.isFinite(observed) || Date.now() - observed >= USAGE_FRESH_S * 1000) return
    }
    for (const limit of reading.limits ?? []) {
      const percent = limit.percent
      if (typeof percent !== 'number' || !Number.isFinite(percent)) continue
      // A tuple avoids delimiter collisions, and group distinguishes windows
      // whose kind/label/model are otherwise identical. No reset timestamp:
      // rolling deadlines change while the actual window remains the same.
      const id = JSON.stringify([key, provider ?? reading.provider ?? '', account ?? reading.account ?? '',
        reading.email ?? reading.label ?? '', usageWindow(limit)])
      const was = this.usage.get(id)
      this.usage.set(id, percent)
      if (was === undefined || was === percent) continue
      const spot = anchorSpot('button[title*="usage" i], .usage-history-btn', this.theaters().map(t => t.doc))
      const name = (provider || reading.provider || key.replace(/_?usage_peek$/, '') || 'claude').toUpperCase()
      if (was < 100 && percent >= 100) this.cue('usageMax', { spot, text: name })
      else if (was < 90 && percent >= 90) this.cue('usageWarn', { spot, text: name, n: percent })
      else if (was >= 100 && percent < 100) this.cue('usageReset', { spot, text: name })
    }
  }

  /** cards move; remember where each one was, so a move can start there.
   *  One scan of the cards, at most a few times a second. */
  private rectsAt = 0
  private rememberRects(org: string, _snap: OrgSnap): void {
    const now = performance.now()
    if (now - this.rectsAt < 400) return
    this.rectsAt = now
    if (this.lastRect.size > 2000) this.lastRect.clear()
    let root: ParentNode = this.doc
    for (const v of this.doc.querySelectorAll('[data-pin-org]')) if (v.getAttribute('data-pin-org') === org) { root = v; break }
    for (const card of root.querySelectorAll('[data-first-use-agent]')) {
      const id = card.getAttribute('data-first-use-agent')
      const r = card.getBoundingClientRect()
      if (id && r.width > 0 && r.height > 0) this.lastRect.set(org + '\u0000' + id, { x: r.left, y: r.top, w: r.width, h: r.height })
    }
  }

  /* ── staging ──────────────────────────────────────────────────────── */

  /** true when this kind for this subject fired too recently; otherwise
   *  records this firing and answers false */
  private gated(kind: string, subject: string, ms: number): boolean {
    const key = kind + '\u0000' + subject
    const now = performance.now()
    const last = this.lastAt.get(key) ?? -Infinity
    if (ms && now - last < ms) return true
    this.lastAt.set(key, now)
    if (this.lastAt.size > 4000) this.lastAt.clear()
    return false
  }

  /** did this kind fire for this subject in the last `ms`? (reads only) */
  private recent(kind: string, subject: string, ms: number): boolean {
    const last = this.lastAt.get(kind + '\u0000' + subject)
    return last !== undefined && performance.now() - last < ms
  }
  /** did a subject-less cue of this kind fire in the last `ms`? */
  firedWithin(kind: Kind, ms: number): boolean { return this.recent(kind, '', ms) }

  private fallbackSpot(): Spot {
    const v = this.view
    const w = v.innerWidth || 800, h = v.innerHeight || 600
    return { x: w * rand(0.3, 0.7), y: h * rand(0.3, 0.65), rect: null, el: null, doc: this.doc }
  }

  stageEvent(org: string | null, raw: EpicEvent): void {
    if (this.ended) return
    let ev: Act = raw
    const who = ev.node ?? ''
    // A freeze is announced twice — the `frozen` pulse, then the tree — and
    // the tree may know more (a usage limit). The ice plays once; a limit
    // learned after the ice adds only the brown-out.
    if (ev.kind === 'freeze' && this.recent('limit', who, 2500)) return
    if (ev.kind === 'limit' && this.recent('freeze', who, 2500)) {
      if (this.gated('limit', who, 2500)) return
      ev = { ...ev, kind: 'brownout' }
    }
    // turn ends also arrive twice (pulse + tree): one effect each
    const echo = ev.kind === 'turnEnd' || ev.kind === 'freeze' || ev.kind === 'limit' ? 1500 : 0
    if (ev.kind !== 'brownout' && this.gated(ev.kind, who, echo || GAP[ev.kind] || 0)) return
    // The tap runs as the tree is handed to React, before it renders: a card
    // that is new (a hire) or newly named is not on screen yet. Look for it
    // once React has drawn it.
    const place = () => {
      if (this.ended) return
      const docs = this.theaters().map(t => t.doc)
      let at = this.where(org, ev.node)
      if (!at && ev.kind === 'move') at = this.lastSpot(org, ev.node)
      const from = ev.other !== undefined && TWO_ENDED.has(ev.kind) ? this.where(org, ev.other) : null
      const anchor = at ?? anchorFor(ev.kind, docs) ?? this.fallbackSpot()
      this.perform({ ev, org, at: anchor, from, t: this.theaterOf(anchor.doc), show: this })
    }
    if (AFTER_RENDER.has(ev.kind)) this.view.setTimeout(place, 140)
    else place()
  }

  /** where an agent (or `@user`, `org_inbox`, `dog:<id>`) is drawn now */
  where(org: string | null, who: string | undefined): Spot | null {
    return locate(this.theaters().map(t => t.doc), org, who)
  }

  /** where an agent's card was last seen, for a move's departure */
  lastSpot(org: string | null, who: string | undefined): Spot | null {
    const r = org && who ? this.lastRect.get(org + '\u0000' + who) : undefined
    return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2, rect: r, el: null, doc: this.doc } : null
  }

  /** Stage one effect directly: at `spot`, else at `node` wherever it is
   *  drawn (with `other` as a two-ended effect's far end), else somewhere
   *  central. The user's hands come in this way, and so can anything else. */
  cue(kind: Kind, ev: Partial<Omit<Act, 'kind'>> & { spot?: Spot | null } = {}): void {
    if (this.ended) return
    const { spot = null, ...rest } = ev
    if (GAP[kind] && this.gated(kind, rest.node ?? '', GAP[kind]!)) return
    const at = spot ?? this.where(null, rest.node) ?? this.fallbackSpot()
    const from = rest.other !== undefined ? this.where(null, rest.other) : null
    this.perform({ ev: { ...rest, kind }, org: null, at, from, t: this.theaterOf(at.doc), show: this })
  }

  private perform(c: Cue): void {
    const play = PLAYBOOK[c.ev.kind]
    if (!play) return
    this.count++
    const gain = this.grow(c)
    if (gain.unlock?.extra === 'afterimages') for (const t of this.theaters()) t.stage.afterimages = true
    const stage = c.t.stage
    stage.intensity = 1 + (gain.lift - 1) / 2
    this.lift = gain.lift
    try { play(c) } catch { /* one effect failing must never break the app */ }
    try { felt(c, gain.lift) } catch { /* likewise */ }
    try { this.extras(c, gain) } catch { /* likewise */ }
    stage.intensity = 1
    this.lift = 1
    this.feedBurst(c.ev.kind)
  }

  /** Progression (epic/progress.ts): the event's weight feeds momentum, its
   *  agent's charge and the session's level. The org's own light events count
   *  a little, the user's own hands not at all. */
  private grow(c: Cue): progress.Gain {
    const kind = c.ev.kind
    const weight = WEIGHT[kind] ?? (c.org !== null ? 0.15 : 0)
    const agent = c.ev.node ? `${c.org ?? ''}/${c.ev.node}` : undefined
    const other = MEETS.has(kind) && c.ev.other ? `${c.org ?? ''}/${c.ev.other}` : undefined
    return progress.feed(weight, performance.now(), agent, other)
  }

  /** what progression adds to an event: a crossed tier makes what lingers
   *  flare, an unlock is announced in the corner, and the extras unlocked so
   *  far play — embers for a heavy event, an echo ring, the aurora while
   *  momentum is high (afterimages are the stage's, see `perform`) */
  private extras(c: Cue, gain: progress.Gain): void {
    if (gain.tier) for (const t of this.theaters()) t.stage.chain()
    if (gain.unlock) this.main.stage.toast(`UNLOCKED · ${gain.unlock.label}`)
    const weight = WEIGHT[c.ev.kind]
    if (!weight) return
    const open = progress.unlocked()
    const s = c.t.stage
    if (weight >= 2 && open.includes('embers')) s.embers(c.at.x, c.at.y, { count: 8 })
    if (open.includes('echoes')) s.ring(c.at.x, c.at.y, { color: '#ffffff', radius: 60 + weight * 30, width: 2, life: 0.8, delay: 0.3 })
    if (open.includes('aurora') && auroraLevel() > 0) for (const t of this.theaters()) t.stage.aurora(auroraLevel)
  }

  /** play a sound, panned to where its picture is; the little frequent
   *  sounds climb through a burst, and a little more with momentum */
  sound(name: SoundName, c: Cue | null, opts: PlayOptions = {}): void {
    if (!this.synth) return
    const w = c ? (c.t.view.innerWidth || 1) : 1
    const pan = c ? Math.max(-1, Math.min(1, (c.at.x / w) * 2 - 1)) * 0.8 : 0
    const climb = CLIMB.has(name) ? climbFor(this.burst) * 2 ** ((this.lift - 1) / 8) : 1
    const pitch = opts.pitch !== undefined || climb !== 1 ? (opts.pitch ?? rand(0.95, 1.05)) * climb : undefined
    this.synth.play(name, { pan, ...opts, pitch, gain: (opts.gain ?? 1) * (SOFT[name] ?? 1) })
  }

  /** URGENT MAIL, the loudest moment in the show (user 2026-10-15: "a massive
   *  blaring alarm that tints and fades the entire screen", "not excessively
   *  loud but very attention demanding and obnoxious"): every window this
   *  show draws in is tinted in slow pulses under a banner, and the klaxon
   *  and a ping from the inbox sound once a pulse. It ends when the mail is
   *  read (onTree; for another org's notice, when that notice goes:
   *  onNotices), when the show stops, when another urgent mail starts its
   *  own, or by itself after URGENT_MS. */
  soundAlarm(c: Cue): void {
    this.alarm?.end()
    const caption = captionOf(c)
    const ends = this.theaters().map(t => t.stage.alarm({ period: URGENT_PULSE_MS / 1000, life: URGENT_MS / 1000, caption }).end)
    let timer = 0
    const end = () => {
      this.view.clearTimeout(timer)
      for (const fn of ends) fn()
      if (this.alarm === alarm) this.alarm = null
    }
    const alarm = { org: c.org, notice: c.ev.notice ?? null, end }
    this.alarm = alarm
    let pulses = Math.round(URGENT_MS / URGENT_PULSE_MS)
    const pulse = () => {
      if (this.alarm !== alarm) return
      this.sound('klaxon', c)
      c.t.stage.ring(c.at.x, c.at.y, { color: RED, radius: 240, width: 8, life: 0.7 })
      if (--pulses > 0) timer = this.view.setTimeout(pulse, URGENT_PULSE_MS)
      // the stage's tint fades itself out with its last pulse
      else timer = this.view.setTimeout(() => { if (this.alarm === alarm) this.alarm = null }, URGENT_PULSE_MS)
    }
    pulse()
  }

  /* ── the end ──────────────────────────────────────────────────────── */

  stop(opts: { farewell?: boolean; quiet?: boolean } = {}): void {
    if (this.ended) return
    this.ended = true
    this.alarm?.end()
    if (opts.quiet) { this.synth?.close(); this.synth = null }
    for (const fn of this.cleanups.splice(0)) { try { fn() } catch { /* already gone */ } }
    for (const t of this.theaters()) t.detach()
    const teardown = () => {
      for (const t of this.theaters()) t.stage.destroy()
      this.extra.clear()
      this.synth?.close()
      this.synth = null
    }
    if (opts.farewell) {
      const c: Cue = { ev: { kind: 'epicOff' }, org: null, at: this.fallbackSpot(), from: null, t: this.main, show: this }
      try { PLAYBOOK.epicOff!(c) } catch { /* skip the farewell */ }
      this.view.setTimeout(teardown, FAREWELL_MS)
    } else teardown()
  }
}

/** how long the power-down plays before the stage and the sound are gone */
export const FAREWELL_MS = 1600
/** how long urgent mail's alarm sounds at most, and one pulse of it: slow
 *  enough never to strobe (at least 0.4 s; at most three a second) */
export const URGENT_MS = 8000
const URGENT_PULSE_MS = 800
/** how far apart an effect's repeated flashes come: at most three a second,
 *  under the photosensitivity guideline (user 2026-10-15: "slow it to at most
 *  3 per second, keeping the same look"). 360 ms also lands a halt's first
 *  and last flash on the first and last beat of its alarm. */
const FLASH_EVERY_MS = 360

const TWO_ENDED = new Set<Kind>(['zap', 'userSend', 'toUser', 'bark', 'orgInbox', 'audience', 'unaudience'])
/** events whose card React has not drawn yet when the tree arrives */
const AFTER_RENDER = new Set<Kind>(['hire', 'rehire', 'rename'])

/** the app-feed keys holding usage readings */
const USAGE_KEYS = ['usage_peek', 'codex_usage_peek', 'antigravity_usage_peek', 'muse_usage_peek']

/** the first visible element matching a selector, in any window */
function anchorSpot(selector: string, docs: readonly Document[]): Spot | null {
  for (const doc of docs) {
    for (const el of doc.querySelectorAll(selector)) {
      const spot = spotOfElement(el)
      if (spot) return spot
    }
  }
  return null
}

/** where an org-level event points when it has no agent of its own */
function anchorFor(kind: Kind, docs: readonly Document[]): Spot | null {
  const sel: Partial<Record<Kind, string>> = {
    ticket: '.docket-bell', ticketDone: '.docket-bell', attention: '.docket-bell',
    userMail: '.ask-bell', urgent: '.ask-bell', creditRequest: '.ask-bell',
    externalMail: '.sq.orginbox', docs: '.doc-bell',
  }
  const s = sel[kind]
  if (!s) return null
  for (const doc of docs) {
    for (const el of doc.querySelectorAll(s)) {
      const spot = spotOfElement(el)
      if (spot) return spot
    }
  }
  return null
}

/* ── the hands: what the user does ──────────────────────────────────────── */

const CONTROL = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"], '
  + '[role="switch"], [role="checkbox"], [role="radio"], summary, select, label, input[type="checkbox"], '
  + 'input[type="radio"], input[type="range"], input[type="color"]'
const TYPEABLE = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="number"], '
  + 'input[type="email"], input[type="url"], input[type="password"], [contenteditable="true"], [contenteditable=""]'
const POPUPS = '.overlay, .ctxmenu, .toasts > *, .lb-overlay, .quickchat-pop, .picker, .shell-menu'
/** navigation keys, and the direction each one moves (radians) */
const NAV_KEYS: Record<string, number> = {
  ArrowUp: -Math.PI / 2, ArrowDown: Math.PI / 2, ArrowLeft: Math.PI, ArrowRight: 0,
  PageUp: -Math.PI / 2, PageDown: Math.PI / 2, Home: -Math.PI / 2, End: Math.PI / 2,
}
/** the controls that pop when pressed: buttons, not fields or whole labels */
const POPPABLE: ReadonlySet<string> = new Set(['BUTTON', 'SUMMARY', 'A'])

/** The event's target as an element. Duck-typed, not `instanceof`: nodes in a
 *  popped-out window were created by the opener's document and keep its
 *  prototypes, so `instanceof popout.Element` is false for every one of them. */
const asElement = (target: EventTarget | null): Element | null =>
  target && typeof (target as Element).closest === 'function' ? target as Element : null
const isField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement =>
  el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'

/** the world element of the canvas `el` is on, whose transform OrgCanvas
 *  writes as `translate(…) scale(<zoom>)`; null off the canvas */
const cameraOf = (el: Element): HTMLElement | null =>
  el.closest('.viewport')?.querySelector<HTMLElement>('.space') ?? null
const zoomOf = (space: HTMLElement | null): number | null => {
  const m = space ? /scale\(\s*([\d.e+-]+)\s*\)/.exec(space.style.transform) : null
  return m ? Number(m[1]) : null
}
/** how many frames a wheel's outcome is looked for: the browser's scroll and
 *  the canvas's re-render both land within a frame or two */
const WHEEL_FRAMES = 6
/** a frame of the window's own; jsdom has none, and the tests supply one */
function nextFrame(view: Window, cb: () => void): number {
  const v = view as Window & { requestAnimationFrame?: Window['requestAnimationFrame'] }
  return typeof v.requestAnimationFrame === 'function' ? v.requestAnimationFrame(cb) : globalThis.requestAnimationFrame(cb)
}
function cancelFrame(view: Window, id: number): void {
  const v = view as Window & { cancelAnimationFrame?: Window['cancelAnimationFrame'] }
  if (typeof v.cancelAnimationFrame === 'function') v.cancelAnimationFrame(id)
  else globalThis.cancelAnimationFrame(id)
}

function attachHands(show: Show, t: Theater): () => void {
  const { doc, view } = t
  const opts = { capture: true, passive: true } as const
  let press: { x: number; y: number; card: Element | null; canvas: boolean; moved: boolean } | null = null
  let lastTrail = 0
  let tabbedAt = -Infinity

  const at = (x: number, y: number, el: Element | null = null): Spot => ({ x, y, rect: null, el, doc })

  const onDown = (e: PointerEvent) => {
    const target = asElement(e.target)
    if (!target || target.closest('.epic-switch')) return
    const card = target.closest('[data-first-use-agent]')
    const canvas = !card && !!target.closest('.viewport') && !target.closest(CONTROL)
    press = { x: e.clientX, y: e.clientY, card, canvas, moved: false }
    show.notePress(e.clientX, e.clientY, doc)
    view.addEventListener('pointermove', onMove, opts)
    const control = target.closest(CONTROL)
    if (card) show.cue('grab', { spot: at(e.clientX, e.clientY, card) })
    else if (control) {
      const label = ((control.getAttribute('aria-label') || '') + ' ' + (control.getAttribute('title') || '')
        + ' ' + (control.textContent || '').slice(0, 60)).toLowerCase()
      const spot = at(e.clientX, e.clientY, control)
      // the pressed control pops (Wonder Full); what it changes in the org is
      // staged from the org's own data when it happens (a hire, a freeze …),
      // and an interrupt by the API tap once the engine accepted it
      if (POPPABLE.has(control.tagName) || /^(button|tab|menuitem|option|switch)$/.test(control.getAttribute('role') || '')) t.stage.pop(control)
      if (control.getAttribute('role') === 'tab') show.cue('tab', { spot })
      else if (/\bundo\b/.test(label)) show.cue('undo', { spot })
      else if (/\bredo\b/.test(label)) show.cue('redo', { spot })
      else if (/\b(send|reply|post)\b/.test(label) && control.tagName === 'BUTTON') show.cue('send', { spot })
      else if (/\b(delete|remove|retire|discard|dismiss|drop)\b/.test(label)) show.cue('destroy', { spot })
      else if (/\b(save|apply|confirm|create|add|ok|done|accept|approve|submit|grant)\b/.test(label)) show.cue('confirm', { spot })
      else show.cue('click', { spot })
    }
  }
  const onMove = (e: PointerEvent) => {
    if (!press) return
    const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y)
    if (!press.moved && dist > 8) press.moved = true
    if (!press.moved) return
    const now = performance.now()
    if (now - lastTrail < 45) return
    lastTrail = now
    if (press.card) t.stage.burst(e.clientX, e.clientY, { count: 3, colors: ['#d9c7a3', '#ffffff'], speed: [20, 90], size: [3, 6], life: [0.3, 0.6], kind: 'smoke', grow: 20 })
    else if (press.canvas) show.cue('pan', { spot: at(e.clientX, e.clientY) })
  }
  const onUp = (e: PointerEvent) => {
    view.removeEventListener('pointermove', onMove, opts)
    if (press?.card && press.moved) show.cue('drop', { spot: at(e.clientX, e.clientY, press.card) })
    press = null
  }
  const onKey = (e: KeyboardEvent) => {
    const target = asElement(e.target)
    if (e.key === 'Tab') tabbedAt = performance.now()
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.length === 1) {
      const k = e.key.toLowerCase()
      const editing = !!target?.closest(TYPEABLE)
      const spot = (target && spotOfElement(target)) || null
      if (k === 'z' && !e.shiftKey && !editing) show.cue('undo', { spot })
      else if ((k === 'y' || (k === 'z' && e.shiftKey)) && !editing) show.cue('redo', { spot })
      else if (k !== 'c' && k !== 'v' && k !== 'x') show.cue('shortcut', { spot, text: k.toUpperCase() })
      return
    }
    if (!target || !target.closest(TYPEABLE)) {
      // moving through lists, menus and the chart with the keyboard (the
      // Astra take's SHIFT): chevrons streaking the way it went
      const way = NAV_KEYS[e.key]
      if (way !== undefined && !e.ctrlKey && !e.metaKey && !e.altKey) {
        show.cue('navigate', { spot: (target && spotOfElement(target)) || null, n: way })
      }
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const field = target.closest(TYPEABLE)!
    // Shift+Enter in a textarea is a newline, not a send: no effect
    const kind: Kind | null = e.key === 'Enter' ? (e.shiftKey && field.tagName === 'TEXTAREA' ? null : 'enter')
      : e.key === 'Backspace' || e.key === 'Delete' ? 'erase'
      : e.key.length === 1 ? 'type' : null
    if (!kind) return
    // a typed character's sparks go where it lands
    const spot = caretSpot(field, doc, kind === 'type' ? e.key : '') ?? spotOfElement(field)
    if (spot) show.cue(kind, { spot })
  }
  // A wheel plays what it DID, never where it landed (user reports
  // 2026-10-15: scrolling a pinned window on the canvas, then the agents
  // list, showed the canvas's zoom). The canvas leaves pinned windows, the
  // agents list, a focused desk and modals to the browser, which scrolls
  // them, and takes every other wheel over it to zoom the camera, up to its
  // limits. So the camera's zoom and every scroll offset from the target up
  // are noted, then looked at again on the next frames: a zoom is a wheel the
  // canvas took that changed the camera's scale (never the camera gliding on
  // its own), a scroll is one of those offsets moving, and a wheel that moved
  // nothing (a list at its end, the camera at its limit) plays nothing.
  const looking = new Set<number>()
  const later = (cb: () => void) => {
    const id = nextFrame(view, () => { looking.delete(id); cb() })
    looking.add(id)
  }
  const onWheel = (e: WheelEvent) => {
    const target = asElement(e.target)
    if (!target) return
    if (Math.abs(e.deltaY) < 1 && Math.abs(e.deltaX) < 1) return
    const space = cameraOf(target), zoom = zoomOf(space)
    const offsets: [Element, number, number][] = []
    for (let el: Element | null = target; el; el = el.parentElement) offsets.push([el, el.scrollTop, el.scrollLeft])
    const spot = at(e.clientX, e.clientY)
    let frames = WHEEL_FRAMES
    const look = () => {
      const now = zoomOf(space)
      if (e.defaultPrevented && zoom !== null && now !== null && now !== zoom) {
        show.cue(now > zoom ? 'zoomIn' : 'zoomOut', { spot })
        return
      }
      for (const [el, top, side] of offsets) {
        if (el.scrollTop !== top || el.scrollLeft !== side) {
          show.cue('scroll', { spot, n: Math.sign(el.scrollTop - top) || Math.sign(e.deltaY) })
          return
        }
      }
      if (--frames > 0) later(look)
    }
    later(look)
  }
  // keyboard focus moving (Tab), not every programmatic or pointer focus
  const onFocus = (e: FocusEvent) => {
    if (performance.now() - tabbedAt > 400) return
    const target = asElement(e.target)
    const spot = target ? spotOfElement(target) : null
    if (spot) show.cue('focus', { spot })
  }
  const onDouble = (e: MouseEvent) => {
    const target = asElement(e.target)
    if (!target || target.closest('.epic-switch')) return
    show.cue('doubleClick', { spot: at(e.clientX, e.clientY, target) })
  }
  const onChange = (e: Event) => {
    const target = asElement(e.target)
    if (!target || target.closest('.epic-switch')) return
    const spot = spotOfElement(target)
    if (!spot) return
    if (target.tagName === 'SELECT') show.cue('select', { spot })
    else if (target.tagName === 'INPUT' && ((target as HTMLInputElement).type === 'checkbox' || (target as HTMLInputElement).type === 'radio')) {
      show.cue('toggle', { spot, n: (target as HTMLInputElement).checked ? 1 : 0 })
    }
  }
  const onMenu = (e: MouseEvent) => { show.cue('menu', { spot: at(e.clientX, e.clientY) }) }
  const onCopy = () => { show.cue('copy', { spot: selectionSpot(doc) }) }
  const onPaste = (e: Event) => {
    const target = asElement(e.target)
    show.cue('paste', { spot: target ? (caretSpot(target, doc) ?? spotOfElement(target)) : null })
  }
  const onDrop = (e: DragEvent) => {
    if (e.dataTransfer?.files?.length) show.cue('fileDrop', { spot: at(e.clientX, e.clientY), n: e.dataTransfer.files.length })
  }
  view.addEventListener('pointerdown', onDown, opts)
  view.addEventListener('pointerup', onUp, opts)
  view.addEventListener('pointercancel', onUp, opts)
  view.addEventListener('keydown', onKey, opts)
  view.addEventListener('wheel', onWheel, opts)
  view.addEventListener('change', onChange, opts)
  view.addEventListener('contextmenu', onMenu, opts)
  view.addEventListener('copy', onCopy, opts)
  view.addEventListener('paste', onPaste, opts)
  view.addEventListener('drop', onDrop, opts)
  view.addEventListener('focusin', onFocus, opts)
  view.addEventListener('dblclick', onDouble, opts)

  // what pops up: dialogs, menus, toasts
  let observer: MutationObserver | null = null
  const Observer = (view as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver
  if (Observer && doc.body) {
    observer = new Observer(records => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue
          const el = n as Element
          if (el.classList.contains('epic-stage')) continue
          // the first toast arrives inside its brand-new container
          const hit = el.matches(POPUPS) ? el : el.matches('.toasts') ? el.lastElementChild : null
          if (!hit) continue
          const spot = spotOfElement(hit.matches('.overlay') ? (hit.firstElementChild ?? hit) : hit)
          if (hit.matches('.overlay')) show.cue('dialogOpen', { spot })
          else if (hit.parentElement?.matches('.toasts')) {
            const text = (hit.textContent || '').toLowerCase()
            show.cue(/error|fail|could not|couldn|refused|invalid|denied|cannot/.test(text) ? 'toastError' : 'toast', { spot })
          } else show.cue('popup', { spot })
        }
        for (const n of r.removedNodes) {
          if (n.nodeType === 1 && (n as Element).matches?.('.overlay')) show.cue('dialogClose', {})
        }
      }
    })
    observer.observe(doc.body, { childList: true, subtree: true })
  }

  return () => {
    view.removeEventListener('pointerdown', onDown, opts)
    view.removeEventListener('pointerup', onUp, opts)
    view.removeEventListener('pointercancel', onUp, opts)
    view.removeEventListener('pointermove', onMove, opts)
    view.removeEventListener('keydown', onKey, opts)
    view.removeEventListener('wheel', onWheel, opts)
    view.removeEventListener('change', onChange, opts)
    view.removeEventListener('contextmenu', onMenu, opts)
    view.removeEventListener('copy', onCopy, opts)
    view.removeEventListener('paste', onPaste, opts)
    view.removeEventListener('drop', onDrop, opts)
    view.removeEventListener('focusin', onFocus, opts)
    view.removeEventListener('dblclick', onDouble, opts)
    for (const id of looking) cancelFrame(view, id)
    looking.clear()
    observer?.disconnect()
    observer = null
    press = null
  }
}

/** Where the caret is in a text field, on screen.
 *
 *  A textarea's text is laid out by the browser itself, in a hidden copy of
 *  the field (`laidOut`), so a line that wraps at the field's edge takes the
 *  caret, and the sparks, onto the next line (user report 2026-10-16,
 *  4.3.1-alpha.1: past a full line they stayed at the end of the first).
 *  `typed`, a character about to be typed, is placed where it lands: the word
 *  it lengthens may no longer fit, and go down a line with it. A one-line
 *  field never wraps, and where nothing is laid out (jsdom) only newlines
 *  start a line: there the text before the caret is measured in the field's
 *  own font (`byLines`).
 *
 *  The field's box can be SCALED on screen (user report 2026-10-15: typing
 *  sparks ran off the caret in a desk on the canvas, never in a pinned one). A
 *  canvas desk sits inside the camera's `scale(view.z)` and `.desk-inner`'s
 *  counter-scale, so getBoundingClientRect() is in screen px while the text,
 *  padding, border and scroll offsets are in the field's own px. The box's
 *  screen size over its untransformed one (offsetWidth/offsetHeight) carries
 *  them onto the screen; a pinned or popped-out desk is unscaled, 1. */
function caretSpot(field: Element, doc: Document, typed = ''): Spot | null {
  const view = doc.defaultView
  if (!view) return null
  if ((field as HTMLElement).isContentEditable) {
    const sel = doc.getSelection()
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0).getBoundingClientRect?.()
      if (r && (r.width || r.height || r.left || r.top)) return { x: r.left, y: r.top + r.height / 2, rect: null, el: field, doc }
    }
    return spotOfElement(field)
  }
  if (!isField(field)) return spotOfElement(field)
  const box = field.getBoundingClientRect()
  if (!(box.width > 0)) return null
  const value = field.value
  let start = value.length, end = value.length
  try { start = field.selectionStart ?? start; end = field.selectionEnd ?? start } catch { /* a field with no caret to read */ }
  const style = view.getComputedStyle(field)
  const area = field.tagName === 'TEXTAREA'
  // from the corner of the field's content, in its own px
  const at = (area ? laidOut(field, style, doc, typed ? value.slice(0, start) + typed + value.slice(end) : value, start) : null)
    ?? byLines(style, doc, value.slice(0, start))
  const padL = parseFloat(style.paddingLeft) || 0
  const padT = parseFloat(style.paddingTop) || 0
  // screen px per field px
  const sx = field.offsetWidth > 0 ? box.width / field.offsetWidth : 1
  const sy = field.offsetHeight > 0 ? box.height / field.offsetHeight : sx
  const x = Math.min(box.right - 4, box.left + (field.clientLeft + padL + at.x - field.scrollLeft) * sx)
  const y = area
    ? Math.min(box.bottom - 4, box.top + (field.clientTop + padT + at.y - field.scrollTop) * sy)
    : box.top + box.height / 2
  return { x, y: Math.max(box.top + 4, y), rect: null, el: field, doc }
}

/** what a textarea's hidden copy takes from it: everything that moves its text */
const LAID_OUT = ['direction', 'font-family', 'font-size', 'font-stretch', 'font-style', 'font-variant', 'font-weight',
  'font-kerning', 'font-feature-settings', 'font-variation-settings', 'letter-spacing', 'word-spacing', 'line-height',
  'text-align', 'text-indent', 'text-transform', 'text-rendering', 'tab-size', 'white-space', 'word-break',
  'overflow-wrap', 'line-break', 'hyphens']

/** Where `text[at]` (the caret, or a character about to be typed) is laid out
 *  in a textarea: x at its left, y the middle of its line, from the corner of
 *  the field's content, in the field's own px. The text goes into a hidden
 *  copy of the field, as wide as its content (its scrollbar left out) and in
 *  its font and wrapping, with everything from `at` on in a marker: the copy
 *  wraps exactly as the field does, and the marker starts at the spot. At the
 *  end of the text or of a line the marker is a zero-width space, which never
 *  moves a line break. The copy is gone again before this returns. Null where
 *  nothing is laid out (jsdom). */
function laidOut(field: HTMLElement, style: CSSStyleDeclaration, doc: Document, text: string, at: number): { x: number; y: number } | null {
  if (!doc.body) return null
  const px = (v: string) => parseFloat(v) || 0
  const borders = px(style.borderLeftWidth) + px(style.borderRightWidth)
  const pads = px(style.paddingLeft) + px(style.paddingRight)
  // the width CSS gives it is exact; clientWidth is rounded
  const bar = Math.max(0, Math.round(field.offsetWidth - field.clientWidth - borders))
  const used = parseFloat(style.width)
  const width = used > 0 ? (style.boxSizing === 'border-box' ? used - borders - pads - bar : used) : field.clientWidth - pads
  if (!(width > 0)) return null
  const copy = doc.createElement('div')
  copy.style.cssText = `position:fixed;left:0;top:0;display:block;box-sizing:content-box;width:${width}px;height:0;`
    + 'margin:0;padding:0;border:0;overflow:hidden;visibility:hidden;pointer-events:none;transform:none'
  for (const p of LAID_OUT) copy.style.setProperty(p, style.getPropertyValue(p))
  const rest = text.slice(at)
  const zero = !rest || rest[0] === '\n'
  const mark = doc.createElement('span')
  mark.textContent = zero ? '\u200b' : rest
  copy.append(text.slice(0, at), mark)
  if (zero && rest) copy.append(rest)
  doc.body.append(copy)
  try {
    const r = mark.getClientRects()[0]
    const c = copy.getBoundingClientRect()
    return r && r.height > 0 ? { x: r.left - c.left, y: (r.top + r.bottom) / 2 - c.top } : null
  } finally { copy.remove() }
}

/** where the caret is by newlines alone: the text before it measured in the
 *  field's own font, a line down for each newline */
function byLines(style: CSSStyleDeclaration, doc: Document, before: string): { x: number; y: number } {
  const lines = before.split('\n')
  const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 13) * 1.4
  return {
    x: measure(doc, style.font || `${style.fontSize} ${style.fontFamily}`, lines[lines.length - 1] ?? ''),
    y: (lines.length - 0.5) * lineHeight,
  }
}

let measurer: CanvasRenderingContext2D | null | undefined
function measure(doc: Document, font: string, text: string): number {
  if (measurer === undefined) {
    try { measurer = doc.createElement('canvas').getContext('2d') } catch { measurer = null }
  }
  if (!measurer) return text.length * 7
  measurer.font = font
  return measurer.measureText(text).width
}

function selectionSpot(doc: Document): Spot | null {
  const sel = doc.getSelection()
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0).getBoundingClientRect?.()
    if (r && (r.width || r.height)) return { x: r.left + r.width / 2, y: r.top, rect: null, el: null, doc }
  }
  const active = doc.activeElement
  return active ? spotOfElement(active) : null
}

/* ── THE PLAYBOOK: one picture and one sound for every event ──────────── */

type Play = (c: Cue) => void

const shortTool = (name: string | undefined): string => {
  if (!name) return 'TOOL!'
  const tail = name.split('__').pop() ?? name
  const word = tail.replace(/^orgtree_/, '').replace(/[_-]+/g, ' ').trim().toUpperCase()
  return (word.length > 14 ? word.slice(0, 13) + '…' : word) + '!'
}

const above = (c: Cue, by = 70): number => (c.at.rect ? c.at.rect.y - 18 : c.at.y - by)

/** Who an effect is about, written under its word (the Argon and Astra takes
 *  name the agent): an explicit caption, else the agent — never the user's
 *  eye, the org inbox or a watchdog's id. */
const captionOf = (c: Cue): string | undefined => {
  if (c.ev.caption) return c.ev.caption
  const who = c.ev.node
  return who && !isUserEnd(who) && !isInboxEnd(who) && !who.startsWith('dog:') ? who : undefined
}
/** for effects without a word of their own: the caption alone, under them */
const tag = (c: Cue, y: number): void => {
  const caption = captionOf(c)
  if (caption) c.t.stage.word(c.at.x, y, caption.toUpperCase(), { size: 22, color: '#ffffff', ink: '#1a1033', tilt: 0, life: 1.5 })
}

const PLAYBOOK: Partial<Record<Kind, Play>> = {
  /* ── EPIC Mode itself ─────────────────────────────────────────────── */
  epicOn: c => {
    const s = c.t.stage, { w, h } = s.size
    c.show.sound('epicOn', c)
    s.flash('#ffffff', 0.75, 0.6)
    for (let i = 0; i < 5; i++) s.bolt(rand(0, w), -10, rand(w * 0.2, w * 0.8), rand(h * 0.3, h * 0.9), { color: pick([CYAN, PURPLE, '#ffffff']), life: 0.55, width: 4, branches: 4 })
    s.word(w / 2, h / 2, 'EPIC MODE', { size: Math.min(150, w / 7), color: GOLD, life: 2.8, tilt: -0.06 })
    for (let i = 0; i < 3; i++) s.ring(w / 2, h / 2, { color: pick([GOLD, '#ffffff', PINK]), radius: Math.max(w, h) * 0.5, width: 10, life: 0.9, delay: i * 0.18 })
    for (let i = 0; i < 7; i++) setTimeout(() => s.firework(rand(w * 0.1, w * 0.9), rand(h * 0.35, h * 0.85)), 200 + i * 170)
    s.rain('confetti', { count: 220 })
    s.shake(16, 700)
  },
  epicLaunch: c => {
    const s = c.t.stage, { w, h } = s.size
    c.show.sound('thunder', c)
    c.show.sound('chime', c)
    s.flash('#ffffff', 0.45, 0.4)
    for (let i = 0; i < 2; i++) s.bolt(rand(0, w), -10, rand(w * 0.3, w * 0.7), rand(h * 0.4, h * 0.7), { color: CYAN, life: 0.45, width: 3, branches: 3 })
    s.word(w / 2, h * 0.42, 'EPIC MODE', { size: Math.min(110, w / 9), color: GOLD, life: 2 })
    s.firework(w * 0.3, h * 0.6)
    s.firework(w * 0.7, h * 0.6)
  },
  epicOff: c => {
    c.show.sound('epicOff', c)
    c.t.stage.crt(0.95)
  },
  brownout: c => {
    const s = c.t.stage
    c.show.sound('powerFail', c)
    s.flicker(1)
    s.burst(c.at.x, c.at.y - 30, { count: 40, kind: 'streak', colors: [GOLD, '#ffffff', CYAN], speed: [200, 520], size: [5, 9], life: [0.3, 0.7], gravity: 900, angle: -Math.PI / 2, spread: 1.6 })
    s.word(c.at.x, above(c, 140), 'LIMIT HIT!', { color: '#ffe066', ink: '#2b1d00', size: 46 })
  },

  /* ── who is in the org ────────────────────────────────────────────── */
  // a hire: a summoning portal opens (Astra, Argon), a beam of light lands
  // on the new card and the confetti flies (Opus)
  hire: c => {
    const s = c.t.stage
    c.show.sound('hire', c)
    s.portal(c.at.x, c.at.y, { color: GOLD, radius: 96, life: 1.5 })
    s.beam(c.at.x, c.at.y, { color: '#fff3b0', width: 140, life: 1.4 })
    s.word(c.at.x, above(c), 'HIRED!', { color: GOLD, size: 50, caption: captionOf(c) })
    s.ring(c.at.x, c.at.y, { color: GOLD, radius: 170, width: 8 })
    s.burst(c.at.x, c.at.y, { count: 90, kind: 'confetti', colors: ['#ff4d6d', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff'], speed: [150, 520], size: [7, 12], life: [1, 1.8], gravity: 480, drag: 1.2 })
    s.burst(c.at.x, c.at.y, { count: 16, kind: 'star', colors: [GOLD, '#ffffff'], speed: [80, 300], size: [6, 11], life: [0.7, 1.3], gravity: 200 })
    s.pulse(c.at.el, GOLD, 1400)
    s.shake(6, 300)
  },
  rehire: c => {
    const s = c.t.stage
    c.show.sound('hire', c, { pitch: 1.12 })
    c.show.sound('shimmer', c)
    s.portal(c.at.x, c.at.y, { color: CYAN, radius: 110, life: 1.5 })
    s.vortex(c.at.x, c.at.y, { color: CYAN, inward: false, radius: 150 })
    s.beam(c.at.x, c.at.y, { color: '#b9f3ff', width: 120 })
    s.word(c.at.x, above(c), 'BACK FROM THE ARCHIVE!', { color: CYAN, size: 34, caption: captionOf(c) })
    s.pulse(c.at.el, CYAN, 1400)
  },
  retire: c => {
    const s = c.t.stage
    c.show.sound('retire', c)
    s.burst(c.at.x, c.at.y, { count: 26, kind: 'smoke', colors: ['#8b949e', '#c9d1d9'], speed: [20, 90], size: [16, 30], life: [1.2, 2.2], gravity: -90, grow: 26, drag: 0.8 })
    s.vortex(c.at.x, c.at.y, { color: GREY, inward: true, radius: 130, life: 0.9 })
    s.ring(c.at.x, c.at.y, { color: '#c9d1d9', radius: 220, width: 5, life: 1.4 })
    s.word(c.at.x, above(c), 'RETIRED', { color: '#d0d6dd', ink: '#20242a', size: 44, life: 1.8, caption: captionOf(c) })
    s.burst(c.at.x, c.at.y - 20, { count: 30, colors: ['#ffffff', '#e8f1ff'], speed: [30, 140], size: [3, 6], life: [1.2, 2], gravity: -180 })
  },
  // a move is a teleport: the card is sucked into a vortex where it stood, and
  // once the chart has carried it to its new superior a comet lands there
  move: c => {
    const s = c.t.stage
    const from = c.at
    c.show.sound('move', c)
    s.vortex(from.x, from.y, { color: PURPLE, inward: true, radius: 100, life: 0.5 })
    s.burst(from.x, from.y, { count: 24, colors: [PURPLE, '#ffffff'], speed: [40, 160], size: [3, 7], life: [0.4, 0.8] })
    setTimeout(() => {
      const to = c.show.where(c.org, c.ev.node) ?? from
      const t = c.show.theaterFor(to.doc).stage
      if (to.doc === from.doc && Math.hypot(to.x - from.x, to.y - from.y) > 24) {
        s.comet(from.x, from.y, to.x, to.y, { color: PURPLE, duration: 0.42 })
      }
      setTimeout(() => {
        t.vortex(to.x, to.y, { color: PURPLE, inward: false, radius: 120, life: 0.55 })
        t.ring(to.x, to.y, { color: PURPLE, radius: 140, width: 6 })
        t.word(to.x, to.rect ? to.rect.y - 18 : to.y - 70, 'TELEPORTED!', { color: PURPLE, size: 40, caption: captionOf(c) })
        t.pulse(to.el, PURPLE)
      }, 380)
    }, 650)
  },
  reorder: c => {
    c.show.sound('reorder', c)
    c.t.stage.burst(c.at.x, c.at.y, { count: 22, kind: 'streak', colors: [PURPLE, '#ffffff'], speed: [260, 520], size: [5, 8], life: [0.25, 0.5], angle: pick([0, Math.PI]), spread: 0.5 })
  },
  rename: c => {
    const s = c.t.stage
    c.show.sound('scribble', c)
    c.show.sound('chime', c)
    s.word(c.at.x, above(c), 'RENAMED!', { color: PINK, size: 40, caption: captionOf(c) })
    s.burst(c.at.x, c.at.y, { count: 40, colors: [PINK, '#ffffff', GOLD], speed: [60, 260], size: [3, 7], life: [0.6, 1.1] })
    s.pulse(c.at.el, PINK)
  },

  /* ── freeze, halt, interrupt ──────────────────────────────────────── */
  // THE ICE SPIKE (the user's own example): a crown of crystals erupts from
  // the card (Argon), spikes burst out of it and a slab of ice frosts over it
  // (Opus), then the crystals shatter and the snow falls
  freeze: c => {
    const s = c.t.stage
    c.show.sound('ice', c)
    s.spikes(c.at.x, c.at.y, { count: 11, length: 150, color: ICE })
    if (c.at.rect) s.iceBlock(c.at.rect, 2.6, c.at.el)
    s.crystal(c.at.x, c.at.rect ? c.at.rect.y + c.at.rect.h * 0.9 : c.at.y + 60, { size: c.at.rect ? Math.max(140, c.at.rect.h * 1.35) : 170 })
    s.burst(c.at.x, c.at.y, { count: 46, kind: 'snow', colors: ['#ffffff', ICE], speed: [40, 200], size: [5, 10], life: [1.6, 2.6], gravity: 60, drag: 0.8 })
    s.word(c.at.x, above(c, 110) - 30, 'FROZEN!', { color: '#9fe6ff', ink: '#06283d', size: 56, caption: captionOf(c) })
    s.flash('#bfefff', 0.32, 0.5)
    s.pulse(c.at.el, '#7fd8ff', 1800)
    s.shake(7, 320)
  },
  limit: c => {
    const s = c.t.stage
    c.show.sound('ice', c)
    c.show.sound('powerFail', c)
    s.flicker(1)
    s.spikes(c.at.x, c.at.y, { count: 9, length: 120, color: ICE })
    if (c.at.rect) s.iceBlock(c.at.rect, 2.4, c.at.el)
    s.crystal(c.at.x, c.at.rect ? c.at.rect.y + c.at.rect.h * 0.9 : c.at.y + 60, { size: c.at.rect ? Math.max(120, c.at.rect.h * 1.1) : 140 })
    s.burst(c.at.x, c.at.y - 30, { count: 40, kind: 'streak', colors: [GOLD, '#ffffff', CYAN], speed: [200, 520], size: [5, 9], life: [0.3, 0.7], gravity: 900, angle: -Math.PI / 2, spread: 1.6 })
    s.word(c.at.x, above(c, 110) - 30, 'LIMIT HIT!', { color: '#ffe066', ink: '#2b1d00', size: 52, caption: captionOf(c) })
    s.shake(9, 450)
  },
  thaw: c => {
    const s = c.t.stage
    c.show.sound('thaw', c)
    s.burst(c.at.x, c.at.y, { count: 46, kind: 'shard', colors: [ICE, '#ffffff', '#8fd3ff'], speed: [160, 460], size: [6, 12], life: [0.7, 1.3], gravity: 700, drag: 0.5 })
    s.burst(c.at.x, c.at.y, { count: 40, colors: [ORANGE, GOLD, '#fff2c0'], speed: [80, 300], size: [5, 10], life: [0.5, 1] })
    s.ring(c.at.x, c.at.y, { color: ORANGE, radius: 150, width: 7 })
    s.word(c.at.x, above(c), 'THAWED!', { color: ORANGE, size: 46, caption: captionOf(c) })
    s.pulse(c.at.el, ORANGE)
  },
  halt: c => {
    const s = c.t.stage
    c.show.sound('halt', c)
    for (let i = 0; i < 3; i++) setTimeout(() => s.flash(RED, 0.28, 0.22), i * FLASH_EVERY_MS)
    for (let i = 0; i < 3; i++) s.ring(c.at.x, c.at.y, { color: RED, radius: 160, width: 9, life: 0.6, delay: i * FLASH_EVERY_MS / 1000 })
    s.word(c.at.x, above(c, 90), 'HALTED', { color: RED, ink: '#2a0000', size: 58, caption: captionOf(c) })
    s.pulse(c.at.el, RED, 1600)
    s.shake(10, 500)
  },
  unhalt: c => {
    const s = c.t.stage
    c.show.sound('resume', c)
    s.flash(GREEN, 0.2, 0.4)
    s.beam(c.at.x, c.at.y, { color: '#b6ffd3', width: 110 })
    s.word(c.at.x, above(c), 'RESUMED!', { color: GREEN, ink: '#002a12', size: 46, caption: captionOf(c) })
    s.pulse(c.at.el, GREEN)
  },
  interrupt: c => {
    const s = c.t.stage
    c.show.sound('stop', c)
    s.stopSign(c.at.x, c.at.y, { size: 70, caption: captionOf(c) })
    setTimeout(() => {
      s.ring(c.at.x, c.at.y, { color: RED, radius: 180, width: 10, life: 0.55 })
      s.burst(c.at.x, c.at.y, { count: 46, kind: 'streak', colors: [RED, '#ffffff', GOLD], speed: [240, 640], size: [5, 9], life: [0.3, 0.6], drag: 2.4 })
      s.shake(13, 420)
    }, 150)
    s.pulse(c.at.el, RED, 1100)
  },
  killswitch: c => {
    const s = c.t.stage, { w, h } = s.size
    c.show.sound('halt', c)
    c.show.sound('boom', c)
    s.flash(RED, 0.6, 0.9)
    s.word(w / 2, h / 2, 'ALL STOP', { size: Math.min(140, w / 7), color: RED, ink: '#200000', life: 2.4 })
    for (let i = 0; i < 3; i++) setTimeout(() => s.meteor(rand(w * 0.2, w * 0.8), rand(h * 0.4, h * 0.8), { onImpact: () => {} }), i * 220)
    s.cracks(w / 2, h / 2, { count: 14, length: Math.max(w, h) * 0.45, life: 2.4 })
    s.shake(20, 800)
  },
  killswitchOff: c => {
    const s = c.t.stage, { w, h } = s.size
    c.show.sound('resume', c)
    c.show.sound('victory', c)
    s.flash(GREEN, 0.35, 0.5)
    s.word(w / 2, h / 2, 'ALL GO!', { size: Math.min(130, w / 8), color: GREEN, ink: '#002a12', life: 2 })
    for (let i = 0; i < 4; i++) setTimeout(() => s.firework(rand(w * 0.15, w * 0.85), rand(h * 0.4, h * 0.8)), i * 180)
  },

  /* ── turns, tools and thought ─────────────────────────────────────── */
  turnStart: c => {
    const s = c.t.stage
    c.show.sound('turnStart', c)
    const base = c.at.rect ? c.at.rect.y + c.at.rect.h : c.at.y + 30
    s.burst(c.at.x, base, { count: 46, colors: [ORANGE, GOLD, '#ff4d00', '#fff2c0'], speed: [90, 330], size: [5, 11], life: [0.5, 1.1], gravity: -420, angle: -Math.PI / 2, spread: 1.4, jitter: 18 })
    s.ring(c.at.x, c.at.y, { color: ORANGE, radius: 120, width: 6, life: 0.5 })
    s.pulse(c.at.el, ORANGE, 800)
  },
  turnEnd: c => {
    const s = c.t.stage
    c.show.sound('turnEnd', c)
    s.burst(c.at.x, c.at.y, { count: 40, colors: [GOLD, '#ffffff', '#ffe9a8'], speed: [100, 360], size: [4, 8], life: [0.6, 1.1] })
    s.ring(c.at.x, c.at.y, { color: GOLD, radius: 130, width: 5, life: 0.55 })
    s.word(c.at.x, above(c), 'DONE!', { color: GOLD, size: 32, life: 1 })
  },
  tool: c => {
    const s = c.t.stage
    c.show.sound('tool', c)
    const ox = c.at.rect ? rand(-c.at.rect.w / 3, c.at.rect.w / 3) : rand(-30, 30)
    s.gear(c.at.x + ox, c.at.y + rand(-20, 20), { color: pick(['#c9d6e3', '#ffd34d', '#9fe6ff']) })
    s.burst(c.at.x + ox, c.at.y, { count: 18, kind: 'streak', colors: ['#ffffff', CYAN, GOLD], speed: [200, 520], size: [4, 7], life: [0.2, 0.45], drag: 2.5 })
    s.word(c.at.x, above(c, 60), shortTool(c.ev.text), { color: CYAN, ink: '#00222b', size: 24, life: 0.9 })
  },
  toolDone: c => {
    c.show.sound('toolDone', c)
    c.t.stage.burst(c.at.x, c.at.y, { count: 10, colors: [CYAN, '#ffffff'], speed: [60, 200], size: [3, 6], life: [0.3, 0.6] })
  },
  thinking: c => {
    c.show.sound('shimmer', c, { gain: 0.5 })
    c.t.stage.burst(c.at.x, c.at.y - 20, { count: 14, colors: [PURPLE, '#e7d2ff'], speed: [20, 80], size: [4, 8], life: [0.8, 1.4], gravity: -120 })
  },
  // streamed text plays as notes, each agent its own pentatonic run (the
  // Argon take's arpeggio), with a scratch of the pen under them
  writing: c => {
    c.show.sound('note', c, { pitch: c.show.noteFor(c.ev.node ?? '') * climbFor(c.show.burst), gain: 0.9 })
    c.show.sound('scribble', c, { gain: 0.35 })
    c.t.stage.burst(c.at.x + rand(-30, 30), c.at.y + rand(-10, 25), { count: 8, colors: ['#ffffff', GOLD], speed: [30, 120], size: [2, 4], life: [0.3, 0.6] })
  },
  compact: c => {
    const s = c.t.stage
    c.show.sound('compact', c)
    s.vortex(c.at.x, c.at.y, { color: GREY, inward: true, radius: 140, life: 0.75 })
    setTimeout(() => {
      s.burst(c.at.x, c.at.y, { count: 30, kind: 'shard', colors: ['#c9d1d9', '#8b949e'], speed: [120, 360], size: [5, 9], life: [0.5, 1], gravity: 600 })
      s.shake(6, 260)
    }, 700)
    s.word(c.at.x, above(c), 'CRUNCH!', { color: '#d0d6dd', ink: '#1a1d21', size: 46, caption: captionOf(c) })
  },
  error: c => {
    const s = c.t.stage
    c.show.sound('error', c)
    s.cracks(c.at.x, c.at.y, { count: 9, length: 160 })
    s.burst(c.at.x, c.at.y, { count: 30, kind: 'shard', colors: [RED, '#ff9a9a', '#ffffff'], speed: [120, 380], size: [5, 10], life: [0.6, 1.1], gravity: 500 })
    s.word(c.at.x, above(c), 'ERROR!', { color: RED, ink: '#2a0000', size: 46, caption: captionOf(c) })
    s.shake(7, 300)
  },

  /* ── questions, documents, reports ────────────────────────────────── */
  question: c => {
    const s = c.t.stage
    c.show.sound('question', c)
    s.glyph(c.at.x, c.at.y - 10, '?', { color: PURPLE, size: 120, life: 1.8 })
    s.flash(PURPLE, 0.18, 0.5)
    s.bolt(c.at.x, -10, c.at.x, c.at.y, { color: PURPLE, life: 0.4, width: 4, branches: 3 })
    s.ring(c.at.x, c.at.y, { color: PURPLE, radius: 170, width: 7, life: 0.8 })
    tag(c, c.at.y + 92)
  },
  answer: c => {
    const s = c.t.stage
    c.show.sound('answer', c)
    s.word(c.at.x, above(c), 'ANSWERED!', { color: GREEN, ink: '#002a12', size: 42, caption: captionOf(c) })
    s.burst(c.at.x, c.at.y, { count: 50, colors: [GREEN, '#ffffff', CYAN], speed: [80, 320], size: [4, 8], life: [0.8, 1.4], gravity: -140 })
  },
  docs: c => {
    const s = c.t.stage
    c.show.sound('tada', c)
    s.beam(c.at.x, c.at.y, { color: '#fff3b0', width: 100, life: 1.1 })
    s.word(c.at.x, above(c), 'TA-DA!', { color: GOLD, size: 50, caption: captionOf(c) })
    s.burst(c.at.x, c.at.y, { count: 60, kind: 'confetti', colors: ['#ffd166', '#ffffff', '#4cc9f0', '#ff4d6d'], speed: [140, 420], size: [7, 11], life: [1, 1.6], gravity: 420 })
  },
  working: c => {
    c.show.sound('wake', c)
    c.t.stage.word(c.at.x, above(c), 'ON IT!', { color: ORANGE, size: 30, life: 1, caption: captionOf(c) })
  },
  blocked: c => {
    const s = c.t.stage
    c.show.sound('drop', c)
    s.word(c.at.x, above(c), 'BLOCKED!', { color: RED, ink: '#2a0000', size: 42, caption: captionOf(c) })
    s.burst(c.at.x, c.at.y, { count: 24, kind: 'shard', colors: [RED, '#ffb3b3'], speed: [80, 260], size: [6, 10], life: [0.6, 1], gravity: 500 })
  },
  idle: c => {
    c.show.sound('chime', c)
    c.t.stage.word(c.at.x, above(c), 'REPORTED IN', { color: '#9fe6ff', size: 28, life: 1.1, caption: captionOf(c) })
  },
  waiting: c => {
    c.show.sound('tick', c)
    c.t.stage.glyph(c.at.x, c.at.y, '…', { color: '#d0d6dd', size: 70, life: 1 })
  },

  /* ── who serves it ────────────────────────────────────────────────── */
  model: c => {
    const s = c.t.stage
    c.show.sound('slots', c)
    for (const [i, col] of [PINK, GOLD, GREEN, CYAN, PURPLE].entries()) s.ring(c.at.x, c.at.y, { color: col, radius: 110 + i * 22, width: 5, life: 0.7, delay: i * 0.06 })
    s.word(c.at.x, above(c), (c.ev.text || 'NEW MODEL').toUpperCase() + '!', { color: GOLD, size: 44, caption: captionOf(c) })
    s.pulse(c.at.el, GOLD)
  },
  account: c => {
    c.show.sound('slots', c, { pitch: 1.1 })
    c.t.stage.word(c.at.x, above(c), 'NEW ACCOUNT!', { color: CYAN, size: 38, caption: captionOf(c) })
    c.t.stage.vortex(c.at.x, c.at.y, { color: CYAN, inward: false })
  },
  effort: c => {
    c.show.sound('clack', c)
    c.t.stage.gear(c.at.x, c.at.y, { size: 34, color: GOLD })
    c.t.stage.word(c.at.x, above(c), `EFFORT: ${(c.ev.text || '').toUpperCase()}`, { color: GOLD, size: 32, caption: captionOf(c) })
  },
  credits: c => {
    const s = c.t.stage
    c.show.sound('coins', c)
    s.burst(c.at.x, c.at.y, { count: 26, kind: 'coin', speed: [160, 420], size: [7, 10], life: [0.9, 1.5], gravity: 900, angle: -Math.PI / 2, spread: 1.5, drag: 0.3 })
    const n = c.ev.n ?? 0
    s.word(c.at.x, above(c), `${n > 0 ? '+' : ''}${Math.round(n * 100) / 100} CREDITS`, { color: GOLD, size: 30, caption: captionOf(c) })
  },
  wake: c => {
    c.show.sound('wake', c, { gain: 0.6 })
    c.t.stage.ring(c.at.x, c.at.y, { color: CYAN, radius: 70, width: 3, life: 0.5 })
  },
  ready: c => {
    c.show.sound('blip', c)
    c.t.stage.burst(c.at.x, c.at.y, { count: 8, colors: [CYAN], speed: [40, 120], size: [3, 5], life: [0.3, 0.5] })
  },
  sleep: c => {
    c.show.sound('sleep', c, { gain: 0.6 })
    c.t.stage.burst(c.at.x, c.at.y, { count: 8, kind: 'smoke', colors: [GREY], speed: [10, 40], size: [10, 16], life: [0.8, 1.2], gravity: -40, grow: 18 })
    c.t.stage.word(c.at.x + 30, above(c, 40), 'z z z', { color: '#c9d1d9', size: 22, life: 1.2 })
  },
  queued: c => {
    c.show.sound('blip', c)
    c.t.stage.ring(c.at.x, c.at.y, { color: GOLD, radius: 60, width: 3, life: 0.4 })
  },
  mailbox: c => {
    c.show.sound('notice', c, { gain: 0.6 })
    c.t.stage.burst(c.at.x, c.at.y, { count: 10, colors: [GOLD, '#ffffff'], speed: [40, 140], size: [3, 6], life: [0.4, 0.7] })
  },

  /* ── mail: sparks become lightning ────────────────────────────────── */
  zap: c => {
    const s = c.t.stage
    c.show.sound('zap', c)
    const from = c.from
    if (from && from.doc === c.at.doc) {
      s.bolt(from.x, from.y, c.at.x, c.at.y, { color: CYAN, life: 0.38, width: 3.5, branches: 3 })
      s.burst(from.x, from.y, { count: 14, colors: [CYAN, '#ffffff'], speed: [80, 260], size: [3, 6], life: [0.3, 0.6] })
    } else s.bolt(c.at.x + rand(-160, 160), c.at.y - rand(140, 260), c.at.x, c.at.y, { color: CYAN, life: 0.35, width: 3.5 })
    s.burst(c.at.x, c.at.y, { count: 28, kind: 'streak', colors: [CYAN, '#ffffff', '#b8f6ff'], speed: [160, 460], size: [4, 7], life: [0.25, 0.5], drag: 2.4 })
    s.word(c.at.x, above(c, 50), 'ZAP!', { color: CYAN, ink: '#00222b', size: 38, life: 0.9 })
    s.pulse(c.at.el, CYAN, 600)
  },
  userSend: c => {
    const s = c.t.stage
    c.show.sound('send', c)
    const from = c.from ?? { ...c.at, x: c.at.x, y: (c.t.view.innerHeight || 600) + 20 }
    s.comet(from.x, from.y, c.at.x, c.at.y, { color: GOLD, duration: 0.55, arc: 0.25, onArrive: () => {
      s.burst(c.at.x, c.at.y, { count: 40, colors: [GOLD, '#ffffff', ORANGE], speed: [100, 340], size: [4, 8], life: [0.5, 1] })
      s.ring(c.at.x, c.at.y, { color: GOLD, radius: 130, width: 6 })
    } })
    s.word(c.at.x, above(c), 'INCOMING!', { color: GOLD, size: 36 })
  },
  toUser: c => {
    const s = c.t.stage
    c.show.sound('zap', c, { pitch: 1.2 })
    c.show.sound('notice', c)
    const from = c.from
    if (from && from.doc === c.at.doc) s.bolt(from.x, from.y, c.at.x, c.at.y, { color: GOLD, life: 0.4, width: 3.5, branches: 2 })
    s.word(c.at.x, above(c), 'FOR YOU!', { color: GOLD, size: 36 })
    s.burst(c.at.x, c.at.y, { count: 30, colors: [GOLD, '#ffffff'], speed: [80, 300], size: [4, 8], life: [0.5, 1] })
  },
  // a watchdog firing: the Opus take's bark, comet and paw prints over the
  // Astra and Argon takes' radar sweep and sonar ping
  bark: c => {
    const s = c.t.stage
    c.show.sound('bark', c)
    c.show.sound('ping', c, { gain: 0.8 })
    const from = c.from
    if (from && from.doc === c.at.doc) {
      s.radar(from.x, from.y, { color: '#69f0ae', radius: 90, life: 1.1 })
      s.comet(from.x, from.y, c.at.x, c.at.y, { color: '#ffb35c', duration: 0.4 })
    } else s.radar(c.at.x, c.at.y, { color: '#69f0ae', radius: 120 })
    s.burst(c.at.x, c.at.y, { count: 12, kind: 'paw', colors: ['#c98a3c', '#8a5a24', '#e0a85a'], speed: [80, 260], size: [9, 14], life: [1, 1.6], gravity: 200, drag: 1 })
    s.word(c.at.x, above(c), 'WOOF!', { color: '#ffb35c', ink: '#2b1500', size: 48, caption: captionOf(c) })
    s.shake(5, 250)
  },
  orgInbox: c => {
    const s = c.t.stage
    c.show.sound('boom', c, { gain: 0.6 })
    s.meteor(c.at.x, c.at.y, { color: ORANGE, onImpact: () => {
      s.burst(c.at.x, c.at.y, { count: 60, colors: [ORANGE, GOLD, '#ffffff'], speed: [120, 460], size: [5, 10], life: [0.5, 1.1] })
      s.ring(c.at.x, c.at.y, { color: ORANGE, radius: 170, width: 8 })
      s.shake(9, 380)
    } })
  },
  externalMail: c => { PLAYBOOK.orgInbox!(c); c.t.stage.word(c.at.x, above(c), 'OUTSIDE MAIL!', { color: ORANGE, size: 36 }) },
  userMail: c => {
    c.show.sound('chime', c)
    c.t.stage.word(c.at.x, c.at.y + 46, 'MAIL!', { color: GOLD, size: 34 })
    c.t.stage.burst(c.at.x, c.at.y, { count: 30, colors: [GOLD, '#ffffff'], speed: [60, 240], size: [3, 7], life: [0.5, 1] })
  },
  // the whole show's loudest moment: the alarm in every window (soundAlarm,
  // whose banner names the sender), a shake, and a big ! at the inbox; no
  // rapid flashing (never above three a second)
  urgent: c => {
    const s = c.t.stage
    c.show.soundAlarm(c)
    s.shake(10, 450)
    s.glyph(c.at.x, c.at.y + 60, '!', { color: RED, size: 130, life: 2.4 })
  },

  /* ── the docket ───────────────────────────────────────────────────── */
  ticket: c => {
    const s = c.t.stage
    c.show.sound('stamp', c)
    s.word(c.at.x, c.at.y + 50, c.ev.n && c.ev.n > 1 ? `${c.ev.n} NEW TICKETS!` : 'NEW TICKET!', { color: '#ffb35c', size: 34 })
    s.ring(c.at.x, c.at.y, { color: '#ffb35c', radius: 90, width: 6 })
    s.shake(4, 160)
  },
  ticketDone: c => {
    const s = c.t.stage, { w, h } = s.size
    c.show.sound('victory', c)
    for (let i = 0; i < 4; i++) setTimeout(() => s.firework(rand(w * 0.15, w * 0.85), rand(h * 0.35, h * 0.8)), i * 160)
    s.rain('confetti', { count: 110 })
    s.word(w / 2, h * 0.35, 'TICKET CLOSED!', { color: GOLD, size: Math.min(90, w / 10), life: 1.8 })
  },
  attention: c => {
    const s = c.t.stage
    c.show.sound('siren', c)
    for (let i = 0; i < 4; i++) setTimeout(() => s.flash(i % 2 ? '#3b6bff' : RED, 0.2, 0.2), i * FLASH_EVERY_MS)
    s.glyph(c.at.x, c.at.y + 60, '!', { color: '#ffb35c', size: 110 })
    s.word(c.at.x, c.at.y + 130, 'ATTENTION!', { color: RED, ink: '#2a0000', size: 34, caption: captionOf(c) })
  },

  /* ── watchdogs, audiences, credits, settings ──────────────────────── */
  dogFired: c => PLAYBOOK.bark!(c),
  dogNew: c => {
    c.show.sound('bark', c, { pitch: 1.3, gain: 0.6 })
    c.t.stage.burst(c.at.x, c.at.y, { count: 8, kind: 'paw', colors: ['#c98a3c', '#e0a85a'], speed: [60, 160], size: [8, 12], life: [0.9, 1.3], gravity: 160 })
    c.t.stage.word(c.at.x, above(c), 'GOOD DOG!', { color: '#ffb35c', size: 32 })
  },
  dogGone: c => {
    c.show.sound('sleep', c)
    c.t.stage.burst(c.at.x, c.at.y, { count: 10, kind: 'smoke', colors: [GREY], speed: [10, 50], size: [10, 18], life: [0.8, 1.2], gravity: -50, grow: 20 })
  },
  audience: c => {
    const s = c.t.stage
    c.show.sound('chime', c)
    const from = c.from
    if (from && from.doc === c.at.doc) {
      for (const col of [PINK, GOLD, CYAN]) s.bolt(from.x, from.y, c.at.x, c.at.y, { color: col, life: 0.5, width: 2.5, branches: 1 })
    }
    s.word(c.at.x, above(c), 'AUDIENCE!', { color: PINK, size: 34 })
  },
  unaudience: c => {
    c.show.sound('drop', c, { gain: 0.6 })
    c.t.stage.burst(c.at.x, c.at.y, { count: 14, kind: 'smoke', colors: [GREY], speed: [10, 60], size: [10, 18], life: [0.8, 1.2], grow: 18 })
  },
  creditRequest: c => {
    c.show.sound('coins', c)
    c.t.stage.glyph(c.at.x, c.at.y + 60, '$?', { color: GOLD, size: 80 })
  },
  cost: c => {
    c.show.sound('coins', c, { gain: 0.5 })
    c.t.stage.rain('coin', { count: 30 })
  },
  settings: c => {
    const s = c.t.stage, { w } = s.size
    c.show.sound('clack', c)
    s.gear(w - 60, 60, { size: 40, color: GOLD, life: 1 })
    s.gear(w - 108, 84, { size: 26, color: '#c9d6e3', life: 1 })
  },

  /* ── the user's own hands ─────────────────────────────────────────── */
  click: c => {
    c.show.sound('click', c)
    const s = c.t.stage
    s.burst(c.at.x, c.at.y, { count: 16, colors: [GOLD, '#ffffff', ORANGE], speed: [80, 320], size: [3, 7], life: [0.25, 0.55] })
    s.ring(c.at.x, c.at.y, { color: '#ffffff', radius: 46, width: 3, life: 0.35 })
  },
  tab: c => {
    c.show.sound('blip', c)
    c.t.stage.burst(c.at.x, c.at.y + 10, { count: 16, kind: 'streak', colors: [GOLD, '#ffffff'], speed: [200, 420], size: [4, 6], life: [0.2, 0.4], angle: 0, spread: Math.PI * 2 })
  },
  toggle: c => {
    c.show.sound('clack', c)
    c.t.stage.gear(c.at.x, c.at.y, { size: 18, color: c.ev.n ? GREEN : GREY, life: 0.6 })
    c.t.stage.burst(c.at.x, c.at.y, { count: 12, colors: [c.ev.n ? GREEN : GREY, '#ffffff'], speed: [60, 200], size: [3, 6], life: [0.3, 0.6] })
  },
  select: c => {
    c.show.sound('slots', c, { gain: 0.6 })
    c.t.stage.ring(c.at.x, c.at.y, { color: GOLD, radius: 60, width: 4, life: 0.4 })
  },
  send: c => {
    const s = c.t.stage
    c.show.sound('send', c)
    s.burst(c.at.x, c.at.y, { count: 40, colors: [ORANGE, GOLD, '#ffffff'], speed: [100, 420], size: [4, 9], life: [0.4, 0.9], gravity: 500, angle: Math.PI / 2, spread: 1.2 })
    s.comet(c.at.x, c.at.y, c.at.x + rand(-80, 80), -40, { color: GOLD, duration: 0.6, arc: 0.1 })
  },
  destroy: c => {
    c.show.sound('thud', c)
    c.t.stage.burst(c.at.x, c.at.y, { count: 16, kind: 'smoke', colors: ['#8b949e', '#c9d1d9'], speed: [30, 120], size: [10, 18], life: [0.6, 1], grow: 30 })
  },
  type: c => {
    c.show.sound('type', c, { pitch: rand(0.85, 1.25) })
    c.t.stage.burst(c.at.x, c.at.y, { count: 6, colors: [GOLD, '#ffffff', ORANGE], speed: [60, 220], size: [2, 5], life: [0.2, 0.45], gravity: 300, angle: -Math.PI / 2, spread: 2 })
  },
  enter: c => {
    c.show.sound('enter', c)
    const s = c.t.stage
    s.burst(c.at.x, c.at.y, { count: 34, colors: [GOLD, '#ffffff', ORANGE], speed: [120, 380], size: [3, 7], life: [0.4, 0.8] })
    s.ring(c.at.x, c.at.y, { color: GOLD, radius: 80, width: 4, life: 0.4 })
  },
  erase: c => {
    c.show.sound('type', c, { pitch: 0.6 })
    c.t.stage.burst(c.at.x, c.at.y, { count: 4, kind: 'smoke', colors: [GREY], speed: [10, 50], size: [6, 10], life: [0.3, 0.5], grow: 14 })
  },
  zoomIn: c => {
    c.show.sound('warp', c, { pitch: 1.3 })
    c.t.stage.burst(c.at.x, c.at.y, { count: 22, kind: 'streak', colors: ['#ffffff', CYAN], speed: [500, 900], size: [4, 7], life: [0.18, 0.32], drag: 0.4 })
  },
  zoomOut: c => {
    c.show.sound('warp', c, { pitch: 0.75 })
    const s = c.t.stage
    for (let i = 0; i < 14; i++) {
      const a = rand(0, Math.PI * 2), r = rand(160, 260)
      s.burst(c.at.x + Math.cos(a) * r, c.at.y + Math.sin(a) * r, { count: 1, kind: 'streak', colors: ['#ffffff', CYAN], speed: [500, 800], size: [4, 7], life: [0.2, 0.3], angle: a + Math.PI, spread: 0.05, drag: 0.4 })
    }
  },
  pan: c => {
    c.t.stage.burst(c.at.x, c.at.y, { count: 3, kind: 'streak', colors: ['#ffffff', '#cfe3ff'], speed: [120, 300], size: [3, 5], life: [0.2, 0.35] })
  },
  grab: c => {
    c.show.sound('grab', c)
    c.t.stage.ring(c.at.x, c.at.y, { color: '#ffffff', radius: 40, width: 3, life: 0.3 })
  },
  drop: c => {
    const s = c.t.stage
    c.show.sound('thud', c)
    s.burst(c.at.x, c.at.y + 20, { count: 22, kind: 'smoke', colors: ['#d9c7a3', '#b8a27a'], speed: [80, 260], size: [10, 18], life: [0.5, 0.9], grow: 30, angle: -Math.PI / 2, spread: Math.PI, drag: 3 })
    s.ring(c.at.x, c.at.y, { color: '#d9c7a3', radius: 90, width: 5, life: 0.4 })
    s.shake(4, 180)
  },
  menu: c => {
    c.show.sound('whooshIn', c, { gain: 0.6 })
    c.t.stage.ring(c.at.x, c.at.y, { color: PURPLE, radius: 60, width: 4, life: 0.35 })
  },
  copy: c => {
    c.show.sound('blip', c)
    c.t.stage.word(c.at.x, c.at.y - 20, 'COPIED!', { color: CYAN, size: 26, life: 0.8 })
  },
  paste: c => {
    c.show.sound('stamp', c, { gain: 0.7 })
    c.t.stage.word(c.at.x, c.at.y - 20, 'PASTED!', { color: GOLD, size: 26, life: 0.8 })
  },
  fileDrop: c => {
    c.show.sound('whirr', c)
    c.t.stage.vortex(c.at.x, c.at.y, { color: GOLD, inward: true, radius: 120 })
    c.t.stage.word(c.at.x, c.at.y - 40, 'INCOMING FILES!', { color: GOLD, size: 30 })
  },
  dialogOpen: c => {
    const s = c.t.stage
    c.show.sound('whooshIn', c)
    s.flash('#ffffff', 0.08, 0.25)
    if (c.at.rect) s.frame(c.at.rect, { color: GOLD, life: 0.55, width: 4 })
    s.ring(c.at.x, c.at.y, { color: GOLD, radius: 260, width: 6, life: 0.5 })
  },
  dialogClose: c => { c.show.sound('whooshOut', c) },
  scroll: c => {
    c.show.sound('tick', c, { pitch: (c.ev.n ?? 1) < 0 ? 1.3 : 0.8 })
    c.t.stage.burst(c.at.x, c.at.y, { count: 6, kind: 'streak', colors: ['#ffffff', CYAN], speed: [260, 460], size: [3, 5], life: [0.15, 0.3], angle: (c.ev.n ?? 1) < 0 ? -Math.PI / 2 : Math.PI / 2, spread: 0.5 })
  },
  // keyboard navigation outside text fields: chevron streaks the way it went
  navigate: c => {
    const a = c.ev.n ?? 0
    c.show.sound('warp', c, { pitch: Math.sin(a) < 0 ? 1.25 : 0.85, gain: 0.8 })
    c.t.stage.burst(c.at.x, c.at.y, { count: 10, kind: 'streak', colors: ['#ffffff', CYAN, PURPLE], speed: [260, 520], size: [4, 7], life: [0.15, 0.3], angle: a, spread: 0.6 })
  },
  focus: c => {
    c.show.sound('blip', c, { pitch: 1.4 })
    if (c.at.rect) c.t.stage.frame(c.at.rect, { color: CYAN, life: 0.45, width: 3, pad: 3 })
    c.t.stage.ring(c.at.x, c.at.y, { color: CYAN, radius: 40, width: 3, life: 0.35 })
  },
  undo: c => {
    const s = c.t.stage
    c.show.sound('warp', c, { pitch: 0.7, gain: 1.6 })
    c.show.sound('whooshOut', c)
    s.vortex(c.at.x, c.at.y, { color: CYAN, inward: true, radius: 120, life: 0.6 })
    s.word(c.at.x, c.at.y - 50, 'UNDO!', { color: CYAN, size: 46 })
  },
  redo: c => {
    const s = c.t.stage
    c.show.sound('warp', c, { pitch: 1.4, gain: 1.6 })
    c.show.sound('whooshIn', c)
    s.vortex(c.at.x, c.at.y, { color: GOLD, inward: false, radius: 120, life: 0.6 })
    s.word(c.at.x, c.at.y - 50, 'REDO!', { color: GOLD, size: 46 })
  },
  shortcut: c => {
    c.show.sound('clack', c)
    c.t.stage.word(c.at.x, c.at.y - 30, `CTRL+${c.ev.text ?? ''}`, { color: '#ffffff', size: 26, life: 0.8 })
  },
  doubleClick: c => {
    const s = c.t.stage
    c.show.sound('click', c, { pitch: 1.3 })
    c.show.sound('click', c, { pitch: 0.8 })
    s.ring(c.at.x, c.at.y, { color: GOLD, radius: 70, width: 4, life: 0.35 })
    s.ring(c.at.x, c.at.y, { color: '#ffffff', radius: 110, width: 3, life: 0.45, delay: 0.08 })
  },
  linkDown: c => {
    const s = c.t.stage, { w, h } = s.size
    c.show.sound('powerFail', c)
    s.flicker(1.2)
    s.word(w / 2, h * 0.3, 'SIGNAL LOST', { color: RED, ink: '#200000', size: Math.min(80, w / 11), life: 1.8 })
  },
  linkUp: c => {
    const s = c.t.stage, { w, h } = s.size
    c.show.sound('resume', c)
    s.flash('#b6ffd3', 0.25, 0.4)
    s.word(w / 2, h * 0.3, 'BACK ONLINE!', { color: GREEN, ink: '#002a12', size: Math.min(80, w / 11), life: 1.6 })
  },
  usageWarn: c => {
    const s = c.t.stage
    c.show.sound('siren', c, { gain: 0.6 })
    s.word(c.at.x, c.at.y + 50, `${c.ev.text ?? ''} ${Math.round(c.ev.n ?? 90)}%!`, { color: ORANGE, size: 34 })
    s.ring(c.at.x, c.at.y, { color: ORANGE, radius: 90, width: 5 })
  },
  // a usage reading reaching 100%: the meter pegs. A reading, never a limit
  // (the Astra take; user 2026-10-14: an account at 100% may still have
  // credit), so nothing here says LIMIT or browns the window out
  usageMax: c => {
    const s = c.t.stage, { w, h } = s.size
    c.show.sound('maxed', c)
    s.word(w / 2, h * 0.4, `${c.ev.text ?? ''} 100%!`, { color: ORANGE, ink: '#2b1000', size: Math.min(100, w / 9), life: 2 })
    s.burst(c.at.x, c.at.y, { count: 50, kind: 'streak', colors: [ORANGE, GOLD, '#ffffff'], speed: [200, 560], size: [5, 9], life: [0.3, 0.8], gravity: 900 })
    s.ring(c.at.x, c.at.y, { color: ORANGE, radius: 120, width: 6 })
    s.shake(8, 400)
  },
  usageReset: c => {
    c.show.sound('resume', c)
    c.show.sound('coins', c)
    c.t.stage.word(c.at.x, c.at.y + 50, `${c.ev.text ?? ''} REFILLED!`, { color: GREEN, ink: '#002a12', size: 34 })
    c.t.stage.rain('coin', { count: 40 })
  },
  popup: c => {
    c.show.sound('whooshIn', c, { gain: 0.5 })
    if (c.at.rect) c.t.stage.frame(c.at.rect, { color: PURPLE, life: 0.4, width: 3, pad: 2 })
    c.t.stage.ring(c.at.x, c.at.y, { color: PURPLE, radius: 70, width: 4, life: 0.35 })
  },
  toast: c => {
    c.show.sound('notice', c)
    if (c.at.rect) c.t.stage.frame(c.at.rect, { color: GOLD, life: 0.6, width: 3 })
    c.t.stage.burst(c.at.x, c.at.y, { count: 20, colors: [GOLD, '#ffffff'], speed: [60, 220], size: [3, 6], life: [0.4, 0.8] })
  },
  toastError: c => {
    const s = c.t.stage
    if (!c.show.firedWithin('refused', 1500)) {
      c.show.sound('glass', c)
      c.show.sound('error', c, { gain: 0.6 })
    }
    s.cracks(c.at.x, c.at.y, { count: 8, length: 140 })
    if (c.at.rect) s.frame(c.at.rect, { color: RED, life: 0.7, width: 4 })
    s.shake(6, 260)
  },

  /* ── the final version's additions ────────────────────────────────── */
  // a confirming click (save, apply, create, OK …): a two-coin ding and a
  // burst of stars (the Wonder Full take)
  confirm: c => {
    const s = c.t.stage
    c.show.sound('confirm', c)
    s.burst(c.at.x, c.at.y, { count: 18, kind: 'star', colors: [GOLD, '#ffffff', '#ffe9a8'], speed: [90, 300], size: [5, 9], life: [0.4, 0.8], gravity: 300 })
    s.ring(c.at.x, c.at.y, { color: GOLD, radius: 60, width: 4, life: 0.4 })
  },
  // a change the engine refused (the Astra take's FAULT): a warning sign
  // where the user pressed, the glass cracking around it
  refused: c => {
    const s = c.t.stage
    c.show.sound('refused', c)
    s.warn(c.at.x, c.at.y - 10, { size: 54 })
    s.cracks(c.at.x, c.at.y, { count: 7, length: 120 })
    s.word(c.at.x, c.at.y - 84, 'REFUSED!', { color: RED, ink: '#2a0000', size: 40, caption: captionOf(c) ?? c.ev.text })
    s.flash(RED, 0.14, 0.3)
    s.shake(5, 220)
  },
  // another org's routine notice
  notice: c => {
    const s = c.t.stage
    c.show.sound('notice', c)
    s.ring(c.at.x, c.at.y, { color: CYAN, radius: 90, width: 4, life: 0.5 })
    s.burst(c.at.x, c.at.y, { count: 18, colors: [CYAN, '#ffffff'], speed: [60, 220], size: [3, 6], life: [0.4, 0.8] })
    s.word(c.at.x, c.at.y - 50, 'REPORT!', { color: CYAN, ink: '#00222b', size: 30, life: 1.2, caption: captionOf(c) })
  },
}

/** How heavy each event is (user 2026-10-15: "more screen shake effects and
 *  screen blurs", scaled to the event's weight). Everything not listed is
 *  light: the user's own hands and the frequent ticks of agents' work get no
 *  shake and no blur. */
export const WEIGHT: Partial<Record<Kind, 1 | 2 | 3>> = {
  // medium: turns, mail, questions and the like
  move: 1, thaw: 1, unhalt: 1, compact: 1, question: 1, answer: 1, docs: 1, turnStart: 1, turnEnd: 1,
  zap: 1, userSend: 1, toUser: 1, bark: 1, dogFired: 1, orgInbox: 1, userMail: 1, externalMail: 1,
  audience: 1, creditRequest: 1, mailbox: 1, linkUp: 1, usageWarn: 1, dialogOpen: 1,
  fileDrop: 1, destroy: 1,
  // heavy: an agent arriving, leaving or stopped, a failure, a ticket opened,
  // closed or flagged
  hire: 2, rehire: 2, retire: 2, freeze: 2, limit: 2, halt: 2, interrupt: 2, error: 2, refused: 2,
  toastError: 2, ticket: 2, ticketDone: 2, attention: 2, brownout: 2, linkDown: 2, killswitchOff: 2,
  epicLaunch: 2, usageMax: 2,
  // the biggest moments
  epicOn: 3, killswitch: 3, urgent: 3,
}
/** what each weight feels like: a shake (px, ms), a blur, which a medium
 *  event keeps to the window's edges, and the afterglow it leaves where it
 *  happened (user 2026-10-15: "more lingering effects that remain on screen
 *  for longer"). The stage holds every one to its comfort bounds and its
 *  residue cap, and an effect's own stronger shake is never cut short. */
const FEEL = {
  1: { shake: [3, 220], blur: { px: 4, ms: 420, edges: true }, glow: { strength: 0.3, life: 8, radius: 70, color: GOLD } },
  2: { shake: [8, 420], blur: { px: 4, ms: 500 }, glow: { strength: 0.55, life: 12, radius: 95, color: ORANGE } },
  3: { shake: [14, 650], blur: { px: 6, ms: 650 }, glow: { strength: 0.8, life: 16, radius: 130, color: RED } },
} as const

/** an event's weight, felt in its own window, harder by progression's `lift`
 *  (up to half as much again) */
function felt(c: Cue, lift = 1): void {
  const weight = WEIGHT[c.ev.kind]
  if (!weight) return
  const { shake, blur, glow } = FEEL[weight]
  const more = 1 + (lift - 1) / 4
  c.t.stage.shake(shake[0] * more, shake[1])
  c.t.stage.blur({ ...blur, px: blur.px * more })
  c.t.stage.afterglow(c.at.x, c.at.y, { ...glow, strength: Math.min(1, glow.strength * more) })
}

/** two-ended events that bring two agents together: their charges combine */
const MEETS: ReadonlySet<Kind> = new Set<Kind>(['zap'])

/** the aurora's strength now (0 under AURORA_FROM momentum) */
function auroraLevel(): number {
  const m = progress.momentum(performance.now())
  return m < progress.AURORA_FROM ? 0 : Math.min(1, 0.4 + (m - progress.AURORA_FROM) / 90)
}

/** the playbook's coverage, for the inventory doc and its test */
export const PLAYBOOK_KINDS = Object.keys(PLAYBOOK) as Kind[]

/** Start the show in one window. */
export function startEpic(opts: EpicOptions = {}): EpicShow {
  return new Show(opts)
}
