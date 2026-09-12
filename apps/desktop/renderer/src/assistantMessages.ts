import type { ChatMessage } from './types'

export function assistantIds(row: ChatMessage): string[] {
  return [...new Set([row.assistant_id, ...(Array.isArray(row.assistant_ids) ? row.assistant_ids : [])]
    .filter((id): id is string => typeof id === 'string' && !!id))]
}

/** Native rows win over retained snapshots; complete wins over partial;
 * otherwise compare revisions. Arrival order is never freshness evidence. */
function newer(a: ChatMessage, b: ChatMessage): ChatMessage {
  if (!!a.assistant_pending !== !!b.assistant_pending) return a.assistant_pending ? b : a
  if ((a.assistant_state === 'complete') !== (b.assistant_state === 'complete')) {
    return a.assistant_state === 'complete' ? a : b
  }
  const ar = a.assistant_revision ?? 0, br = b.assistant_revision ?? 0
  return ar > br ? a : b
}

/** One row at its first position, with the newest proven snapshot. A native
 * multi-block record absorbs all the partial blocks it contains. */
export function mergeAssistantRows(rows: readonly ChatMessage[]): ChatMessage[] {
  const out: Array<ChatMessage | null> = []
  const positions = new Map<string, number>()
  for (const row of rows) {
    const ids = assistantIds(row)
    if (!ids.length) { out.push(row); continue }
    const hits = [...new Set(ids.map(id => positions.get(id))
      .filter((i): i is number => i !== undefined))].sort((a, b) => a - b)
    const first = hits[0] ?? out.length
    let winner = row
    const aliases = new Set(ids)
    for (const i of hits) {
      const old = out[i]
      if (!old) continue
      winner = newer(old, winner)
      for (const id of assistantIds(old)) aliases.add(id)
      if (i !== first) out[i] = null
    }
    // Associate every alias, including ones claimed by an absorbed group.
    if (hits.length > 1) for (const [id, i] of positions) if (hits.includes(i)) aliases.add(id)
    for (const id of aliases) positions.set(id, first)
    out[first] = winner
  }
  return out.filter((row): row is ChatMessage => row !== null)
}

export function isAssistantSnapshot(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false
  const row = value as ChatMessage
  return row.role === 'assistant' && typeof row.text === 'string'
    && typeof row.assistant_id === 'string' && !!row.assistant_id
    && typeof row.assistant_scope === 'string'
    && Number.isSafeInteger(row.assistant_revision) && (row.assistant_revision ?? 0) > 0
    && (row.assistant_state === 'partial' || row.assistant_state === 'complete')
    && row.assistant_pending === true
}
