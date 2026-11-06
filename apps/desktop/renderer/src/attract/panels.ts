/* attract/panels.ts - who owns the shell panels attract mode opens.

   USER 2026-11-03 10:56:41Z m25dcebcbace4 "it seems the panels that attract
   mode opens dont close automatically". The rule (gap-fill Q2 m082646bad468,
   restated with the bug): a panel attract opens closes when the cycle moves
   on; a panel the user had open, opened, or touched is never closed by it;
   when canvas interaction ends the run the screen stays as it is.

   The old code decided "was it open already?" from a ref the shell only
   updates on its next render, so a ticket right after a ticket (hide closes
   the docket, show opens it again in the same tick) saw the docket as still
   open, took it for the user's, and left it up for good. `justClosed` carries
   what was closed in this same tick. */
import type { AttractPanel } from './canvas'
import { attractTrace } from './trace'
import type { ReleaseVia } from './attract'

export type PanelKind = 'inbox' | 'docket'

export interface PanelHost {
  isOpen: (kind: PanelKind) => boolean
  /** open `kind` (or move it) onto this mail / ticket */
  show: (kind: PanelKind, id: string) => void
  close: (kind: PanelKind) => void
}

export interface AttractPanels {
  apply: (panel: AttractPanel, via?: ReleaseVia) => void
  docket: { foreignSince: () => number | null; reclaim: () => void }
}

export function createAttractPanels(host: PanelHost): AttractPanels {
  /** panels attract opened and has not handed over */
  const mine = new Set<PanelKind>()
  /** closed by attract in this tick: the host may not show that yet */
  const justClosed = new Set<PanelKind>()
  /** when the docket first stood open without being attract's (a hand-over, or the user's own) */
  let foreignAt: number | null = null
  return {
    docket: {
      /** since when the docket has been open and NOT attract's (the user's, or one attract lost to a hand-over); null when closed or attract's */
      foreignSince() {
        if (!host.isOpen('docket') || mine.has('docket')) { foreignAt = null; return null }
        return foreignAt ??= Date.now()
      },
      /** take it back and close it (the cycle does this after DOCKET_RECLAIM_MS without user input) */
      reclaim() {
        if (!host.isOpen('docket') || mine.has('docket')) return
        host.close('docket'); justClosed.add('docket'); foreignAt = null
        attractTrace({ ev: 'panel', action: 'close', panel: 'docket', owned: true })
        queueMicrotask(() => justClosed.clear())
      },
    },
    apply(panel, via) {
      if (panel === 'release') {
        if (mine.size) attractTrace({ ev: 'release', via: via ?? 'stop' })
        if (mine.has('docket')) foreignAt = Date.now()
        mine.clear(); return
      }
      if (!panel) {
        for (const kind of mine) { host.close(kind); justClosed.add(kind); attractTrace({ ev: 'panel', action: 'close', panel: kind, owned: true }) }
        mine.clear()
        // gone by the next turn of the event loop, long before the shell could show a user's reopening
        queueMicrotask(() => justClosed.clear())
        return
      }
      const kind = panel.kind
      if (!mine.has(kind) && (justClosed.has(kind) || !host.isOpen(kind))) mine.add(kind)
      justClosed.delete(kind)
      host.show(kind, panel.kind === 'inbox' ? panel.mail : panel.item)
      attractTrace({ ev: 'panel', action: 'open', panel: kind, owned: mine.has(kind) })
    },
  }
}
