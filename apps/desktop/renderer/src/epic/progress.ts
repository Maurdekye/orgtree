/* EPIC Mode — progression (docket
   epic-mode-next-round-more-shake-and-blur-a-small, part 3: "more progressive
   idle game mechanics, things that build up over time with more momentum and
   have recursive effects on each other"; plan approved 2026-10-15):

   • MOMENTUM — every staged event adds its weight times the current
     multiplier, so a busy spell snowballs. It halves every
     MOMENTUM_HALF_LIFE_S, and the multiplier grows with it, log-bounded at
     MULTIPLIER_MAX. The director scales the show by it: more particles
     (within the stage's caps), residue that lingers longer (within
     LINGER_MAX_S), harder shakes and blurs (within the comfort bounds) and
     the little sounds' climb.
   • CHARGE — an agent's own events charge it (halving every
     CHARGE_HALF_LIFE_S), and its effects grow with its charge. Two charged
     agents meeting (a zap) combine their charges.
   • LEVEL — the session's total activity unlocks the extras one at a time
     (UNLOCKS); the event that reaches one announces it.
   • CHAINS — the event that lifts momentum over a tier (TIERS) makes what
     lingers flare once.

   Plain numbers and timestamps, and no timer: a value decays when it is read,
   at the next event or in a frame already running, so a quiet organization
   costs nothing. The state lives in this module for the app session: it
   survives EPIC Mode turning off and on and starts fresh when the app
   restarts. Whether to keep it across restarts is the user's call (asked
   2026-10-15); keeping it would mean saving and loading `state` here and
   nowhere else. */

export const MOMENTUM_HALF_LIFE_S = 45
/** momentum stops growing here, so a long busy spell cools in minutes */
export const MOMENTUM_MAX = 150
export const MULTIPLIER_MAX = 3
/** the momentum that doubles the multiplier (×2 at 10, ×3 at 30) */
const MULTIPLIER_SCALE = 10
export const TIERS = [10, 30, 60, 100] as const
export const CHARGE_HALF_LIFE_S = 60
export const CHARGE_MAX = 12

export type Extra = 'embers' | 'afterimages' | 'echoes' | 'aurora'
export interface Unlock { at: number; extra: Extra; label: string }
/** in the approved plan's order: embers, word afterimages, echo rings, the aurora */
export const UNLOCKS: readonly Unlock[] = [
  { at: 25, extra: 'embers', label: 'EMBERS' },
  { at: 75, extra: 'afterimages', label: 'AFTERIMAGES' },
  { at: 200, extra: 'echoes', label: 'ECHO RINGS' },
  { at: 500, extra: 'aurora', label: 'AURORA' },
]
/** the momentum the aurora shows from, once unlocked */
export const AURORA_FROM = 60

/** what one event earned */
export interface Gain {
  /** how much more the show gives for it (1 to MULTIPLIER_MAX): the
   *  multiplier it met, raised by its agent's charge */
  lift: number
  /** the tier it lifted momentum over, or 0 */
  tier: number
  /** the extra it unlocked, if any */
  unlock: Unlock | null
}

interface State {
  momentum: number
  /** when momentum was last written (performance.now, ms) */
  at: number
  total: number
  charges: Map<string, { v: number; at: number }>
}

const state: State = { momentum: 0, at: 0, total: 0, charges: new Map() }

const decay = (v: number, at: number, now: number, halfLife: number): number =>
  v * 2 ** (-Math.max(0, now - at) / 1000 / halfLife)

/** momentum now */
export function momentum(now: number): number {
  return decay(state.momentum, state.at, now, MOMENTUM_HALF_LIFE_S)
}

export function multiplierOf(m: number): number {
  return Math.min(MULTIPLIER_MAX, 1 + Math.log2(1 + Math.max(0, m) / MULTIPLIER_SCALE))
}

/** the multiplier now */
export function multiplier(now: number): number {
  return multiplierOf(momentum(now))
}

/** how many tiers a momentum is over */
export function tierOf(m: number): number {
  return TIERS.filter(t => m >= t).length
}

/** an agent's charge now (`agent`: its org and name) */
export function charge(agent: string, now: number): number {
  const c = state.charges.get(agent)
  return c ? decay(c.v, c.at, now, CHARGE_HALF_LIFE_S) : 0
}

/** the session's total activity: every event's weight */
export function total(): number {
  return state.total
}

/** the extras unlocked so far, in the order they unlocked */
export function unlocked(): Extra[] {
  return UNLOCKS.filter(u => state.total >= u.at).map(u => u.extra)
}

/** One event of `weight` at `now`, belonging to `agent` (its org and name)
 *  and, for a two-ended one that brings two agents together, `other`. */
export function feed(weight: number, now: number, agent?: string, other?: string): Gain {
  const before = momentum(now)
  const mult = multiplierOf(before)
  const after = Math.min(MOMENTUM_MAX, before + weight * mult)
  state.momentum = after
  state.at = now
  const was = state.total
  state.total += weight
  const unlock = UNLOCKS.find(u => was < u.at && state.total >= u.at) ?? null
  let lift = mult
  if (agent) {
    let mine = Math.min(CHARGE_MAX, charge(agent, now) + weight)
    if (other && other !== agent) {
      // two charged agents meeting combine their charges
      mine = Math.min(CHARGE_MAX, mine + charge(other, now))
      state.charges.set(other, { v: mine, at: now })
    }
    state.charges.set(agent, { v: mine, at: now })
    lift = Math.min(MULTIPLIER_MAX, mult * (1 + mine / (CHARGE_MAX * 2)))
    if (state.charges.size > 256) {
      for (const [k, c] of state.charges) if (decay(c.v, c.at, now, CHARGE_HALF_LIFE_S) < 0.05) state.charges.delete(k)
    }
  }
  const crossed = tierOf(after) > tierOf(before) ? TIERS[tierOf(after) - 1]! : 0
  return { lift, tier: crossed, unlock }
}

/** forget it all, as a restarted app does */
export function reset(): void {
  state.momentum = 0
  state.at = 0
  state.total = 0
  state.charges.clear()
}
