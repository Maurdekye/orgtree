// shell/treeinfo.tsx — the pure readings of one organization's tree, and the
// chip that summarises it.
//
// These were inline in App.tsx, which was fine while App.tsx was the only
// thing that rendered an organization header. The v3 shell splits that header
// into a compact bar and a bottom status strip, both in shell/, and both need
// these — so they live where both can import them rather than in App.tsx,
// which would make a cycle (App.tsx imports the shell).
//
// App.tsx re-exports every name here, so the suites that import them from
// there keep working and the move is invisible to anything but the import
// graph.
import { ALL_TIERS, isOpenRouterTier, TIER_LETTER, tierLabel } from '../canvas/shared'
import type { OrgListEntry, TreeNode, TreePayload } from '../types'

/** the cost chip's hover split: how much of the org total was served by
 *  API-key accounts vs subscriptions. Attribution is now per TURN, from the
 *  serving account's mode (2026-09-12 redesign), rather than from whether a
 *  fallback window happened to be open. '' when no key account has ever
 *  served this org — the tooltip stays quiet rather than showing a
 *  meaningless $0.00 lane. */
const costSplitTitle = (tree: TreePayload): string => {
  const api = tree.api_cost_usd_total ?? 0
  if (!(api > 0)) return ''
  return `subscription $${Math.max(0, tree.cost_usd_total - api).toFixed(2)}`
    + ` · api key $${api.toFixed(2)}`
}
export const costLabel = (tree: Pick<TreePayload, 'cost_usd_total' | 'cost_usd_unknown'>): string =>
  tree.cost_usd_unknown
    ? (tree.cost_usd_total > 0
      ? `$${tree.cost_usd_total.toFixed(2)} estimated/incomplete` : '$?')
    : `$${tree.cost_usd_total.toFixed(2)}`
const costUnknownTitle = (tree: TreePayload): string => tree.cost_usd_unknown
  ? 'recorded numeric estimate; unresolved amounts are not accounted for' : ''
export const showCost = (tree: Pick<TreePayload, 'cost_usd_total' | 'cost_usd_unknown'>): boolean =>
  tree.cost_usd_total > 0 || Boolean(tree.cost_usd_unknown)
export const costTitle = (tree: TreePayload, kiosk = false): string => [
  kiosk ? 'spend / limit' : (costSplitTitle(tree) || 'total spend'),
  kiosk ? costSplitTitle(tree) : '', costUnknownTitle(tree),
].filter(Boolean).join(' — ')

type OrgActivity = Pick<OrgListEntry, 'name' | 'working'> & { slug?: string }

/** a tier's name as the chip's letter stands for it: "Opus" for O */
const tierName = (tier: string): string => isOpenRouterTier(tier)
  ? tierLabel(tier) : tier.charAt(0).toUpperCase() + tier.slice(1)

/** The live agents of one tree, counted the way the chip shows them: `busy`
 *  is a turn running now. The letters are MODEL TIERS, not organizations. */
export function liveCounts(tree: TreePayload) {
  const nodes = [...flatNodes(tree).values()].filter((n) => n.state === 'live')
  const byTier: Record<string, number> = {}
  for (const node of nodes) byTier[node.tier] = (byTier[node.tier] ?? 0) + 1
  // the OpenRouter tiers are runtime-minted, so the inventory takes them
  // from what is actually running rather than from a static list
  const tiers = [...ALL_TIERS, ...Object.keys(byTier).filter(isOpenRouterTier).sort()]
    .filter((tier) => byTier[tier])
  return { live: nodes.length, active: nodes.filter((n) => n.busy).length, byTier, tiers }
}

/** The activity chip's tooltip: what the chip itself says, in words, and the
 *  same numbers (user 2026-09-30: the old tooltip "lies" — it read "active
 *  agents by organization — Orgtree: 4" beside "27 live · 6 active O22 S4 A1",
 *  because it was a different count: supervisor.working_count() for every
 *  organization, polled on its own clock, while the chip's letters are this
 *  organization's live agents by model tier). So the first lines break the
 *  chip down, and other organizations — which the chip does not count — get
 *  a line of their own that says so. `working` is absent from public
 *  listings; an organization without it is simply not listed. */
export const activeOrgTitle = (tree: TreePayload, orgs: OrgActivity[] = []): string => {
  const c = liveCounts(tree)
  const name = tree.name || 'this organization'
  const lines = [
    `${name}: ${c.live} live agent${c.live === 1 ? '' : 's'}`
      + (c.tiers.length ? ` — ${c.tiers.map((t) => `${c.byTier[t]} ${tierName(t)}`).join(' · ')}` : ''),
    `${c.active} active now (a turn running)`,
  ]
  const others = orgs.filter((org) => (org.slug ? org.slug !== tree.slug : org.name !== tree.name)
    && typeof org.working === 'number' && org.working > 0)
  if (others.length) {
    lines.push(`active now in other organizations — ${
      others.map((org) => `${org.name}: ${org.working}`).join(' · ')}`)
  }
  return lines.join('\n')
}

/** The provider-neutral header summary. It deliberately walks ALL_TIERS:
 * this is an inventory of live agents, not a provider picker.
 * ⚠ D-202 DELIBERATELY LEFT THIS ALONE. It looks like a provider surface and
 * is not: `.filter((tier) => byTier[tier])` means a family appears only when
 * an agent is actually running on it, so an absent provider contributes
 * nothing without being asked. Hiding a live Codex agent's own letter because
 * the CLI went missing would make the header lie about what is running —
 * the count is an inventory, and an inventory reports what is there. */
export function ActiveAgentSummary({ tree, orgs = [] }: {
  tree: TreePayload
  orgs?: OrgActivity[]
}) {
  const c = liveCounts(tree)
  const title = activeOrgTitle(tree, orgs)
  return (
    <span className="chip agents"
      role="img" tabIndex={0} aria-label={title} title={title}>
      {c.live} live{c.active > 0 ? ` · ${c.active} active` : ''}
      {c.tiers.map((tier) => (
        <b key={tier} className={'t-' + tier}>
          {TIER_LETTER[tier]}{c.byTier[tier]}
        </b>
      ))}
    </span>
  )
}

export function flatNodes(tree: TreePayload): Map<string, TreeNode> {
  const map = new Map<string, TreeNode>()
  const walk = (n: TreeNode) => { map.set(n.id, n); n.children.forEach(walk) }
  ;(tree.roots ?? []).forEach(walk)   // total: settings fixtures pass partial trees
  return map
}
