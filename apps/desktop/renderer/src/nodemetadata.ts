import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { CacheForecast, TreeNode } from './types'

/** The node-stream wire shape shared by the org receiver and metadata store. */
export type NodeStreamFrame = {
  type: 'node_stream'; rev?: number; event_id?: string; reply_quote?: string;
  node: string; kind: string; text?: string; sticky?: boolean; id?: string;
  assistant_row?: unknown; segments?: unknown; delivery?: unknown;
  count?: number | null; last_turn_count?: number | null; provider?: string;
  source?: string | null; reason?: string | null; emitted_at_ms?: number;
  waiting?: boolean; state?: string | null; forecast?: CacheForecast | null;
}

const fields = ['mcp_tool_count', 'last_turn_mcp_tool_count', 'mcp_tool_count_provider',
  'mcp_tool_count_source', 'mcp_tool_count_reason', 'mcp_readiness_waiting',
  'mcp_readiness_state', 'mcp_readiness_reason', 'cache_forecast'] as const
export type NodeMetadata = Pick<TreeNode, typeof fields[number]>
type Frame = NodeStreamFrame
type Entry = { generation: TreeNode['generation']; value: NodeMetadata }
const orgs = new Map<string, Map<string, Entry>>()
const listeners = new Map<string, Set<() => void>>()
const keyOf = (org: string, id: string) => JSON.stringify([org, id])
const notify = (org: string, id: string) => listeners.get(keyOf(org, id))?.forEach(fn => fn())
const equal = (a: NodeMetadata, b: NodeMetadata) => fields.every(key => Object.is(a[key], b[key]))

/** Shared field rules for tree replay and the live, single-node path. */
export function metadataPatch(node: NodeMetadata, frame: Frame): Partial<NodeMetadata> {
  if (frame.kind === 'cache_forecast') return { cache_forecast: frame.forecast ?? null }
  if (frame.kind === 'mcp_readiness') return {
    mcp_readiness_waiting: Boolean(frame.waiting),
    mcp_readiness_state: frame.state ?? null,
    mcp_readiness_reason: frame.reason ?? null,
  }
  if (frame.kind === 'mcp_tool_count') return {
    mcp_tool_count: typeof frame.count === 'number' ? frame.count : null,
    last_turn_mcp_tool_count: typeof frame.last_turn_count === 'number' ? frame.last_turn_count : null,
    mcp_tool_count_provider: frame.provider ?? node.mcp_tool_count_provider,
    mcp_tool_count_source: frame.source ?? null,
    mcp_tool_count_reason: frame.reason ?? null,
  }
  return {}
}

/** Adopt the base and replay newer buffered frames BEFORE notifying readers.
 * Retain only small metadata snapshots, not nodes, charters or old generations. */
export function replaceNodeMetadata(org: string, roots: TreeNode[], replay: Frame[] = []): void {
  const previous = orgs.get(org)
  const next = new Map<string, Entry>()
  const visit = (node: TreeNode) => {
    const value = Object.fromEntries(fields.map(key => [key, node[key]])) as NodeMetadata
    next.set(node.id, { generation: node.generation, value })
    node.children.forEach(visit)
  }
  roots.forEach(visit)
  for (const frame of replay) {
    const entry = next.get(frame.node)
    if (entry) entry.value = { ...entry.value, ...metadataPatch(entry.value, frame) }
  }
  for (const [id, entry] of next) {
    const old = previous?.get(id)
    if (old && old.generation === entry.generation && equal(old.value, entry.value)) next.set(id, old)
  }
  orgs.set(org, next)
  for (const [id, entry] of next) if (previous?.get(id) !== entry) notify(org, id)
  if (previous) for (const id of previous.keys()) if (!next.has(id)) notify(org, id)
}

export function publishNodeMetadata(org: string, frame: Frame): void {
  const nodes = orgs.get(org)
  const old = nodes?.get(frame.node)
  // Frames for a newly hired node still live in treesync's bounded replay
  // buffer. Adopt them with its first base, without caching unknown identities.
  if (!nodes || !old) return
  const value = { ...old.value, ...metadataPatch(old.value, frame) }
  if (equal(old.value, value)) return
  nodes.set(frame.node, { generation: old.generation, value })
  notify(org, frame.node)
}

export function clearNodeMetadata(org: string): void {
  const previous = orgs.get(org)
  orgs.delete(org)
  if (previous) for (const id of previous.keys()) notify(org, id)
}

/** The desk owns this subscription, so a badge update cannot invalidate the
 * chart's topology, layout or sibling cards. Portals use the same store. */
export function useNodeMetadata<T extends { id: string; generation?: number }>(org: string, node: T): T {
  const subscribe = useCallback((fn: () => void) => {
    const key = keyOf(org, node.id)
    const set = listeners.get(key) ?? new Set<() => void>()
    listeners.set(key, set)
    set.add(fn)
    return () => { set.delete(fn); if (!set.size) listeners.delete(key) }
  }, [org, node.id])
  const snapshot = useCallback(() => orgs.get(org)?.get(node.id), [org, node.id])
  const entry = useSyncExternalStore(subscribe, snapshot, snapshot)
  return useMemo(() => entry && entry.generation === node.generation
    ? { ...node, ...entry.value } : node, [node, entry])
}
