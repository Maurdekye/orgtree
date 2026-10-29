// canvas/agentharness.tsx — the agent settings Model tab's Harness row. USER
// 2026-10-29 14:25:54Z (m1ff3b8c5b200) asked to change an OpenRouter agent's
// harness after hire; 14:26:39Z (mce51de660ab4) "yes please" to a Harness row
// beside Model and Thinking effort; 14:26:50Z (mc9112ecf0b40) the same for
// language model server seats.
//
// An OpenRouter seat follows its key's harness and a server seat its
// server's, or it keeps one of its own. The engine decides everything shown
// here (GET /nodes/{nid}/harness, `harnesses::seat_row`); the list is the key
// dialog's (HarnessOptions: installed first, the others greyed out and
// disabled), and the hint speaks as the key dialog's does: a change reaches
// the agent at its next turn, on a fresh session that starts with a summary.

import { useEffect, useState } from 'react'
import { getNodeHarness } from '../api'
import type { NodeHarness } from '../types'
import { HarnessOptions, HarnessesLink } from './harnesses'
import { SetRow } from './settingskit'
import { providerOf } from './shared'

/** whether a tier's seats choose a harness at all */
export const choosesHarness = (tier: string): boolean => ['openrouter', 'langserver'].includes(providerOf(tier))

/** the row's engine answer for a seat on `tier` (null while it loads, and for
 *  a tier with no harness choice: nothing is read for a row not shown) */
export function useNodeHarness(slug: string, nid: string, tier: string): NodeHarness | null {
  const [row, setRow] = useState<NodeHarness | null>(null)
  const shown = choosesHarness(tier)
  useEffect(() => {
    setRow(null)
    if (!shown) return
    let live = true
    getNodeHarness(slug, nid, tier).then((r) => { if (live && r && Array.isArray(r.options)) setRow(r) }).catch(() => {})
    return () => { live = false }
  }, [slug, nid, tier, shown])
  return row
}

/** the draft as the save sends it: the chosen harness, or null to follow */
export const harnessOp = (value: string): string | null => value || null

/** `value`: '' follows its key or server, else a harness id */
export function AgentHarnessRow({ row, value, onChange }: {
  row: NodeHarness
  value: string
  onChange: (value: string) => void
}) {
  const whose = row.lane === 'langserver' ? 'server' : 'key'
  const name = (id: string | null | undefined) => row.options.find((o) => o.id === id)?.label ?? (id === row.follow?.id ? row.follow?.label : id) ?? ''
  const followName = row.follow?.label ?? '?'
  // what it runs on after its next turn boundary
  const target = value || row.follow?.id || ''
  const changed = value !== (row.pin ?? '')
  const missing = !!value && !row.options.find((o) => o.id === value)?.installed
  const held = !!row.moves
  const by = `its ${whose}${row.follow?.name ? ` (${row.follow.name})` : ''}`
  const hint = held
    ? `Choose its harness after saving the model change: the new model starts on its ${whose}'s harness.`
    : changed
      ? target !== row.current
        ? `It moves to ${name(target)} at its next turn, on a fresh session that starts with a summary.`
        : value
          ? `It stays on ${name(target)} and keeps it when ${by} changes harness.`
          : `It stays on ${name(target)} and follows ${by} from now on.`
      : (value ? `Its own choice: it keeps it when ${by} changes harness.` : `Follows ${by}.`)
        + (row.current && target && row.current !== target ? ` It moves to ${name(target)} at its next turn.` : ' A change reaches it at its next turn.')
  return <>
    <SetRow label="Harness" hint={hint}>
      <select aria-label="Agent harness" value={held ? '' : value}
        disabled={held || !row.options.some((o) => o.available)}
        onChange={(e) => onChange(e.target.value)}>
        <option value="">{`Follow ${whose} (${followName})`}</option>
        <HarnessOptions choices={row.options.map((o) => ({ id: o.id, label: o.label, installed: o.installed,
          enabled: o.available, note: o.installed && !o.available ? 'unavailable' : undefined,
          title: o.installed && !o.available ? o.why : undefined }))} />
      </select>
    </SetRow>
    {missing && !held && <div className="ask-warn-inline">
      {name(value)} is not installed on this computer: this agent refuses to start until it is installed or another
      harness is chosen.</div>}
    <HarnessesLink />
  </>
}
