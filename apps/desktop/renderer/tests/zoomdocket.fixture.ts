import type { TreePayload, WorkItem } from '../src/types'
const asTree = (v: unknown) => v as TreePayload

export function tree(nodeIds: string[]): TreePayload {
  const mk = (id: string) => ({
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  })
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: nodeIds.map(mk), cost_usd_total: 0,
    audit: { live_nodes: nodeIds.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
  })
}

export const mkItem = (o: Partial<WorkItem>): WorkItem => ({
  slug: 'test-work-item',
  rev: 1,
  kind: 'code',
  title: 'Test Work Item',
  objective: 'Test objective',
  status: 'in_progress',
  blocked_reason: null,
  archived: false,
  archived_at: null,
  owner: { node: 'agent1', generation: 1 },
  owner_current: true,
  owner_state: 'live',
  reviewer: null,
  participants: [],
  created_by: { node: 'agent1', generation: 1 },
  at: '2026-09-05T08:00:00.000Z',
  updated_at: '2026-09-05T09:00:00.000Z',
  done_so_far: ['First step completed'],
  working_on_next: ['Second step in progress'],
  docket_at: '2026-09-05T09:00:00.000Z',
  last_updater: { node: 'agent1', generation: 1 },
  manual_attention: null,
  dismissals: [],
  questions: [],
  effective_attention: false,
  attention_sources: [],
  acceptance: [],
  dependencies: [],
  evidence: [],
  delivery: null,
  accepted: null,
  superseded_by: null,
  history: [],
  ...o,
})


export const payload = {
 items: [mkItem({slug:'alpha-task', owner:{node:'alpha',generation:0}}),
         mkItem({slug:'beta-task', owner:{node:'beta',generation:0}})],
 archived:[mkItem({slug:'alpha-archive', owner:{node:'alpha',generation:0},archived:true,status:'done'})],
 backlogged:[], counts:{active:2,archived:1,attention:0},now:'2026-09-07T06:45:00Z'
}
