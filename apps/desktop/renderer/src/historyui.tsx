import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { getUserHistory, applyUserHistory } from './historyapi'
import { bindHistory } from './historyregistry'
import { HistoryController } from './historycontroller'
import type { HistoryView } from './historycontroller'
import { historyShortcut } from './undokeys'
import { onLiveBump } from './livebus'
import { SurfaceDocumentOwner } from './popout'
import { ConfirmModal } from './canvas/modals'
import type { ToastFn } from './types'

const empty: HistoryView = { history: null, pending: false, confirmation: null }
const emptySnapshot = () => empty
const noSubscribe = () => () => {}

export function useUserHistory(slug: string | null, enabled: boolean, revision: number | undefined,
  toast: ToastFn, changed: () => void): HistoryController | null {
  const callbacks = useRef({ toast, changed }); callbacks.current = { toast, changed }
  const controller = useMemo(() => slug && enabled ? new HistoryController({
    read: () => getUserHistory(slug), apply: (dir, id, token) => applyUserHistory(slug, dir, id, token),
    report: lines => callbacks.current.toast(lines), changed: () => callbacks.current.changed(),
  }) : null, [slug, enabled])
  // The owning App also redraws toast availability when the journal changes.
  useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.getSnapshot ?? emptySnapshot, emptySnapshot)
  useEffect(() => {
    if (!slug || !controller) return
    const unbind = bindHistory(slug, controller)
    void controller.refresh()
    const remove = onLiveBump(() => { void controller.refresh() })
    return () => {
      remove(); controller.dispose()
      unbind()
    }
  }, [slug, controller])
  useEffect(() => { if (controller) void controller.refresh() }, [controller, revision])
  return controller
}

export function HistorySurface({ controller }: { controller: HistoryController | null }) {
  const [owner, setOwner] = useState<Document | null>(null)
  const view = useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.getSnapshot ?? emptySnapshot, emptySnapshot)
  useLayoutEffect(() => {
    const win = owner?.defaultView
    if (!win || !controller) return
    const key = (event: KeyboardEvent) => {
      if (owner.hidden) return
      const direction = historyShortcut(event, owner)
      if (!direction || !controller.can(direction)) return
      event.preventDefault(); void controller.run(direction)
    }
    win.addEventListener('keydown', key)
    return () => win.removeEventListener('keydown', key)
  }, [owner, controller])
  const confirm = view.confirmation
  return <>
    <span hidden ref={el => { if (el) setOwner(el.ownerDocument) }} />
    {owner && controller && confirm && <SurfaceDocumentOwner owner={owner}>
      <ConfirmModal title={`Undo hire of ${confirm.agent}?`}
        body={`${confirm.agent} has started ${confirm.turns} turn${confirm.turns === 1 ? '' : 's'}. Undoing this hire retires the agent; its work and context remain archived.`}
        confirmLabel="Retire hired agent" close={() => controller.cancelConfirmation()}
        onConfirm={() => { void controller.run('undo', confirm.id, confirm.confirm) }} />
    </SurfaceDocumentOwner>}
  </>
}
