import { useEffect, useState } from 'react'
import { AgentDocketModal } from '../src/canvas/agentdocket'
import { treeSelections } from '../src/treeselection'
import type { TreeNode, TreePayload, WorkItem } from '../src/types'
import { compatibilityWorkFixture } from './workcompat.fixture'

export const noop = () => {}
export const fallback = { include: [] as string[], hideRetired: false, fronts: {} }
export const node = (id: string, extra = {}): TreeNode => ({ id, title: id, tier: 'sol', state: 'live',
  generation: 1, children: [], scope: {}, seat: 1, grant: 0, free: 0, turns: [], ...extra } as TreeNode)
export const item = (slug: string, owner: string, extra = {}): WorkItem => ({ slug, title: slug,
  rev: 1, status: 'open', owner: { node: owner, generation: 1 }, owner_current: true,
  owner_state: 'live', at: '2026-10-20T08:00:00Z', updated_at: '2026-10-20T08:00:00Z',
  kind: 'code', objective: slug, archived: false, manual_attention: null,
  attention_sources: [], effective_attention: false, dependencies: [], evidence: [], acceptance: [], dismissals: [],
  done_so_far: [], working_on_next: [], participants: [], questions: [], history: [], ...extra } as WorkItem)
export function tree(included: string[] = [], project = false, missing = false): TreePayload {
  return { slug: 'membership-test', name: 'Synthetic org', tiers: { sol: 2 }, asks: [],
    roots: [node('lead', { kind: project ? 'project' : 'agent', children: included.filter(id => id !== 'missing-owner').map(id =>
      node(id, { parent: 'lead', state: 'archived' })) })],
    foreground: { catalog_revision: 'catalog-one', present: ['lead', ...included.filter(id => !missing || id !== 'missing-owner')],
      missing: missing ? included.filter(id => id === 'missing-owner') : [] },
  } as unknown as TreePayload
}
export function transport(count = { reads: 0 }, archivedOwner = 'retired-owner') {
  return compatibilityWorkFixture((async (url: RequestInfo | URL) => {
    // Count page requests after the compatibility adapter's route projection,
    // separately from its first-use full reference-catalog read.
    if (String(url).includes('_page=')) ++count.reads
    return new Response(JSON.stringify(String(url).includes('/work-items') ? {
      items: [item('Active team work', 'lead')], archived: [item('Archived repair', archivedOwner, { archived: true, status: 'done' })],
      backlogged: [item('Planned work', 'lead', { status: 'backlogged' })],
      counts: { active: 1, archived: 1, backlogged: 1 },
    } : {}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
}
export function Panel({ tr, slug = 'membership-test', nid = 'lead', team = true }: {
  tr: TreePayload; slug?: string; nid?: string; team?: boolean
}) {
  return <AgentDocketModal slug={slug} nid={nid} tree={tr} toast={noop} close={noop} team={team}
    refs={{ world: { org: slug }, onOpen: noop }} />
}
export function Feedback({ count, project = false, missing = false }: {
  count: { reads: number; renders: number }; project?: boolean; missing?: boolean
}) {
  const [tr, setTree] = useState(() => tree([], project))
  ++count.renders
  useEffect(() => treeSelections.subscribe(org => {
    if (org !== 'membership-test') return
    // Real selected reads include only mounted requests. Bound the broken
    // control so a regression fails with evidence rather than an infinite loop.
    if (++count.reads <= 8) setTree(tree(treeSelections.read(org, fallback).selection.include, project, missing))
  }), [count, project, missing])
  return <Panel tr={tr} />
}
