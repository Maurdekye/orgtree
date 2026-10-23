import type { TreePayload } from '../src/types'
export const orgDndTree = {
  slug: 'org-dnd-fixture', name: 'Example org', nodes: [], edges: [],
  max_top_grant: 1000, default_top_grant: 20, compact_at: 0.8,
  dirs: [], default_tools: {}, auto_cheap_compact: { enabled: true, occ: 0.25 },
  org_inbox: { enabled: true, mode: 'dnd', entries: [], unread: 2,
    holders: ['coordinator'], multi_holder_enabled: false, visible: true },
  net: null,
} as unknown as TreePayload
export const orgDndResponse = (url: string) => url.includes('/orgmd') ? { content: '', rev: 'fixture' }
  : url.includes('/net') ? { hubs: [], identity: null } : { warnings: [], servers: [], accounts: [] }
