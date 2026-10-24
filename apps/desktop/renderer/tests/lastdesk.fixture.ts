import type { TreePayload } from '../src/types'

export function lastDeskTree(slug = 'last-desk'): TreePayload {
  const node = (id: string, parent: string | null, children: unknown[] = [], project = false): unknown => ({
    id, title: id, parent, kind: project ? 'project' : 'agent', tier: project ? 'project' : 'sol',
    model_id: 'sol', state: 'live', seat: project ? 0 : 2, grant: 0, free: 0, ui_order: 0,
    generation: 1, children, lineage: [], turns: [], audiences_held: [], cost_usd: 0,
    mail_pending: 0, frozen: null, occupancy: null, context_window: null,
    scope: { tools: {}, add_dirs: [], org_visibility: 'team', permission_mode: 'default' },
    configured_scope: {},
  })
  return { slug, name: 'Desk navigation', roots: [node('alpha', null),
    node('project', null, [node('child', 'project')], true), node('bravo', null)],
    dirs: [], tiers: { sol: 2 }, default_top_grant: 12, max_top_grant: 100,
    audiences: [], audience_requests: [], credit_requests: [], user_inbox_count: 0,
    default_visibility: 'team', default_tools: {},
  } as unknown as TreePayload
}
