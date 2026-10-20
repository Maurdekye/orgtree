import type { TreeNode, TreePayload } from '../src/types'

export function agent(id: string, children: TreeNode[] = []): TreeNode {
  return {
    id, title: id, tier: 'sol', model_id: 'sol', kind: 'agent', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children, lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  } as unknown as TreeNode
}
export const project = (id: string, children: TreeNode[] = []): TreeNode =>
  ({ ...agent(id, children), kind: 'project', tier: null, seat: 0,
    scope: { description: `Summary of ${id}`, slots: 3, peer_mail: true } } as unknown as TreeNode)

export function chain(count: number, children = [agent('worker-a'), agent('worker-b')], prefix = 'project'): TreeNode {
  let next = children
  for (let i = count; i > 0; i--) next = [project(`${prefix}-${i}`, next)]
  return next[0]!
}
export function bunchTree(roots: TreeNode[]): TreePayload {
  return {
    slug: 'bunch-fixture', name: 'Project bunches', workspace: null, dirs: [],
    max_top_grant: 1000, default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { sol: 1 }, audiences: [], roots, cost_usd_total: 0,
    audit: { live_nodes: 0, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    auto_resume: false, cascade_hire: false, cascade_alloc: true,
    audience_requests: [], org_inbox: null, net: null, watchdogs: [],
    undo_history: true,
  } as unknown as TreePayload
}
