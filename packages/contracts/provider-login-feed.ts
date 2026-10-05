/** Native login subscription: listen before the initial copy; late responses
 * cannot overwrite a newer event, including cancel followed by another start. */
import type { DesktopBridge, LoginProvider, ProviderLoginStatus } from './index'

export function subscribeProviderLogin(bridge: Pick<DesktopBridge, 'onEvent' | 'getProviderLoginStatus'>,
  provider: LoginProvider, accept: (status: ProviderLoginStatus) => void) {
  let closed = false, revision = 0
  const receive = (status: ProviderLoginStatus) => { if (!closed) accept(status) }
  const off = bridge.onEvent(event => {
    if (event.type !== 'provider-login-status') return
    const value = event.data as { provider: LoginProvider; status: ProviderLoginStatus }
    if (value.provider !== provider) return
    revision++
    receive(value.status)
  })
  const action = async (pending: Promise<ProviderLoginStatus>) => {
    const before = revision
    const value = await pending
    if (revision === before) receive(value)
    return value
  }
  void action(bridge.getProviderLoginStatus(provider)).catch(() => {})
  return { action, close: () => { closed = true; off() } }
}
