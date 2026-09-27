import { useEffect, useMemo, useState } from 'react'
import { getWorkReferences } from '../api'
import type { WorkReference } from '../workreferences'
import { scanRefs, workReferenceCandidates } from './workrefs'
import type { MentionIndex } from './workrefs'
import type { RefWorld } from './reflinks'

/** Closed archive identity is resolved only for the text on this surface.
 * The caller's complete index is unchanged; bounded callers opt in explicitly. */
export function useHistoricalWorkReferences(text: string, world: RefWorld, index?: MentionIndex) {
  const names = useMemo(() => {
    if (!world.boundedItems) return []
    const result = new Set(workReferenceCandidates(text).filter(id => index?.get(id)?.kind !== 'item'))
    for (const run of scanRefs(text)) {
      if (run.ref?.kind === 'item' && run.ref.org === world.org && index?.get(run.ref.id)?.kind !== 'item') {
        result.add(run.ref.id)
      }
    }
    return [...result]
  }, [text, world.boundedItems, world.org, index])
  const key = JSON.stringify([world.org, world.workRevision, names])
  const [settled, setSettled] = useState<{ key: string; rows: Map<string, WorkReference | null> } | null>(null)
  useEffect(() => {
    if (!names.length) return
    let current = true
    getWorkReferences(world.org, world.workRevision ?? '', names).then(rows => {
      if (current) setSettled({ key, rows })
    }).catch(() => {
      // Unavailability is not absence. Leave exact navigation to the target,
      // which surfaces a readable error and can retry on a later request.
      if (current) setSettled({ key, rows: new Map() })
    })
    return () => { current = false }
  }, [key])
  return useMemo(() => {
    if (!world.boundedItems) return { world, index }
    const rows = settled?.key === key ? settled.rows : null
    const resolved = new Map(index)
    const titles = new Map(world.itemTitles)
    for (const [id, row] of rows ?? []) if (row) {
      resolved.set(id, { kind: 'item', slug: id, title: row.title })
      titles.set(id, row.title)
    }
    return { index: resolved, world: { ...world, itemTitles: titles,
      itemOutcome: (id: string) => {
        if (resolved.get(id)?.kind === 'item') return 'ready' as const
        if (!names.includes(id)) return world.itemOutcome?.(id) ?? 'ready'
        if (!rows) return 'pending' as const
        return rows.has(id) ? 'absent' as const : 'ready' as const
      },
    } }
  }, [world, index, settled, key])
}
