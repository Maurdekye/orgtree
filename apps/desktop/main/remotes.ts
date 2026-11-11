/** Which remote engine an organization window belongs to (docs/rust-engine/remote-org.md).
 *
 *  An organization that runs on a remote standalone engine appears in this
 *  desktop under an ALIAS (its window identity, as a local organization's slug
 *  is). The local engine relays such a window's requests; to do that for the
 *  engine-wide routes and to stamp the window's answers, it must be told which
 *  window is asking. Main says so with `X-Orgtree-Remote` (policy.ts), and
 *  this module is where main learns the alias -> connection map: once before
 *  the first window opens (`readRemotes`), then from the app feed's pushed
 *  value `remotes` whenever it changes. The token of a remote engine never
 *  comes here: the list holds none. */
import { TOKEN_HEADER } from './policy'

type EngineEndpoint = { readonly origin: string; readonly token: string }

/** What a native command that uses this computer's disk or sign-in windows answers to a window
 *  of an organization on a remote engine. The window's own controls say more (the engine's
 *  name, the path there); this is the backstop's sentence. */
export const REMOTE_WINDOW_REFUSAL = 'This organization runs on a remote engine: its files, folders and sign-ins are on that engine’s computer, not on this one.'

/** alias -> remote engine id, from the engine's connection list. Anything
 *  that is not that list gives an empty map. */
export function remoteAliases(list: unknown): Map<string, string> {
  const map = new Map<string, string>()
  if (!Array.isArray(list)) return map
  for (const remote of list as { id?: unknown; orgs?: unknown }[]) {
    if (!remote || typeof remote.id !== 'string' || !remote.id || !Array.isArray(remote.orgs)) continue
    for (const org of remote.orgs as { alias?: unknown }[]) {
      if (org && typeof org.alias === 'string' && org.alias) map.set(org.alias, remote.id)
    }
  }
  return map
}

/** The connection list, bounded. An engine without the route (an older one,
 *  or a standalone one) and any failure answer an empty list: no window is
 *  then treated as remote, which is what such an engine means. */
export async function readRemotes(engine: EngineEndpoint, timeoutMs = 2000): Promise<unknown> {
  try {
    const response = await fetch(new URL('/api/remotes', engine.origin), {
      headers: { [TOKEN_HEADER]: engine.token }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return []
    const body = await response.json() as { remotes?: unknown }
    return Array.isArray(body?.remotes) ? body.remotes : []
  } catch { return [] }
}
