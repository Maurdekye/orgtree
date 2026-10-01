import type { TreeSelection } from '../treeview'
import { restoredWindows, savedDeskIdentities } from '../windowlayout'
import { readPins } from './pins'
import { readModalOpen } from './modalpin'
import { hideRetiredOn, USER } from './shared'

/** Collect before the first selected-tree request, not after rendering an
 * incomplete map: saved windows must have their identities in that request. */
export function savedTreeSelection(org: string): TreeSelection {
  const include = new Set(readPins(org).map(pin => pin.id))
  for (const row of [...restoredWindows(org), ...readModalOpen(org)]) {
    if (row.restore?.agent) include.add(row.restore.agent)
  }
  for (const [, id] of savedDeskIdentities(org)) include.add(id)
  let fronts: Record<string, string> = {}
  try { fronts = retiredFronts(JSON.parse(localStorage.getItem(`orgtree-pile-${org}`) ?? '{}')) }
  catch { /* malformed preferences do not hide the organization */ }
  return { include: [...include], hideRetired: hideRetiredOn(), fronts }
}

export function retiredFronts(saved: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(saved).flatMap(([key, front]) => {
    if (!key.endsWith('|a') || typeof front !== 'string' || !front) return []
    const parent = key.slice(0, -2)
    return [[parent === USER ? '' : parent, front]]
  }))
}
