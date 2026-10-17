/* EPIC Mode's taps into the org's own data flow.

   App.tsx calls `epic?.frame(...)` for every org-socket frame it parses and
   `epic?.tree(...)` for every org tree it publishes. While EPIC Mode is off
   `epic` is null, so each call site is ONE null check: an optional call never
   evaluates its arguments, nothing is allocated, nothing is listened to, and
   the ordinary app behaves exactly as it did before EPIC Mode existed. The
   director (director.ts, loaded only when EPIC Mode turns on) installs itself
   here and removes itself when it stops. */
import type { TreePayload } from '../types'

export interface EpicTaps {
  /** one org-socket frame, as App.tsx parsed it */
  frame(org: string, frame: unknown): void
  /** an org tree App.tsx just published to the screen */
  tree(org: string, tree: TreePayload): void
  /** a user action that leaves no trace in the tree: an interrupt the
   *  engine accepted (api.ts calls this only once it answers `interrupted`) */
  action(org: string, kind: 'interrupt', node: string): void
  /** a change the engine refused: api.ts's `req` calls this for a failed
   *  non-GET request, on the failure path only (the Astra take: a refused
   *  request never celebrates; it gets its own alarm) */
  refused(path: string, status: number): void
  /** The current org view went away; release state-driven effects. */
  clear?(): void
}

export let epic: EpicTaps | null = null
let latestTree: TreePayload | null = null
export interface EpicWire { key: string; seg: { kind: 'l' | 'c'; pts: readonly { x: number; y: number }[] }; frac?: number }
let canvas: { wires: readonly EpicWire[]; positions: ReadonlyMap<string, { x: number; y: number }> } | null = null
/** Borrow geometry for both SVG and WebGL links. No additional reader. */
export function publishEpicCanvas(wires: readonly EpicWire[], positions: ReadonlyMap<string, { x: number; y: number }>): void {
  canvas = { wires, positions }
}
export function epicCanvasNow() { return canvas }

/** Borrow the App's existing snapshot, without copying it or adding readers. */
export function epicTreeNow(): TreePayload | null { return latestTree }
export function publishEpicTree(tree: TreePayload): void {
  latestTree = tree
  epic?.tree(tree.slug, tree)
}
export function clearEpicTree(): void { latestTree = null; canvas = null; epic?.clear?.() }

export function setEpicTaps(taps: EpicTaps | null): void { epic = taps }
