import type { TreePayload } from './types'
import { preserveRemovedDrafts } from './draftstore'

/** Full legacy trees can prove absence by omission. A selected tree cannot.
 * Presence wins even over inconsistent absence metadata; mismatched orgs
 * prove nothing. This boundary never retains knowledge across snapshots. */
export function treePresence(tree: TreePayload, org: string,
                             visible: Pick<ReadonlyMap<string, unknown>, 'has'>) {
  const present = new Set(tree.foreground?.present)
  const missing = new Set(tree.foreground?.missing)
  const has = (id: string) => tree.slug === org && (visible.has(id) || present.has(id))
  const absent = (id: string) => tree.slug === org && !has(id)
    && (tree.foreground ? missing.has(id) : true)
  return { has, absent, known: (id: string) => has(id) || absent(id) }
}

/** Shared by the canvas's destructive storage sweeps. An omitted archived
 * identity keeps its active draft, attachment/reply context and preferences. */
export function sweepAbsentDrafts(org: string, absent: (id: string) => boolean) {
  preserveRemovedDrafts(org, { has: id => !absent(id) })
  try {
    const prefix = `orgtree-draft-${org}-`
    for (let i = localStorage.length - 1; i >= 0; --i) {
      const key = localStorage.key(i)
      if (key?.startsWith(prefix) && absent(key.slice(prefix.length))) localStorage.removeItem(key)
    }
  } catch { /* browser storage is best effort */ }
}

export function sweepAbsentPreferences(org: string, absent: (id: string) => boolean) {
  try {
    for (const suffix of ['eyemin', 'eyeseen']) {
      const key = `orgtree-${suffix}-${org}`
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const ids = JSON.parse(raw) as string[]
      const keep = ids.filter(id => !absent(id))
      if (keep.length !== ids.length) localStorage.setItem(key, JSON.stringify(keep))
    }
    const key = `orgtree-pile-${org}`
    const raw = localStorage.getItem(key)
    if (raw) {
      const fronts = JSON.parse(raw) as Record<string, string>
      const keep = Object.fromEntries(Object.entries(fronts)
        .filter(([parent, front]) => !absent(parent) && !absent(front)))
      if (Object.keys(keep).length !== Object.keys(fronts).length) localStorage.setItem(key, JSON.stringify(keep))
    }
  } catch { /* private mode or hand-edited storage */ }
}
