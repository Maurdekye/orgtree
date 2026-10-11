/** Mail fixtures without attachment jobs still implement the transfer-list
 * contract mounted by InboxView. Specialized transfer suites use their own API. */
export function withoutMailTransfers(fetcher: typeof fetch): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit) =>
    /\/transfers(?:\?|$)/.test(String(url))
      ? Promise.resolve(new Response(JSON.stringify({ transfers: [], next_cursor: null })))
      : fetcher(url, init)) as typeof fetch
}
