// quickchat.ts — Quick chat's memory and its pure rules (docket
// `quick-prompt-hire-kick-off-and-focus-an-agent-fr`).
//
// Quick chat is the text box in the header (or the footer — its position is a
// Display setting, below): type, press Enter, and a new agent is
// hired, kicked off with the message and focused. Its three buttons — model,
// effort, superior — FOLLOW THE USER'S LAST MANUAL CHOICES (user 2026-10-01):
//   model    = the model of the last hire made by hand;
//   superior = the agent last hired under (per organization);
//   effort   = the last effort level selected by hand.
// The hire sheet, the canvas draft card and the desk's effort control kept no
// memory of their own, so this module is that memory and they report into it
// (`rememberHire`, `rememberEffort`). Model and effort are app-wide; the
// superior is per organization, because an agent name means nothing in
// another one.
//
// Defaults with no history (user rulings 2026-10-01 and 2026-10-09 22:34Z):
//   effort   = the ORG default effort — stored as '' ("no level of its own"),
//              so the hire sends no effort and the agent follows the org's;
//   superior = top level, no superior (shown as "top level");
//   model    = Opus, then Sol, then Flash, else any offered model.
// The quick-hired agent's NAME comes from the message's words only (no model
// in it), and it gets NO charter (both user 2026-10-09 22:34Z). Those two
// rules live in `quickChatName` and `quickChatHire` so they are one-line
// swaps if the rulings change.

import { useSyncExternalStore } from 'react'
import { EFFORT_LEVELS } from './canvas/effort'

/** null = top level: no superior. */
export type QuickSuperior = string | null

export interface QuickChatMemory {
  tier?: string
  /** '' = the org default effort, chosen deliberately */
  effort?: string
  /** per organization; absent = no history there */
  superior?: QuickSuperior
}

const GLOBAL_KEY = 'orgtree-quickchat-last'
const orgKey = (org: string) => `orgtree-quickchat-last-superior:${org}`
const listeners = new Set<() => void>()

function readJson(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key)
    const v = raw ? JSON.parse(raw) : null
    return v && typeof v === 'object' ? v as Record<string, unknown> : {}
  } catch { return {} }
}
function writeJson(key: string, v: Record<string, unknown>) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* private mode */ }
  for (const fn of listeners) fn()
}

export function readQuickChat(org: string): QuickChatMemory {
  const g = readJson(GLOBAL_KEY)
  const o = readJson(orgKey(org))
  const out: QuickChatMemory = {}
  if (typeof g.tier === 'string' && g.tier) out.tier = g.tier
  if (typeof g.effort === 'string') out.effort = g.effort
  if ('superior' in o && (o.superior === null || typeof o.superior === 'string'))
    out.superior = o.superior as QuickSuperior
  return out
}

/** a hire the user made by hand: its model, its superior, and the effort it
 *  was given when one was picked (undefined = the hire picked none). */
export function rememberHire(org: string, h: { tier: string; superior: QuickSuperior;
  effort?: string }) {
  const g = readJson(GLOBAL_KEY)
  writeJson(GLOBAL_KEY, { ...g, tier: h.tier,
    ...(h.effort !== undefined ? { effort: h.effort } : {}) })
  writeJson(orgKey(org), { superior: h.superior })
}
export function rememberTier(tier: string) {
  writeJson(GLOBAL_KEY, { ...readJson(GLOBAL_KEY), tier })
}
export function rememberEffort(effort: string) {
  writeJson(GLOBAL_KEY, { ...readJson(GLOBAL_KEY), effort })
}
export function rememberSuperior(org: string, superior: QuickSuperior) {
  writeJson(orgKey(org), { superior })
}
export function onQuickChatMemory(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** the model preference with no history (user 2026-10-01) */
export const QUICK_MODEL_PREFERENCE = ['opus', 'sol', 'flash']

/** the model Quick chat shows: the remembered one while it is still offered,
 *  else Opus → Sol → Flash → the first offered model. '' when nothing is. */
export function quickChatTier(remembered: string | undefined, offered: string[]): string {
  if (remembered && offered.includes(remembered)) return remembered
  return QUICK_MODEL_PREFERENCE.find(t => offered.includes(t)) ?? offered[0] ?? ''
}

/** the effort Quick chat shows: a remembered supported level, else '' (the
 *  org default). */
export function quickChatEffort(remembered: string | undefined): string {
  return remembered && EFFORT_LEVELS.includes(remembered) ? remembered : ''
}

/** the superior Quick chat shows: the remembered agent while it is live,
 *  else top level. */
export function quickChatSuperior(remembered: QuickSuperior | undefined,
  live: (name: string) => boolean): QuickSuperior {
  return remembered && live(remembered) ? remembered : null
}

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'for', 'in', 'on',
  'at', 'by', 'with', 'from', 'into', 'about', 'please', 'pls', 'can', 'could',
  'would', 'you', 'your', 'i', 'me', 'my', 'we', 'our', 'us', 'is', 'are', 'be',
  'it', 'its', 'this', 'that', 'these', 'those', 'do', 'does', 'some', 'hey',
  'hi', 'hello', 'just', 'let', 'lets', 'so', 'then', 'there', 'here', 'what',
  'how', 'why', 'need', 'want', 'go', 'get'])
