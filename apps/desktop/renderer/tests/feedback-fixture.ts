// Synthetic settings service used by DOM tests and the Electron capture.
export function feedbackService(initial: boolean | undefined = undefined) {
  let enabled = initial
  let fail = false
  const writes: unknown[] = []
  const payload = () => ({ warming_enabled: true, working_checkups_enabled: true,
    suggest_agent_feedback_enabled: enabled })
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (path === '/api/app-settings/runtime') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        writes.push(body)
        if (fail) return new Response(JSON.stringify({ detail: 'Synthetic save refused' }), { status: 500 })
        if ('suggest_agent_feedback_enabled' in body) enabled = body.suggest_agent_feedback_enabled
      }
      return new Response(JSON.stringify(payload()), { status: 200 })
    }
    if (path === '/api/providers') return new Response(JSON.stringify({ providers: [] }))
    if (path === '/api/accounts') return new Response(JSON.stringify({ accounts: [], primary: {}, keys: [], assignments: {} }))
    // Runtime's other independent groups receive synthetic empty data.
    return new Response(JSON.stringify({}), { status: 200 })
  }) as typeof fetch
  return { writes, refuse: (value: boolean) => { fail = value } }
}
