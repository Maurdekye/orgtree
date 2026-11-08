// main/orgtree-link.ts — orgtree:// links (docs/rust-engine/orgtree-links.md).
//
// Hubchat draws Orgtree's mentions (`@item:org/slug` and its kin) as chips, and
// a chip clicked on this PC opens its target here through one of these links:
// the mirror of the hubchat:// links Orgtree opens for Hubchat (USER 2026-11-08
// mb3e5b66f1e00 "i suggest we mirror it"). A link only NAVIGATES. It never
// carries an action, and it opens nothing in an org this Orgtree does not have
// (main/index.ts, the taskbar router, checks that against the engine).
//
// ⚠ ONE EXACT SHAPE PER KIND, and the path IS the canonical token. Each link is
// rebuilt as `@<kind>:<rest>` and must pass the renderer's own parser
// (packages/contracts/reference-tokens.ts) unchanged, so the link grammar
// cannot drift from the token grammar. Everything a URL could add is refused
// before that: capitals, a query, a fragment, a port, credentials, escapes,
// spaces, quotes. Windows hands the link over as a command-line argument,
// where anything else would be an injection surface.
import { parseRef } from '../../../packages/contracts/reference-tokens'

export const ORGTREE_SCHEME = 'orgtree'

export type OrgtreeLink = { kind: 'org'; org: string } | { kind: 'reference'; org: string; token: string }

const PREFIX = 'orgtree://'
/** Longer than any real token; a bound, not a feature. */
const LINK_MAX = 400
const SHAPE = /^orgtree:\/\/[a-z0-9@/-]+$/
const SEG = /^[a-z0-9-]+$/
const KINDS = new Set(['item', 'doc', 'app', 'panel', 'agent', 'project', 'mail'])

/** Counted case-insensitively so that `ORGTREE://…` is refused rather than
 *  passed over: a command line holding a link names that link's destination. */
export function isOrgtreeLinkArg(arg: string): boolean {
  return typeof arg === 'string' && /^orgtree:/i.test(arg)
}

/** The destination a link names, or null for anything that is not exactly one
 *  of the documented shapes. Never a guess. */
export function orgtreeLink(value: unknown): OrgtreeLink | null {
  if (typeof value !== 'string' || value.length > LINK_MAX || !SHAPE.test(value)) return null
  const [kind, ...rest] = value.slice(PREFIX.length).split('/')
  if (kind === 'org') return rest.length === 1 && SEG.test(rest[0]!) ? { kind: 'org', org: rest[0]! } : null
  if (!kind || !KINDS.has(kind) || rest.length < 2) return null
  const token = `@${kind}:${rest.join('/')}`
  const ref = parseRef(token)
  return ref ? { kind: 'reference', org: ref.org, token } : null
}

export interface ProtocolHost {
  isPackaged: boolean
  /** Electron's `app.getPath('appData')`: the real Roaming known folder. */
  appData: string
  isDefaultProtocolClient(protocol: string): boolean
  setAsDefaultProtocolClient(protocol: string): boolean
}

const sameFolder = (a: string, b: string) =>
  a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

/** Register orgtree:// for this Orgtree, the way Hubchat registers hubchat://
 *  (its src-tauri/src/lib.rs register_scheme): the per-user class, written by
 *  the running app, rewritten only when it points elsewhere, and never by a
 *  build that is not the real install. Here that is development (unpackaged),
 *  a custom data root or profile, and a packaged smoke whose APPDATA is not the
 *  real Roaming folder: each would aim the user's links at a test copy. Windows
 *  only, like Hubchat's. True when it wrote the registration. */
export function registerOrgtreeScheme(host: ProtocolHost, platform: string = process.platform,
  env: Record<string, string | undefined> = process.env): boolean {
  if (platform !== 'win32' || !host.isPackaged) return false
  if (env.ORGTREE_V2_DATA || env.ORGTREE_V2_PROFILE) return false
  if (env.APPDATA && !sameFolder(env.APPDATA, host.appData)) return false
  if (host.isDefaultProtocolClient(ORGTREE_SCHEME)) return false
  return host.setAsDefaultProtocolClient(ORGTREE_SCHEME)
}
