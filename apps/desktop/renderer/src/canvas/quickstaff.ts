import { req } from '../api'
import type { MenuItem } from './contextmenu'
import type { StaffingAccount } from './staffingoptions'

export interface QuickStaffModel {
  tier: string
  seat: number
  efforts: string[]
  /** ELIGIBLE accounts only; empty for a lane that has no account at all. */
  accounts?: StaffingAccount[]
  /** may the tier be taken without naming an account. */
  default_ok?: boolean
  /** ⚠ LEGACY. The backend no longer sends unstaffable models at all, so this
   *  is always null on a current engine. Kept only so an older engine's payload
   *  still types; nothing renders a disabled row from it any more. */
  reason?: string | null
}
export interface QuickStaffPreview {
  mode: 'request' | 'under_assignee' | 'top_level'
  configured_mode: 'request' | 'under_assignee' | 'top_level'
  owner: { node?: string; generation?: number; born?: string }
  fallback: boolean
  disclosure: string
  models: QuickStaffModel[]
  /** how fresh the availability behind `models` is, and whether finding out
   *  failed. Absent from an older engine. */
  availability?: { at: number; stale: boolean; errors: string[] }
}
export const quickStaffPath = (org: string, item: string) =>
  `/api/orgs/${encodeURIComponent(org)}/work-items/${encodeURIComponent(item)}/quick-staff`

const accountLabel = (a: StaffingAccount): string =>
  a.email ? `${a.id} · ${a.email}` : a.id

// Shared between every row/surface of one ticket. Keep the same operation id
// on a network retry; a new selection gets its own id. The server also checks
// persisted receipts, so a slow closing menu cannot duplicate a hire.
const operations = new Map<string, { id: string; pending: boolean; completed: boolean }>()
export function quickStaffEntry(org: string, item: string, preview: QuickStaffPreview,
  feedback: (text: string) => void): MenuItem {
  const select = async (tier?: string, effort?: string, account?: string) => {
    if (preview.mode !== 'request' && !tier) return
    const body = { mode: preview.mode, configured_mode: preview.configured_mode,
      owner: preview.owner, ...(tier ? { tier } : {}), ...(effort ? { effort } : {}),
      ...(account ? { account } : {}) }
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
  const efforts = (m: QuickStaffModel, account?: string): MenuItem[] =>
    m.efforts.map(e => ({ label: e, onSelect: () => { void select(m.tier, e, account) } }))
  // ⚠ NO DISABLED ROWS (user ruling 2026-09-15). The old menu rendered every
  // tier in the organization and greyed out the ones that could not be staffed
  // — the list in image-118.png. A disabled row is still an offer, so the
  // backend omits them and there is nothing here to grey out.
  const models: MenuItem[] = preview.models.map(m => {
    const accounts = m.accounts ?? []
    // tier ▸ ACCOUNT ▸ effort. An account layer appears only where there is a
    // real choice to make: one eligible account that the tier row would take
    // anyway is not a choice, and an OpenRouter lane has no account at all.
    const children: MenuItem[] = accounts.length && !(accounts.length === 1 && m.default_ok !== false)
      ? accounts.map(a => ({
          label: accountLabel(a),
          title: `staff on ${a.value}`,
          onSelect: () => { void select(m.tier, undefined, a.value) },
          ...(m.efforts.length ? { children: efforts(m, a.value) } : {}),
        }))
      : efforts(m)
    return {
      label: m.tier,
      title: `${m.seat} credits for the seat`,
      // The tier itself is selectable only when the account a plain hire would
      // pick can actually run it. When it cannot, the tier is still OFFERED —
      // one of its accounts can run it — but the choice of which account is the
      // user's balancing rule to make, not this menu's to guess.
      actionDisabled: m.default_ok === false,
      onSelect: () => { void select(m.tier) },
      ...(children.length ? { children } : {}),
    }
  })
  const trouble = preview.availability?.errors ?? []
  const empty: MenuItem[] = [{
    // "could not find out" and "there is nothing" are different answers and
    // must not look alike — the first one is retryable and says so.
    label: trouble.length ? 'Staffing options could not be loaded' : 'No models available',
    title: trouble.join('; ') || 'nothing signed in can run a model in this organization right now',
    description: trouble.join('; ') || undefined,
    disabled: true, onSelect: () => {},
  }]
  return { label: 'Staff…', title: preview.disclosure, description: preview.disclosure,
    actionDisabled: preview.mode !== 'request', onSelect: () => { void select() },
    children: models.length ? models : empty,
  }
}
