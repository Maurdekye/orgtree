/** Authenticated app socket in Electron's Node process. The shared controller
 * owns ordering/reconnect; this adapter supplies only transport and live credentials. */
import { AppFeedConnection } from '../../../packages/contracts/app-feed-connection'
import type { AppSnapshot } from '../../../packages/contracts/app-feed'
import { TOKEN_HEADER } from './policy'

type EngineEndpoint = { readonly origin: string; readonly token: string }
type NativeSocket = new (url: string, options: { headers: Record<string, string> }) => WebSocket

function localEndpoint(origin: string, route: string): URL {
  const url = new URL(origin)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password) throw new Error('Invalid local engine origin')
  return new URL(route,url)
}

/** A bounded, authenticated on-change read; no image bytes enter app feed frames. */
export async function taskbarPicture(engine: EngineEndpoint, slug: string): Promise<unknown> {
  const response = await fetch(localEndpoint(engine.origin,`/api/orgs/${encodeURIComponent(slug)}/profile-picture`), {
    headers: { [TOKEN_HEADER]: engine.token }, redirect: 'error', signal: AbortSignal.timeout(10000),
  })
  if (!response.ok || !response.body) throw new Error('Organization logo unavailable')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.length
      if (length > 384 * 1024) { await reader.cancel(); throw new Error('Organization logo exceeds limit') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')).picture
}

export function nativeAppFeed(engine: EngineEndpoint, changed: () => void) {
  const endpoint = (route: string) => {
    return localEndpoint(engine.origin,route)
  }
  return new AppFeedConnection({
    async copy(): Promise<AppSnapshot> {
      const response = await fetch(endpoint('/api/app/records'), {
        headers: { [TOKEN_HEADER]: engine.token }, redirect: 'error', signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw Object.assign(new Error(`App feed unavailable (${response.status})`), { status: response.status })
      return await response.json() as AppSnapshot
    },
    socket(receive, closed) {
      const url = endpoint('/api/app/ws'); url.protocol = 'ws:'
      // Node's WebSocketInit supports headers; the DOM constructor's type does
      // not. This runs only in main, never in the renderer/browser bundle.
      const Socket = globalThis.WebSocket as unknown as NativeSocket
      const socket = new Socket(url.href, { headers: { [TOKEN_HEADER]: engine.token } })
      socket.onmessage = event => receive(String(event.data))
      socket.onclose = closed
      socket.onerror = () => socket.close()
      return socket
    },
    changed,
  })
}
