import { eventSummary } from './project'
import type { KnownEvent } from './project'
import type { ScopeFolders, ScopeTools, SettingChange, TextDiff } from '../generated/events'
import { ORGTREE_GROUPS, PERMISSION_OPTIONS, SESSION_OPTIONS, TOOL_LABELS, VIS_OPTIONS } from '../canvas/settinglabels'

// CHANGE NOTICES NAME WHAT CHANGED (USER 2026-10-30 mc5d2672d3cc9 "should show inline what exactly chsnged",
// meeff02af965d "same for all similar update messages"). One table for every change kind: its card draws one line
// right under the header (events/card.tsx), and anything longer than the line (a long list, an instructions diff, a
// reason) folds beneath it. The inbox row and jump labels read the same line (noticeSummary). Settings read in the
// settings dialog's own words (canvas/settinglabels.ts).

/** A piece of a line: words, or an agent the card draws as the surface's agent link. */
export type Bit = { text: string } | { agent: string }
/** What a part's fold holds beneath the line. */
export type Detail = { kind: 'diff'; diff: TextDiff } | { kind: 'list'; items: string[] } | { kind: 'text'; text: string }
export interface ChangePart { key: string; bits: Bit[]; detail?: Detail }

const t = (text: string): Bit => ({ text })
const agent = (name: string): Bit => ({ agent: name.replace(/^@/, '') })
/** the user, the org mailbox, or an agent */
const party = (name: string): Bit => name === '@user' || name === 'user' ? t('the user')
  : name === '@extern' ? t('the org mailbox') : agent(name)
const part = (key: string, ...bits: (Bit | string)[]): ChangePart =>
  ({ key, bits: bits.map(b => typeof b === 'string' ? t(b) : b) })
const signed = (n: number) => n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0'
/** more items than this count on the line and list in the fold */
const INLINE = 3

const MODE: Record<string, string> = { rw: 'read-write', ro: 'read-only' }
const pairLabel = (pairs: readonly (readonly [string, string, ...string[]])[], key: string) => pairs.find(([k]) => k === key)?.[1]
const toolLabel = (name: string): string => {
  if (name === 'orgtree_disabled') return 'Disabled by Orgtree'
  if (name === 'mcp:*') return 'All registered MCP servers'
  if (name.startsWith('mcp:')) return `MCP server ${name.slice(4)}`
  if (name.startsWith('orgtree:')) return pairLabel(ORGTREE_GROUPS, name.slice(8)) ?? `Orgtree ${name.slice(8)} tools`
  return pairLabel(TOOL_LABELS, name) ?? name
}

const VALUE_LABELS: Record<SettingChange['key'], string> = {
  org_visibility: 'Visible agents', permission_mode: 'File access', effort: 'Thinking effort', fast_mode: 'Fast mode',
  model_version: 'Model version', account: 'Account', account_fallback: 'Switch accounts when limited', harness: 'Harness',
  session: 'Desktop session', peer_mail: 'Subordinates may message each other', auto_cheap_compact: 'Start fresh when needed',
}
const valueText = (key: SettingChange['key'], v: string | null): string => {
  if (v === null) return key === 'model_version' ? 'latest' : 'default'
  if (key === 'org_visibility') return pairLabel(VIS_OPTIONS, v) ?? v
  if (key === 'permission_mode') return pairLabel(PERMISSION_OPTIONS, v) ?? v
  if (key === 'session') return pairLabel(SESSION_OPTIONS, v) ?? v
  return v
}