const RESERVED = new Set(['user', 'system', 'engine', 'org', 'net'])
const MAX_WORDS = 3
const MAX_LEN = 30

/** the lowercase ascii words of a text's first line */
function lineWords(text: string): string[] {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? ''
  return firstLine.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean)
}

/** THE NAME RULE (user 2026-10-09 22:34Z): from the message's words only, no
 *  model in it. Up to three meaningful words of the first line, lowercase,
 *  joined by '-', at most 30 characters; `taken` makes it unique with a
 *  numeric suffix. Always a name the engine's `valid_name` accepts.
 *  A COLON ENDS THE NAME (user 2026-10-10): with a colon in the message the
 *  words come from the text before the first one ("release notes: summarise
 *  them" → release-notes); with no meaningful word before it (nothing, or only
 *  filler like "please:"), the rule above applies to the whole message. The message itself is always sent whole. */
export function quickChatName(message: string, taken: (name: string) => boolean): string {
  const colon = message.indexOf(':')
  const head = colon >= 0 ? lineWords(message.slice(0, colon)) : []
  const words = head.some(w => !STOP.has(w)) ? head : lineWords(message)
  const meaningful = words.filter(w => !STOP.has(w))
  const pick = (meaningful.length ? meaningful : words).slice(0, MAX_WORDS)
  let base = ''
  for (const w of pick) {
    const next = base ? `${base}-${w}` : w
    if (next.length > MAX_LEN) break
    base = next
  }
  if (!base) base = (pick[0] ?? '').slice(0, MAX_LEN)
  if (!base) base = 'chat'
  if (RESERVED.has(base)) base = `${base}-chat`
  if (!taken(base)) return base
  for (let i = 2; ; i++) {
    const suffix = `-${i}`
    const cand = base.slice(0, MAX_LEN - suffix.length).replace(/-+$/, '') + suffix
    if (!taken(cand)) return cand
  }
}

/** the hire op Quick chat sends: the kickoff rides the hire, so hiring and
 *  starting are one engine transaction. NO CHARTER (user 2026-10-09).
 *  THE USER WHO STARTED IT CAN BE ANSWERED (user 2026-10-10): an agent with a
 *  superior gets a user audience in the same transaction, before its first
 *  turn; a top-level agent already writes to the user. */
export function quickChatHire(c: { message: string; name: string; tier: string;
  effort: string; superior: QuickSuperior; grant: number }) {
  return {
    op: 'hire', name: c.name, tier: c.tier, parent: c.superior, grant: c.grant,
    ...(c.effort ? { effort: c.effort } : {}),
    ...(c.superior !== null ? { audiences: ['user'] } : {}),
    kickoff: c.message, kickoff_kind: 'message',
  }
}

/* WHERE QUICK CHAT SITS (user 2026-10-10 19:23Z: "make the position of quick
   chat (top, bottom, none) a display option in app wide settings"; 19:24Z:
   "make it the top by default"). App-wide, in App settings › Display; kept in
   localStorage like the other display choices, so it survives restarts and
   reaches every open window at once (a `storage` event in the others).
     top    — the window header, centred (the default; also when never set);
     bottom — the footer status strip, centred the same way;
     none   — hidden everywhere (the Attention view then has no new-chat box). */
export type QuickChatPosition = 'top' | 'bottom' | 'none'
export const QUICK_CHAT_POSITION_KEY = 'orgtree-quickchat-position'
export function quickChatPosition(): QuickChatPosition {
  try {
    const v = localStorage.getItem(QUICK_CHAT_POSITION_KEY)
    return v === 'bottom' || v === 'none' ? v : 'top'
  } catch { return 'top' }
}
const positionSubs = new Set<() => void>()
export function setQuickChatPosition(v: QuickChatPosition): void {
  try { localStorage.setItem(QUICK_CHAT_POSITION_KEY, v) } catch { /* private mode */ }
  for (const fn of [...positionSubs]) fn()
}
function subscribePosition(fn: () => void): () => void {
  positionSubs.add(fn)
  window.addEventListener('storage', fn)
  return () => { positionSubs.delete(fn); window.removeEventListener('storage', fn) }
}
export const useQuickChatPosition = (): QuickChatPosition =>
  useSyncExternalStore(subscribePosition, quickChatPosition)
