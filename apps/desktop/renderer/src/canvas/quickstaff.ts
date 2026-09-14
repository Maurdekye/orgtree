import { req } from '../api'
import type { MenuItem } from './contextmenu'

export interface QuickStaffPreview {
  mode: 'request' | 'under_assignee' | 'top_level'
  configured_mode: 'request' | 'under_assignee' | 'top_level'
  owner: { node?: string; generation?: number; born?: string }
  fallback: boolean
  disclosure: string
  models: { tier: string; seat: number; efforts: string[]; reason?: string | null }[]
}
export const quickStaffPath = (org: string, item: string) =>
  `/api/orgs/${encodeURIComponent(org)}/work-items/${encodeURIComponent(item)}/quick-staff`

// Shared between every row/surface of one ticket. Keep the same operation id
// on a network retry; a new selection gets its own id. The server also checks
// persisted receipts, so a slow closing menu cannot duplicate a hire.
const operations = new Map<string, { id: string; pending: boolean; completed: boolean }>()
export function quickStaffEntry(org: string, item: string, preview: QuickStaffPreview,
  feedback: (text: string) => void): MenuItem {
  const select = async (tier?: string, effort?: string) => {
    if (preview.mode !== 'request' && !tier) return
    const body = { mode: preview.mode, configured_mode: preview.configured_mode,
      owner: preview.owner, ...(tier ? { tier } : {}), ...(effort ? { effort } : {}) }
    const key = JSON.stringify([org, item, body])
    let op = operations.get(key)
    if (op?.pending || op?.completed) { feedback(op.pending ? 'Staffing is already being submitted.' : 'This staffing action already completed.'); return }
    if (!op) { op = { id: crypto.randomUUID(), pending: false, completed: false }; operations.set(key, op) }
    op.pending = true
    try {
      const result = await req<{ message: string }>(quickStaffPath(org, item), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, request_id: op.id }),
      })
      op.completed = true
      feedback(result.message)
    } catch (e) { feedback(e instanceof Error ? e.message : String(e)) }
    finally { op.pending = false }
  }
  const models: MenuItem[] = preview.models.map(m => ({
    label: m.tier, disabled: !!m.reason, title: m.reason ?? `${m.seat} credits for the seat`,
    onSelect: () => { void select(m.tier) },
    ...(m.efforts.length ? { children: m.efforts.map(e => ({ label: e,
      onSelect: () => { void select(m.tier, e) } })) } : {}),
  }))
  return { label: 'Staff…', title: preview.disclosure, description: preview.disclosure,
    actionDisabled: preview.mode !== 'request', onSelect: () => { void select() },
    children: models.length ? models : [{ label: 'No models available', disabled: true, onSelect: () => {} }],
  }
}
