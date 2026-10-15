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
  /** a user action that leaves no trace in the tree (an interrupt) */
  action(org: string, kind: 'interrupt', node: string): void
}

export let epic: EpicTaps | null = null

export function setEpicTaps(taps: EpicTaps | null): void { epic = taps }