/** a list part: its items on the line when few, else counted on the line and listed in the fold */
function listPart(key: string, label: string, items: string[], counts: [number, string][]): ChangePart | null {
  if (!items.length) return null
  if (items.length <= INLINE) return part(key, `${label}: ${items.join(', ')}`)
  return { ...part(key, `${label}: ${counts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`).join(', ')}`),
    detail: { kind: 'list', items } }
}
function folderPart(f: ScopeFolders): ChangePart | null {
  const items = [...f.added.map(d => `+ ${d.path} (${MODE[d.mode]})`), ...f.removed.map(d => `− ${d.path}`),
    ...f.changed.map(d => `${d.path} ${MODE[d.from]} → ${MODE[d.to]}`)]
  return listPart('folders', 'Folders', items, [[f.added.length, 'added'], [f.removed.length, 'removed'], [f.changed.length, 'changed']])
}
function toolPart(x: ScopeTools): ChangePart | null {
  const items = [...x.added.map(n => `+ ${toolLabel(n)}`), ...x.removed.map(n => `− ${toolLabel(n)}`)]
  return listPart('tools', 'Tools', items, [[x.added.length, 'added'], [x.removed.length, 'removed']])
}
const diffPart = (key: string, label: (Bit | string)[], d: TextDiff): ChangePart =>
  ({ ...part(key, ...label, `: +${d.plus} −${d.minus}`), detail: { kind: 'diff', diff: d } })

type Of<V extends KnownEvent['variant']> = Extract<KnownEvent, { variant: V }>
function scopeParts(e: Of<'access.scope_changed'>): ChangePart[] {
  const parts: ChangePart[] = []
  const add = (p: ChangePart | null) => { if (p) parts.push(p) }
  if (e.folders) add(folderPart(e.folders))
  if (e.tools) add(toolPart(e.tools))
  for (const v of e.values ?? []) {
    const label = VALUE_LABELS[v.key], from = valueText(v.key, v.from), to = valueText(v.key, v.to)
    if (v.key === 'account' && e.pending === 'queued') add(part(v.key, `${label}: ${from} → ${to} when the current turn ends`))
    else if (v.key === 'account' && e.pending === 'cancelled') add(part(v.key, `${label}: change to ${to} cancelled, stays ${from}`))
    else if (v.key === 'account' && e.pending === 'dropped') {
      const dropped = part(v.key, `${label}: change to ${to} dropped, stays ${from}`)
      if (e.reason) dropped.detail = { kind: 'text', text: e.reason }
      add(dropped)
    }
    else add(part(v.key, `${label}: ${from} → ${to}`))
  }
  if (e.charter) add(diffPart('charter', ['Instructions'], e.charter))
  if (e.team_charter) add(diffPart('team_charter', e.cascade_for ? ['Team instructions from ', agent(e.cascade_for)] : ['Team instructions'], e.team_charter))
  if (!parts.length) {
    // an old stored notice recorded only which categories changed
    const word = (c: string) => c === 'charter' ? 'instructions' : c === 'team_charter' ? 'team instructions'
      : c in VALUE_LABELS ? VALUE_LABELS[c as SettingChange['key']].toLowerCase() : c
    return e.changed.length ? [part('changed', `Changed: ${e.changed.map(word).join(', ')}`)] : []
  }
  if (e.cascade_for && parts.some(p => p.key !== 'team_charter')) parts.push(part('via', 'via ', agent(e.cascade_for)))
  return parts
}

function audienceParts(e: Of<'access.audience_changed'>): ChangePart[] {
  const other = e.other ?? ''
  switch (e.outcome) {
    case 'user_audience': return [part('audience', 'Granted: audience with the user')]
    case 'audience_with': return [part('audience', 'Granted: audience with ', party(e.target))]
    case 'audience_from': return [part('audience', 'Granted: ', agent(other), ' may message you')]
    case 'user_audience_seen': return [part('audience', 'Granted: ', agent(other), ' may write to your inbox')]
    case 'org_inbox': return [part('audience', 'Granted: the org mailbox')]
    case 'org_inbox_auto': return [part('audience', 'Granted: the org mailbox (automatically)')]
    case 'org_inbox_released': return [part('audience', 'Released: the org mailbox')]
    case 'declined': return [part('audience', 'Declined: audience with ', party(e.target))]
    case 'rescinded': return [part('audience', 'Rescinded: audience with ', party(e.target)),
      ...(e.other ? [part('route', 'still reachable through project ', agent(e.other))]
        : e.other === '' ? [part('route', 'no project route remains')] : [])]
  }
}

const CREDIT_WORD: Record<Of<'decision.credit'>['outcome'], string> = {
  approved: 'Approved', counter: 'Countered', declined: 'Declined', reduced: 'Reduced', denied: 'Denied' }
/** whose: the agent's own (self) or a named report's */
const whose = (relation: string, node: string, own: string, theirs: string) =>
  relation === 'self' ? [own] : [agent(node), theirs]

/** Every change kind's line, or null for an event that is not a change notice. */
export function changeParts(event: KnownEvent): ChangePart[] | null {
  const e = event
  switch (e.variant) {
    case 'access.scope_changed': return scopeParts(e)
    case 'access.audience_changed': return audienceParts(e)
    case 'decision.audience': return [part('audience', e.granted ? 'Granted' : 'Declined', ': audience with ', party(e.target))]
    case 'access.grant_changed': return [e.relation === 'self'
      ? part('grant', `Grant: ${signed(e.delta)} → ${e.now} (${e.free} free)`)
      : part('grant', agent(e.node), `'s grant: ${signed(e.delta)} → ${e.now}`)]
    case 'decision.credit': return e.granted === null ? [part('credits', `${CREDIT_WORD[e.outcome]}: asked ${e.asked}`)]
      : [part('credits', `${CREDIT_WORD[e.outcome]}: asked ${e.asked}, granted ${e.granted}`), part('total', `${e.old} → ${e.now ?? e.old}`)]
    case 'lifecycle.model_switched': return [part('model', ...whose(e.relation, e.node, 'Model', "'s model"), `: ${e.old} → ${e.new}`),
      ...(e.crossed ? [part('provider', 'new provider session')] : [])]
    case 'lifecycle.switch_queued': return [part('model', `Model: ${e.old} → ${e.new} when the current turn ends`)]
    case 'lifecycle.switch_cancelled': return [part('model', `Model: queued change to ${e.target} cancelled`)]
    case 'lifecycle.switch_dropped': return [part('model', `Model: change to ${e.target} dropped, stays ${e.kept}`)]
    case 'lifecycle.renamed': return [part('name', `Name: ${e.old} → ${e.new}`)]
    case 'lifecycle.moved': {
      const from = e.from_parent ? agent(e.from_parent) : t('the user'), to = e.to_parent ? agent(e.to_parent) : t('the user')
      return [part('reports_to', ...(e.role === 'self' ? ['Reports to: '] : [agent(e.node), ' reports to: ']), from, ' → ', to)]
    }
    case 'lifecycle.hired': return [part('hired', agent(e.node), ' hired under ', e.parent ? agent(e.parent) : t('the user')),
      part('tier', e.tier), part('grant', `grant ${e.grant}`)]
    case 'lifecycle.rehired': return [part('rehired', agent(e.node), ' rehired'), part('grant', `grant ${e.grant}`)]
    case 'lifecycle.retired': return [part('retired', agent(e.node), ' retired'), part('freed', `${e.freed} credits freed`)]
    case 'lifecycle.rescinded': return [part('rescinded', agent(e.node), "'s hire rescinded"), part('clawed', `${e.clawed} credits returned`)]
    case 'lifecycle.dissolved': return [part('dissolved', agent(e.node), "'s team dissolved"), part('nodes', `${e.nodes} agents`),
      part('freed', `${e.freed} credits freed`)]
    case 'lifecycle.deleted': return [part('deleted', agent(e.node), e.extra > 0 ? ` deleted, with ${e.extra} below` : ' deleted')]
    case 'lifecycle.seat_swapped': return [part('seats', 'Seats: ', agent(e.a), ' ⇄ ', agent(e.b))]
    case 'lifecycle.subtree_promoted': return [part('promoted', agent(e.promoted), ' now above ', agent(e.demoted))]
    case 'lifecycle.inserted': return [part('inserted', agent(e.node), ' inserted above ', agent(e.above))]
    case 'lifecycle.compacted': return [part('compacted', ...whose(e.relation, e.node, 'Conversation', "'s conversation"),
      ` compacted ${e.auto ? 'automatically' : 'on request'}`)]
    case 'lifecycle.cheap_compacted': return [part('session', ...whose(e.relation, e.node, 'Fresh session', ' has a fresh session'),
      '; the previous one stays in history')]
    case 'policy.limit_reset': return [part('released', ...whose(e.relation, e.node, 'Released', ' released'), `: ${e.released.join(', ')}`)]
    default: return null
  }
}

/** a line's words, agents as their @names */
export const bitsText = (bits: Bit[]) => bits.map(b => 'agent' in b ? `@${b.agent}` : b.text).join('')
export const partsText = (parts: ChangePart[]) => parts.map(p => bitsText(p.bits)).join(' · ')

/** The change line's words, or null for an event that is not a change notice. */
export function changeText(event: KnownEvent): string | null {
  const parts = changeParts(event)
  return parts?.length ? partsText(parts) : null
}

/** The one line the inbox list row and jump labels show for an event. */
export function noticeSummary(event: KnownEvent): string {
  return changeText(event) ?? eventSummary(event)
}
