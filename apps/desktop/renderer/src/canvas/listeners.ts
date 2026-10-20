// canvas/listeners.ts — a project's EVENT LISTENERS as the desktop reads
// them (Orgtree 4.4.0; docket
// `project-event-listeners-sync-monitor-watchdogs-l`, user 2026-10-19).
//
// A `project_listener` watchdog receives each event fired on its project
// (`orgtree_project action=fire_event`); a `listener_watch` fires when the
// armed listeners on its project reach its `count`. Everything here is
// read from the tree's watchdogs: a dog's target is its project's name
// (a rename moves it), armed listeners with live owners are the count
// the engine's watches use, and paused dogs listen for nothing. The
// header cards complete the CMY triplet beside the fair-queue rose and
// the slot amber: cyan lines and cards.

import type { Watchdog } from '../types'
import type { CanvasNode } from './shared'
import { isUserName } from './username'

const target = (w: Watchdog) => w.target.replace(/^@/, '')

/** The listeners and watches on one project, armed or paused, oldest first. */
export interface ProjectListenerState {
  /** every project_listener dog on the project (armed or paused) */
  listeners: Watchdog[]
  /** the armed ones: the count the watches and cards read */
  armed: Watchdog[]
  /** every listener_watch dog on the project (armed or paused) */
  watches: Watchdog[]
  /** the armed watches, each with its count */
  armedWatches: Watchdog[]
}

export function projectListenerState(project: string, dogs: Watchdog[]): ProjectListenerState {
  const on = (w: Watchdog) => !w.spent && (w.state === 'armed' || w.state === 'paused') && target(w) === project
  const listeners = dogs.filter((w) => w.kind === 'project_listener' && on(w))
  const watches = dogs.filter((w) => w.kind === 'listener_watch' && on(w))
  return {
    listeners,
    armed: listeners.filter((w) => w.state === 'armed'),
    watches,
    armedWatches: watches.filter((w) => w.state === 'armed'),
  }
}

/** One header/near-zoom card: the plain listener count, or one watch's x/y. */
export interface ListenerCard {
  key: string
  text: string
  /** a watch's card is the brighter cyan; the count-only card stays darker */
  bright: boolean
  title: string
}

/** The cyan cards a project shows: with any watch armed, one bright x/y
 *  card per watch (x is the armed count); else one dark count card while
 *  listeners are armed. Nothing when nobody listens. */
export function listenerCards(project: string, s: ProjectListenerState): ListenerCard[] {
  const n = s.armed.length
  const who = n ? `: ${s.armed.map((w) => w.owner).join(', ')}` : ''
  if (s.armedWatches.length) {
    return s.armedWatches.map((w) => ({
      key: 'lw:' + w.id,
      text: `listeners ${n}/${w.count ?? '?'}`,
      bright: true,
      title: `${w.owner}'s listener watch "${w.name}" fires when ${w.count ?? '?'} event listeners are armed on project ${project}; `
        + `${n} ${n === 1 ? 'is' : 'are'} armed now${who}. Click for the listeners tab.`,
    }))
  }
  if (!n) return []
  return [{
    key: 'listeners:' + project,
    text: `listeners ${n}`,
    bright: false,
    title: `${n} event listener${n === 1 ? '' : 's'} armed on project ${project}${who}. `
      + `Each receives every event fired on the project. Click for the listeners tab.`,
  }]
}

/** A listener line on the canvas: an event listener's solid cyan, a
 *  watch's dashed cyan; paused draws dimmed (as a fair-queue line does). */
export interface ListenerLink { key: string; owner: string; project: string; watch: boolean; paused: boolean }

/** One line per armed or paused project_listener/listener_watch dog whose
 *  project is on the canvas. Spent one-shots listen for nothing; a dog its
 *  project's event-listeners switch-off disabled is unwired (user
 *  2026-10-20 10:50Z): no line until the setting is on again. */
export function listenerLinks(dogs: Watchdog[], isProject: (name: string) => boolean): ListenerLink[] {
  const out: ListenerLink[] = []
  for (const w of dogs) {
    // the user draws no line: they are no node of the tree (their listeners still count)
    if ((w.kind !== 'project_listener' && w.kind !== 'listener_watch') || w.spent || w.disabled || isUserName(w.owner)
      || (w.state !== 'armed' && w.state !== 'paused')) continue
    const project = target(w)
    if (!isProject(project)) continue
    out.push({
      key: (w.kind === 'listener_watch' ? 'lw:' : 'pl:') + w.id,
      owner: w.owner, project, watch: w.kind === 'listener_watch', paused: w.state === 'paused',
    })
  }
  return out
}

/** Are the project's event listeners on (`event_listeners` in its scope;
 *  user 2026-10-20 10:50Z)? Off, the default, until an agent registers a
 *  listener or a superior switches them on; it alone decides the desk's
 *  Listeners tab. */
export function eventListenersOn(node: { configured_scope?: unknown }): boolean {
  return (node.configured_scope as { event_listeners?: unknown } | undefined)?.event_listeners === true
}

/** Is the project's mail queue in ack mode (`mail_queue` in its scope,
 *  read like `slotCount` reads `slots_capacity`)? */
export function queueAckMode(node: { configured_scope?: unknown }): boolean {
  return (node.configured_scope as { mail_queue?: unknown } | undefined)?.mail_queue === 'ack'
}

/** A project's one magenta mail card (the fair-queue rose, merged by the
 *  user 2026-10-19 18:17Z): how many agents listen for its mail with an
 *  armed fair_queue dog (paused watchers take no mail and do not count),
 *  how much mail waits, and — while ack mode is on — how much is handed
 *  out awaiting an ack. Short chip text in the user's wording
 *  ("2 listeners · 1 q'd · 1 in flight"), zero parts left out, the full
 *  wording in the title. Null while all three are zero. */
