import type { WorkItem, WorkItemsPayload } from './types'

const groups = ['items', 'archived', 'backlogged', 'attention'] as const
export interface WorkDelta {
  base: string
  revision: string
  delta: Partial<Record<typeof groups[number], { order: string[]; upsert: WorkItem[] }>>
  counts: WorkItemsPayload['counts']
  now: string
  references?: WorkItemsPayload['references']
}

/** Apply only to the exact base. Keep unchanged row identities and remove rows
 * absent from the new order (including moves between the three groups). */
export function applyWorkDelta(old: WorkItemsPayload | undefined,
  incoming: WorkItemsPayload | WorkDelta): WorkItemsPayload {
  if (!('delta' in incoming)) return incoming
  if (!old || incoming.base !== old.revision) throw new Error('Docket delta base changed')
  const { base: _base, delta, ...metadata } = incoming
  const out = { ...old, ...metadata }
  for (const group of groups) {
    const change = delta[group]
    if (!change) continue
    const rows = new Map((old[group] ?? []).map(row => [row.slug, row]))
    for (const row of change.upsert) rows.set(row.slug, row)
    out[group] = change.order.map(id => {
      const row = rows.get(id)
      if (!row) throw new Error(`Docket delta is missing ${id}`)
      return row
    })
  }
  return out
}
