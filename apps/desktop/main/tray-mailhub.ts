import type { MenuItemConstructorOptions } from 'electron'
import type { MailhubStats } from './engine'

/** The full hub serves its read-only UI at / on HUB_PORT, without a token.
 * Network mode binds 0.0.0.0; the local browser always uses loopback. */
function hubUrl(hub: MailhubStats | undefined): string | null {
  if (!hub?.running || !hub.healthy || hub.error || !Number.isInteger(hub.port)
    || hub.port < 1 || hub.port > 65535) return null
  return `http://127.0.0.1:${hub.port}/`
}

export function mailhubTrayItem(
  current: () => MailhubStats | undefined,
  openExternal: (url: string) => Promise<void>,
  failed: (error: unknown) => Promise<void>,
): MenuItemConstructorOptions {
  const hub = current()
  const label = !hub ? 'Mail hub: status unavailable'
    : hub.error ? 'Mail hub: not running - see App settings > Mail hub'
      : hub.running && hub.healthy
        ? `Mail hub: running - port ${hub.port}${hub.exposed ? ' (network)' : ''}`
        : hub.running ? `Mail hub: starting on port ${hub.port}...`
          : 'Mail hub: stopped'
  return {
    id: 'mailhub-status', label, enabled: hubUrl(hub) !== null,
    click: async () => {
      // A menu can remain open across a status poll, port change or shutdown.
      const url = hubUrl(current())
      if (!url) return
      try { await openExternal(url) } catch (error) { await failed(error) }
    },
  }
}
