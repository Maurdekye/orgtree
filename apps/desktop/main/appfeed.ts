/** Authenticated app socket in Electron's Node process. The shared controller
 * owns ordering/reconnect; this adapter supplies only transport and live credentials. */
import { AppFeedConnection } from '../../../packages/contracts/app-feed-connection'
import type { AppSnapshot } from '../../../packages/contracts/app-feed'
import { TOKEN_HEADER } from './policy'

type EngineEndpoint = { readonly origin: string; readonly token: string }
type NativeSocket = new (url: string, options: { headers: Record<string, string> }) => WebSocket

export function nativeAppFeed(engine: EngineEndpoint, changed: () => void) {
  const endpoint = (route: string) => {
    const url = new URL(engine.origin)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
        || url.username || url.password) throw new Error('Invalid local engine origin')
    return new URL(route, url)
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
