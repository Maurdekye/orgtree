/** Legacy HTTP fixture controls model the switched-off engine. Capability
 * probing is answered explicitly, outside their counted legacy requests. */
export const legacyAppBackend = (fetcher: typeof fetch): typeof fetch =>
  (input, init) => String(input) === '/api/app/records'
    ? Promise.resolve(new Response(JSON.stringify({ detail: 'fixture uses the legacy engine' }), { status: 501 }))
    : fetcher(input, init)
