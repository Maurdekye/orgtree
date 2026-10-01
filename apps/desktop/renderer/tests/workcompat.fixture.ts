/** Existing UI suites model the legacy full-list fixture. Keep that contract
 * explicit: new routes request whole-reader compatibility instead of treating
 * an old mock body as a valid foreground page. Native paging has its own tests. */
export function compatibilityWorkFixture(fetcher: typeof fetch): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit) => {
    if (/\/work-items-foreground(?:\?|$)|\/work-item-references(?:\?|$)/.test(String(url))) {
      return Promise.resolve({ status: 409, ok: false, headers: new Headers(),
        json: async () => ({ kind: 'compatibility' }) } as Response)
    }
    return fetcher(url, init)
  }) as typeof fetch
}
