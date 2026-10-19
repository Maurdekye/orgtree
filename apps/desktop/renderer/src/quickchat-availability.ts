import { isTopLevel, type CanvasNode } from './canvas/shared'
import type { StaffingOptions, StaffingTier } from './canvas/staffingoptions'
import type { TreePayload } from './types'

/** Mirror the user's hire credit cascade, including transparent projects and the top grant cap. */
function fitsCredits(seat: number, tree: TreePayload, nodes: Map<string, CanvasNode>, superior: string | null): boolean {
  const cap = tree.max_top_grant == null ? 1000 : tree.max_top_grant > 0 ? tree.max_top_grant : Infinity
  if (isTopLevel({parent: superior}, nodes)) return (tree.default_top_grant ?? 50) <= cap
  const chain: CanvasNode[] = []
  const seen = new Set<string>()
  let id: string | null = superior
  while (id) {
    if (seen.has(id)) return false
    seen.add(id)
    const node = nodes.get(id)
    if (!node) return false
    chain.push(node)
    id = node.parent ?? null
  }
  let need = seat
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i]!
    if (node.kind === 'project') continue
    const free = node.free ?? 0
    if (free + 1e-9 >= need) return true
    if (tree.cascade_hire === false) return false
    need = Math.ceil(need - free)
    if (chain.slice(i + 1).every(n => n.kind === 'project') && (node.grant ?? 0) + need > cap + 1e-9) return false
  }
  return true
}

export type QuickChatChoice = { row: StaffingTier; account?: string }

/** Use the hire picker's model/account availability, retaining the account that makes a choice runnable. */
export function quickChatChoices(availability: StaffingOptions | null, tree: TreePayload,
  nodes: Map<string, CanvasNode>, superior: string | null): QuickChatChoice[] {
  if (!availability || availability.loading || !Array.isArray(availability.tiers)) return []
  return availability.tiers.flatMap(row => {
    // Startup/error responses and partial rows are not evidence that a model can be hired.
    if (!row || typeof row.tier !== 'string' || !row.tier || !Number.isFinite(row.seat) || row.seat < 0
      || !Array.isArray(row.efforts) || !row.efforts.every(effort => typeof effort === 'string')
      || !Array.isArray(row.accounts) || !row.accounts.every(account => account && typeof account.value === 'string'
        && account.value.length > 0 && (account.efforts === undefined
          || (Array.isArray(account.efforts) && account.efforts.every(effort => typeof effort === 'string'))))) return []
    if (!fitsCredits(row.seat, tree, nodes, superior)) return []
    const native = (row.native_ok ?? row.default_ok) === true
    const configured = row.accounts.find(account => account.value === tree.default_account)
    if (configured) return [{ row, account: configured.value }]
    // With no named default, a runnable native/automatically balanced lane keeps the ordinary hire path.
    if (native && !tree.default_account) return [{ row }]
    const alternative = row.accounts[0]
    if (alternative) return [{ row, account: alternative.value }]
    // Explicit primary prevents an ineligible org default from replacing the eligible native login.
    if (native) return [{ row, ...(row.provider && tree.default_account ? { account: row.provider + '/primary' } : {}) }]
    return []
  })
}
