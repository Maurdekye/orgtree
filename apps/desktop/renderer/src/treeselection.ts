import type { TreeSelection } from './treeview'

export type TreeSelectionPart = Partial<Omit<TreeSelection, 'include'>> & { include?: readonly string[] }
type Entry = { version: number; owners: Map<object, TreeSelectionPart> }

/** Mounted surfaces own their IDs. Removing a surface removes its contribution;
 * visiting history never installs a permanent selection. Versions let App
 * notice a selection that changed while its read was in flight and read once
 * more (the in-flight answer is still one coherent snapshot). */
export class TreeSelections {
  private orgs = new Map<string, Entry>()
  private serial = 0
  private listeners = new Set<(org: string) => void>()

  subscribe(fn: (org: string) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  set(org: string, owner: object, value: TreeSelectionPart): void {
    const old = this.orgs.get(org)
    const part = { ...value, include: [...new Set(value.include ?? [])].sort(),
      ...(value.fronts ? { fronts: { ...value.fronts } } : {}),
      ...(value.browse ? { browse: { ...value.browse } } : {}) }
    if (JSON.stringify(old?.owners.get(owner)) === JSON.stringify(part)) return
    const entry = old ?? { version: 0, owners: new Map<object, TreeSelectionPart>() }
    entry.owners.delete(owner)
    entry.owners.set(owner, part)
    entry.version = ++this.serial
    this.orgs.set(org, entry)
    this.listeners.forEach(fn => fn(org))
  }

  release(org: string, owner: object): void {
    const entry = this.orgs.get(org)
    if (!entry?.owners.delete(owner)) return
    entry.version = ++this.serial
    if (!entry.owners.size) this.orgs.delete(org)
    this.listeners.forEach(fn => fn(org))
  }

  read(org: string, fallback: TreeSelection): { version: number; selection: TreeSelection } {
    const entry = this.orgs.get(org)
    const include = new Set(fallback.include)
    let selection = fallback
    for (const part of entry?.owners.values() ?? []) {
      part.include?.forEach(id => include.add(id))
      selection = { ...selection, ...part, include: [] }
    }
    return { version: entry?.version ?? 0, selection: { ...selection, include: [...include] } }
  }
  version(org: string): number { return this.orgs.get(org)?.version ?? 0 }
}

export const treeSelections = new TreeSelections()
