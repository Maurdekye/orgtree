import type { HistoryController } from './historycontroller'
import type { HistoryRecorded } from './historyapi'
import type { ToastUndo } from './types'
const controllers = new Map<string, HistoryController>()
export const historyEnabled = (slug: string): boolean => controllers.has(slug)

export function bindHistory(slug: string, controller: HistoryController): () => void {
  controllers.set(slug, controller)
  return () => { if (controllers.get(slug) === controller) controllers.delete(slug) }
}
/** Toasts keep the committed entry identity, including after another action. */
export function historyUndo(slug: string, result: HistoryRecorded): ToastUndo | null {
  const id = result.history_entry?.id
  if (id == null) return null
  void controllers.get(slug)?.refresh()
  return { label: 'Undo', available: () => controllers.get(slug)?.can('undo', id) ?? false,
    fn: () => { void controllers.get(slug)?.run('undo', id) } }
}
