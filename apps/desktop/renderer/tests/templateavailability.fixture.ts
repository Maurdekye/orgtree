import type { TemplatePlan, TemplateSummary } from '../src/api'

export const presetSummaries = (checking = false): TemplateSummary[] => [
  { id: 'missing', name: 'devteam (Antigravity)', description: 'An unavailable team.', source: 'folder', path: '/fixture/01-missing.json',
    problems: [], agents: [{ name: 'coordinator', tier: 'argon', depth: 0, parent: null }, { name: 'worker', tier: 'argon', depth: 1, parent: 'coordinator' }],
    availability: { unusable: !checking, checking, reason: checking ? null : 'needs Antigravity' } },
  { id: 'ready', name: 'devteam (Claude)', description: 'A ready team.', source: 'folder', path: '/fixture/02-ready.json',
    problems: [], agents: [{ name: 'coordinator', tier: 'opus', depth: 0, parent: null }],
    availability: { unusable: false, checking, reason: null } },
  { id: 'partial', name: 'mixed team', description: 'One model can run.', source: 'folder', path: '/fixture/03-partial.json',
    problems: [], agents: [{ name: 'coordinator', tier: 'opus', depth: 0, parent: null }, { name: 'worker', tier: 'argon', depth: 1, parent: 'coordinator' }],
    availability: { unusable: false, checking, reason: null } },
]

export function presetPlan(id: string, overrides: Record<string, { tier?: string; name?: string }> = {}, loading = false): TemplatePlan {
  const summary = presetSummaries().find(t => t.id === id)!
  const agents = summary.agents.map(a => {
    const tier = overrides[a.name]?.tier ?? (a.tier === 'opus' ? 'opus' : null)
    return { slot: a.name, name: overrides[a.name]?.name ?? a.name, parent: a.parent, depth: a.depth,
      requested_tier: a.tier, tier, note: tier ? null : 'Antigravity is not signed in or turned off',
      account: tier ? 'primary' : null, provider: tier ? 'claude' : null,
      seat: tier ? 4 : 0, grant: 0, charter: 'none', team_charter: null, kickoff: false, blocked: !tier, dirs_dropped: [] }
  })
  const blocked = agents.filter(a => a.blocked).map(a => a.name)
  return { id, name: summary.name, agents, blocked, ok: !blocked.length, top_grant: 0, org_md: false,
    offered: [{ tier: 'opus', seat: 4, provider: 'claude' }], loading,
    unusable_here: !loading && agents.length > 0 && agents.every(a => !a.tier) }
}
