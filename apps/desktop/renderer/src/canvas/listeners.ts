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
 *  project is on the canvas. Spent one-shots listen for nothing. */
export function listenerLinks(dogs: Watchdog[], isProject: (name: string) => boolean): ListenerLink[] {
  const out: ListenerLink[] = []
  for (const w of dogs) {
    if ((w.kind !== 'project_listener' && w.kind !== 'listener_watch') || w.spent
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
export interface QueueCard { text: string; title: string; bright: boolean }

export function mailQueueCard(project: string, waiting: number, held: number, ack: boolean, dogs: Watchdog[]): QueueCard | null {
  const armed = dogs.filter((w) => w.kind === 'fair_queue' && !w.spent && w.state === 'armed' && target(w) === project)
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
  return { text: parts.join(' · '), title: facts.join(' ') + ' Click for the project mailbox.',
    bright: listeners > 0 || inFlight > 0 }
}
/** The tool names a dog runs when it fires, for lists and tabs. */
export function fireActionTools(w: Watchdog): string[] {
  return (w.fire_actions ?? []).map((a) => a.tool).filter(Boolean)
}
