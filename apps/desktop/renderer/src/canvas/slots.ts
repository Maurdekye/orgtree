// canvas/slots.ts — a project's SLOTS as the desktop reads them (Orgtree
// 4.4.0; docket `project-slots-first-come-permits-claimed-through`, user
// 2026-10-18 08:37Z-08:46Z, mockup approved with canvas-line option A).
//
// A project with a slot count N gives out N permits, first come first served
// (engine domain/slots.rs). Everything here is read from the tree: the count
// from the project's scope (`slots_capacity`, 0 = none), the holders from the
// org's held leases (`tree.slot_leases`; a granted claim is spent, so its
// lease is the only record of the holder), and the line from the armed,
// ungranted `slot` watchdogs in the order they joined (`queued_at`; a paused
// claim has left the line). The desk's Slots tab adds the recent holds from
// the `slot_status` op.

import type { Watchdog } from '../types'
import { isUserName } from './username'

/** One held lease, as the tree feed's watchdogs group carries it. */
export interface SlotLease {
  project: string
  agent: string
  slot: number
  slots?: number
  lease: string
  reason?: string | null
  since: string
  reminders?: number
}

/** A claim waiting in a project's line; `place` is 1-based. */
export interface SlotWaiter { agent: string; dog: string; name: string; since?: string; place: number; slots?: number }

export interface ProjectSlotState { total: number; held: SlotLease[]; line: SlotWaiter[] }

/** The largest slot count a project may have (engine `slots::MAX_CAPACITY`). */
export const MAX_SLOTS = 64

/** Legacy payloads reserved one slot. The private slot ordinal is unrelated. */
export const slotUnits = (n?: number) => Number.isInteger(n) && n! >= 1 && n! <= MAX_SLOTS ? n! : 1
export const heldSlotCount = (s: Pick<ProjectSlotState, 'held'>) => s.held.reduce((n, l) => n + slotUnits(l.slots), 0)

/** A project's slot count: `slots_capacity` in its scope, 0 (none) by default
 *  or when out of range (user 2026-10-18 08:42Z: the count is the switch). */
export function slotCount(node: { configured_scope?: unknown }): number {
  const n = (node.configured_scope as { slots_capacity?: unknown } | undefined)?.slots_capacity
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_SLOTS ? n : 0
}

const target = (w: Watchdog) => w.target.replace(/^@/, '')
const waiting = (w: Watchdog) => w.kind === 'slot' && w.state === 'armed' && !w.spent && !w.lease
const joined = (w: Watchdog) => Date.parse(w.queued_at ?? w.at) || 0

/** The waiting claims on `project`, first come first. */
function lineOf(project: string, dogs: Watchdog[]): Watchdog[] {
  return dogs.filter((w) => waiting(w) && target(w) === project).sort((a, b) => joined(a) - joined(b))
}

export function projectSlotState(project: string, total: number, leases: SlotLease[], dogs: Watchdog[]): ProjectSlotState {
  return {
    total,
    held: leases.filter((l) => l.project === project).sort((a, b) => a.slot - b.slot),
    line: lineOf(project, dogs).map((w, i) => ({ agent: w.owner, dog: w.id, name: w.name, since: w.queued_at, place: i + 1, slots: slotUnits(w.slots) })),
  }
}

export function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return n + suffix
}

const waitingNote = (s: ProjectSlotState) => s.line.length ? ` · ${s.line.length} waiting` : ''

/** The project card's badge: "1/1 held · 2 waiting", "0/2 held"; none without slots. */
export function slotBadgeText(s: ProjectSlotState): string | null {
  return s.total > 0 ? `${heldSlotCount(s)}/${s.total} held${waitingNote(s)}` : null
}

/** The desk header's card (user 08:46Z): "slots 1/1 · 2 waiting". */
export function slotHeaderText(s: ProjectSlotState): string {
  return `slots ${heldSlotCount(s)}/${s.total}${waitingNote(s)}`
}

/** The Concurrency slots tab's lead: "1 of 1 concurrency slot held", "0 of 2
 *  concurrency slots held" (spelled out, user 2026-10-18 12:16Z). */