export interface QueueCard {
  text: string
  title: string
  bright: boolean
  /** the armed mail listeners it counts: a card naming any opens the inbox's
   *  listeners folder, one naming only mail opens the inbox folder */
  listeners: number
}

/** A project's MAIL LISTENERS (the inbox's listeners folder, user 2026-10-19
 *  19:05Z): its fair_queue dogs, armed or paused, in the tree's order. Only
 *  the armed ones take its mail; spent one-shots are gone. */
export interface MailListenerState { listeners: Watchdog[]; armed: Watchdog[] }

export function mailListenerState(project: string, dogs: Watchdog[]): MailListenerState {
  const listeners = dogs.filter((w) => w.kind === 'fair_queue' && !w.spent
    && (w.state === 'armed' || w.state === 'paused') && target(w) === project)
  return { listeners, armed: listeners.filter((w) => w.state === 'armed') }
}

export function mailQueueCard(project: string, waiting: number, held: number, ack: boolean, dogs: Watchdog[]): QueueCard | null {
  const armed = mailListenerState(project, dogs).armed
  const listeners = armed.length
  const inFlight = ack ? held : 0
  if (listeners <= 0 && waiting <= 0 && inFlight <= 0) return null
  const parts: string[] = []
  if (listeners > 0) parts.push(`${listeners} listener${listeners === 1 ? '' : 's'}`)
  if (waiting > 0) parts.push(`${waiting} q'd`)
  if (inFlight > 0) parts.push(`${inFlight} in flight`)
  const facts: string[] = []
  if (listeners > 0) {
    facts.push(`${listeners} mail listener${listeners === 1 ? '' : 's'} (fair_queue) armed on project ${project}: `
      + `${armed.map((w) => w.owner).join(', ')}. They share its waiting mail.`)
  }
  if (waiting > 0 || inFlight > 0) {
    facts.push(ack
      ? `${waiting} mail${waiting === 1 ? '' : 's'} waiting in project ${project}'s ack queue and ${inFlight} handed out awaiting an ack.`
      : `${waiting} mail${waiting === 1 ? '' : 's'} waiting in project ${project}'s mail queue for a fair_queue watcher.`)
  }
  return { text: parts.join(' · '),
    title: facts.join(' ') + (listeners > 0 ? ' Click for the mail listeners.' : ' Click for the project mailbox.'),
    bright: listeners > 0 || inFlight > 0, listeners }
}
/** The tool names a dog runs when it fires, for lists and tabs. */
export function fireActionTools(w: Watchdog): string[] {
  return (w.fire_actions ?? []).map((a) => a.tool).filter(Boolean)
}

/** Since when a listener or watch has listened (the desk's Waited, user
 *  2026-10-20 06:22Z): its arming or its last fire, the later (engine
 *  `listeners::LISTENING_SINCE`). */
export function listeningSince(w: Pick<Watchdog, 'at' | 'last_fired'>): string {
  return w.last_fired && Date.parse(w.last_fired) > Date.parse(w.at) ? w.last_fired : w.at
}

/** The event a project's dead letters fire (engine `events::DEAD_LETTER`). */
export const DEAD_LETTER_EVENT = 'project.dead_letter'

/** Does an `event` dog's target take this event (engine `accepts`): the
 *  exact name, or a prefix ending in `*`. */
export function acceptsEvent(target: string, name: string): boolean {
  const t = target.replace(/^@/, '')
  return t === name || (t.endsWith('*') && name.startsWith(t.slice(0, -1)))
}

/** A DEAD-LETTER LISTENER (user 2026-10-20 06:41Z): an `event` dog that
 *  takes `project.dead_letter`. Its chip and card wear the dead-letter
 *  sepia-maroon wherever they are drawn (`watchdogKindClass`). */
export const isDeadLetterListener = (w: Pick<Watchdog, 'kind' | 'target'>) =>
  w.kind === 'event' && acceptsEvent(w.target ?? '', DEAD_LETTER_EVENT)

/** Is `agent` above or below `project` in the tree (engine `projects::reaches`)? */
export function reachesProject(agent: string, project: string, map: Map<string, CanvasNode>): boolean {
  const above = (from: string, target: string) => {
    let id = map.get(from)?.parent
    for (let depth = 0; id && depth < 1024; depth++) {
      if (id === target) return true
      id = map.get(id)?.parent
    }
    return false
  }
  return agent !== project && (above(project, agent) || above(agent, project))
}

/** A project's DEAD-LETTER LINE (the Mail tab's listeners folder, user
 *  2026-10-20 06:41Z): armed or paused dead-letter dogs whose owners reach
 *  the project and whose pattern, if any, takes its dead letters — tested
 *  on the line the engine matches (`<event> <payload> (n matches)`); a
 *  pattern this side cannot read counts. */
export function deadLetterListeners(project: string, dogs: Watchdog[], map: Map<string, CanvasNode>): Watchdog[] {
  const line = `${DEAD_LETTER_EVENT} ${JSON.stringify({ project, mail: '', from: '', attempts: 0, by: '', why: '' })} (1 matches)`
  const takes = (pattern?: string) => {
    if (!pattern) return true
    try { return new RegExp(pattern).test(line) } catch { return true }
  }
  return dogs.filter((w) => isDeadLetterListener(w) && !w.spent && (w.state === 'armed' || w.state === 'paused')
    && reachesProject(w.owner, project, map) && takes(w.pattern))
}
