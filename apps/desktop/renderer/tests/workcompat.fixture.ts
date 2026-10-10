/** Existing UI suites model the legacy full-list fixture. Keep that contract
 * explicit: new routes request whole-reader compatibility instead of treating
 * an old mock body as a valid foreground page. Native paging has its own tests. */
export function compatibilityWorkFixture(fetcher: typeof fetch, opts: { pages?: boolean } = {}): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit) => {
    if (/\/work-items-foreground(?:\?|$)|\/work-item-references(?:\?|$)/.test(String(url))) {
      return Promise.resolve({ status: 409, ok: false, headers: new Headers(),
        json: async () => ({ kind: 'compatibility' }) } as Response)
    }
    // the docket reads through the paged route (2ac256a); a legacy full-list mock answers it as ONE complete page
    const text = String(url)
    if (opts.pages !== false && /\/work-items-page\?/.test(text)) {
      const u = new URL(text, 'http://localhost')
      const group = (u.searchParams.get('group') ?? 'items') as 'items' | 'archived' | 'backlogged'
      const legacy = text.replace('/work-items-page?', '/work-items?archived=1&backlogged=1&_page=')
      return Promise.resolve(fetcher(legacy, init)).then(async (r) => {
        const body = await r.json() as { items?: unknown[]; archived?: unknown[]; backlogged?: unknown[]; counts?: Record<string, number>; now?: string }
        // the page route filters on the server: a legacy full list is cut here the same way (agent = the owner)
        const agent = u.searchParams.get('agent')
        // (an agent is ANSWERABLE for the items it owns and the ones it reviews)
        const rows = ((body[group] ?? []) as { owner?: { node?: string }; reviewer?: { node?: string } | string | null }[])
          .filter((r) => !agent || r.owner?.node === agent
            || (typeof r.reviewer === 'string' ? r.reviewer : r.reviewer?.node) === agent) as unknown[]
        // …and a query is a case-insensitive match on the row's slug, title and description
        const query = (u.searchParams.get('query') ?? '').toLowerCase()
        const matching = query ? (rows as Record<string, unknown>[])
          .filter((r) => JSON.stringify([r.slug, r.title, r.objective, r.done_so_far, r.working_on_next,
            r.blocked_reason, (r.manual_attention as { reason?: string } | null)?.reason]).toLowerCase().includes(query)) : rows
        const size = (g: 'items' | 'archived' | 'backlogged') => (body[g] ?? []).length
        const totals = { items: size('items'), archived: size('archived'), backlogged: size('backlogged') }
        const page = { format: 'orgtree.work-page/v1', group, rows: matching, total: matching.length, totals, matched: totals,
          counts: body.counts, next_offset: null, revision: 'compat', at: body.now ?? '2026-09-05T10:00:00.000Z' }
        return { ok: true, status: 200, headers: r.headers, json: async () => page } as unknown as Response
      })
    }
    return fetcher(url, init)
  }) as typeof fetch
}