export function slotLeadText(s: ProjectSlotState): string {
  return `${heldSlotCount(s)} of ${s.total} concurrency slot${s.total === 1 ? '' : 's'} held`
}

/** Every slot is held: the badge and card are filled, otherwise outlined. */
export const slotsFull = (s: ProjectSlotState) => s.total > 0 && heldSlotCount(s) >= s.total

/** The slots `agent` holds: its card's "⬢ build" chips. */
export function slotHoldsOf(agent: string, leases: SlotLease[]): SlotLease[] {
  return leases.filter((l) => l.agent === agent)
}

/** A waiting claim's place in its project's line, or null. */
export function slotPlace(dog: Watchdog, dogs: Watchdog[]): number | null {
  if (!waiting(dog)) return null
  const i = lineOf(target(dog), dogs).findIndex((w) => w.id === dog.id)
  return i < 0 ? null : i + 1
}

/** A slot claim's card text: its place and who holds, or its grant. */
export function slotClaimText(dog: Watchdog, dogs: Watchdog[], leases: SlotLease[], total: number): string {
  const project = target(dog)
  const n = slotUnits(dog.slots)
  if (dog.lease) return `Granted ${n === 1 ? 'a concurrency slot' : `${n} concurrency slots`} of ${project} (lease ${dog.lease}).`
  if (dog.state === 'paused') return `Concurrency slot claim on project ${project}, paused: out of the line; resuming rejoins at the back.`
  const line = lineOf(project, dogs)
  const at = line.findIndex((w) => w.id === dog.id)
  if (at < 0) return `Concurrency slot claim on project ${project}.`
  const ahead = line.slice(0, at).map((w) => w.owner)
  const holds = leases.filter((l) => l.project === project)
  const held = holds.map((l) => l.agent)
  return `Concurrency slot claim: ${ordinal(at + 1)} in line for project ${project} (behind ${ahead.length ? ahead.join(', ') : 'nobody'}; `
    + `${heldSlotCount({ held: holds })} of ${total} held${held.length ? ' by ' + held.join(', ') : ''})${n > 1 ? `; waiting for ${n} slots` : ''}.`
}

/** A slot line on the canvas: a holder's solid, a waiter's dashed (option A). */
export interface SlotLink { key: string; owner: string; project: string; holding: boolean }

/** The holders' lines, then the waiting claims' (paused, spent and granted
 *  claims draw nothing: a holder draws through its lease). */
export function slotLinks(dogs: Watchdog[], leases: SlotLease[], isProject: (name: string) => boolean): SlotLink[] {
  const out: SlotLink[] = []
  // the user draws no line: they are no node of the tree (their holds and waits are still counted)
  for (const l of leases) {
    if (isProject(l.project) && !isUserName(l.agent)) out.push({ key: 'sl:' + l.lease, owner: l.agent, project: l.project, holding: true })
  }
  for (const w of dogs) {
    if (waiting(w) && isProject(target(w)) && !isUserName(w.owner)) out.push({ key: 'sw:' + w.id, owner: w.owner, project: target(w), holding: false })
  }
  return out
}

/** One line between an agent and a project (either way round). */
export interface ProjectLine { key: string; agent: string; project: string }

/** How far apart side-by-side lines run, in canvas px. */
export const LANE_GAP = 8

/** Side-by-side lanes (user 2026-10-18, with the mockup's approval): an
 *  agent's several lines to one project (its audience, its fair-queue
 *  listener, its slot) are offset from one another, centred where a lone
 *  line runs, in the order given. Returns each line's offset by key. */
export function projectLineLanes(lines: ProjectLine[]): Map<string, number> {
  const pairs = new Map<string, string[]>()
  for (const l of lines) {
    const pair = [l.agent, l.project].sort().join('\u0000')
    pairs.set(pair, [...(pairs.get(pair) ?? []), l.key])
  }
  const out = new Map<string, number>()
  for (const keys of pairs.values()) keys.forEach((k, i) => out.set(k, (i - (keys.length - 1) / 2) * LANE_GAP))
  return out
}
