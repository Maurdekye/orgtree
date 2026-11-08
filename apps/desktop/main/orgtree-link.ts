// main/orgtree-link.ts — orgtree:// links (docs/rust-engine/orgtree-links.md).
// RED STUB: the shapes exist so the tests can name them; nothing is accepted yet.

export const ORGTREE_SCHEME = 'orgtree'

export type OrgtreeLink = { kind: 'org'; org: string } | { kind: 'reference'; org: string; token: string }

export function isOrgtreeLinkArg(_arg: string): boolean { return false }

export function orgtreeLink(_value: string): OrgtreeLink | null { return null }

export interface ProtocolHost {
  isPackaged: boolean
  appData: string
  isDefaultProtocolClient(protocol: string): boolean
  setAsDefaultProtocolClient(protocol: string): boolean
}

export function registerOrgtreeScheme(_host: ProtocolHost, _platform: string = process.platform,
  _env: Record<string, string | undefined> = process.env): boolean { return false }
