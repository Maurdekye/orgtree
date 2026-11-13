import type { HistoryAnswer, HistoryConfirm, UserHistory } from './historyapi'
import type { HistoryDirection } from './undokeys'
import { otherName } from './people'

export interface HistoryIO {
  read: () => Promise<UserHistory>
  apply: (direction: HistoryDirection, id: number, confirm?: string) => Promise<HistoryAnswer>
  report: (lines: string[]) => void
  changed: () => void
  /** this window's own origin in the organization's records (people.tsx); absent: nothing is anyone else's */
  own?: () => string | null
}
/** Someone else's action that is about to be undone or redone: asked first, by name. */
export interface HistoryOther { direction: HistoryDirection; id: number; label: string; name: string }
export interface HistoryView { history: UserHistory | null; pending: boolean; confirmation: HistoryConfirm | null; other: HistoryOther | null }

/** Per-org controller shared by mirrored presentations. The engine guards
 *  separately launched windows; this guards concurrent controls in this realm. */
export class HistoryController {
  private value: HistoryView = { history: null, pending: false, confirmation: null, other: null }
  private listeners = new Set<() => void>()
  private epoch = 0
  private alive = true
  private refreshPending = false
  constructor(private io: HistoryIO) {}
  getSnapshot = (): HistoryView => this.value
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  private set(next: Partial<HistoryView>) {
    this.value = { ...this.value, ...next }
    for (const fn of [...this.listeners]) fn()
  }
  dispose() { this.alive = false; this.epoch++; this.listeners.clear() }
  /** Effect setup may follow StrictMode's simulated cleanup on the same
   * controller. Old requests retain their obsolete epoch. */
  activate() {
    if (this.alive) return
    this.alive = true; this.epoch++; this.refreshPending = false
    this.set({ pending: false, confirmation: null, other: null })
  }
  async refresh(): Promise<void> {
    if (!this.alive) return
    if (this.value.pending) { this.refreshPending = true; return }
    const epoch = ++this.epoch
    try {
      const history = await this.io.read()
      if (this.alive && epoch === this.epoch) this.set({ history })
    } catch (error) {
      if (this.alive && epoch === this.epoch) this.io.report([`Undo history: ${(error as Error).message}`])
    }
  }
  can(direction: HistoryDirection, id?: number): boolean {
    const target = this.value.history?.[direction]
    return this.alive && !this.value.pending && !this.value.confirmation && !this.value.other && !!target && (id == null || id === target.id)
  }
  cancelConfirmation() { this.set({ confirmation: null }) }
  cancelOther() { this.set({ other: null }) }
  /** The user said yes: undo or redo the other person's action. */
  confirmOther(): Promise<void> {
    const o = this.value.other
    return o ? this.run(o.direction, o.id, undefined, true) : Promise.resolve()
  }
  confirm(): Promise<void> {
    const c = this.value.confirmation
    return c ? this.run('undo', c.id, c.confirm) : Promise.resolve()
  }
  async run(direction: HistoryDirection, id?: number, confirm?: string, asked = false): Promise<void> {
    if (!this.alive || this.value.pending) return
    if (this.value.confirmation && !confirm) return
    if (this.value.other && !asked) return
    const target = this.value.history?.[direction]
    if (id == null && !target) return
    const entryId = id ?? target!.id
    // Someone else's action is asked about first, by name. What the engine itself asks (a hire whose
    // agent has worked) comes after it.
    if (!asked && !confirm && this.io.own) {
      const entry = this.value.history?.entries.find(e => e.id === entryId)
      const name = otherName(entry?.via, this.io.own())
      if (entry && name) { this.set({ other: { direction, id: entryId, label: entry.label, name } }); return }
    }
    const epoch = ++this.epoch
    this.set({ pending: true, confirmation: null, other: null })
    try {
      const answer = await this.io.apply(direction, entryId, confirm)
      if (!this.alive || epoch !== this.epoch) return
      this.set({ history: answer.history })
      if ('code' in answer) {
        this.io.report([answer.code === 'history_conflict'
          ? `Could not ${direction} ${answer.label ?? 'that action'}: ${answer.reason ?? 'the agent changed'}. The next shortcut reaches the next entry.`
          : answer.code === 'history_moved' ? 'Undo history changed in another window or after a new action. Try again.'
            : `Nothing left to ${direction}.`])
      } else if (answer.status === 'confirm') this.set({ confirmation: answer })
      else { this.io.report([`${direction === 'undo' ? 'Undid' : 'Redid'}: ${answer.label}`]); this.io.changed() }
    } catch (error) {
      if (this.alive && epoch === this.epoch) this.io.report([`Could not ${direction}: ${(error as Error).message}`])
    } finally {
      if (this.alive && epoch === this.epoch) {
        this.set({ pending: false })
        if (this.refreshPending) { this.refreshPending = false; await this.refresh() }
      }
    }
  }
}
