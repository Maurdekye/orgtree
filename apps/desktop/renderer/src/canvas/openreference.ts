// canvas/openreference.ts — an orgtree:// link's reference, opened in its org's
// window (docs/rust-engine/orgtree-links.md).
// RED STUB: nothing is accepted or opened yet.
import type { TypedRef } from './workrefs'

export function linkedReference(_data: unknown, _org: string | null): TypedRef | null { return null }

export function useLinkedReference(_org: string | null, _treeOrg: string | null | undefined,
  _open: (ref: TypedRef) => void): void { /* stub */ }
