import type { ImportJob } from '../src/canvas/importjob'

/** Existing result-presentation tests use an immediately completed job.
 * Lifecycle/transport-loss tests exercise the job endpoints directly. */
export function terminalImportServer(transport: typeof fetch): typeof fetch {
  let job: ImportJob | null = null
  return async (input, init) => {
    const url = String(input), base = '/api/desktop/import-v1/jobs'
    if (url.startsWith(base) && init?.method !== 'POST')
      return new Response(JSON.stringify({ job }))
    if (url !== base) return transport(input, init)
    const body = JSON.parse(String(init.body))
    const response = await transport(input, init)
    const value = await response.json()
    job = { id: body.request_id, state: response.ok ? 'succeeded' : 'failed', phase: 'finished',
      source_root: body.source_root, organizations: body.organizations, current_org: null,
      files_copied: 0, bytes_copied: 0, started_at: '', updated_at: '',
      result: response.ok ? value : null, error: response.ok ? null : value.detail }
    return new Response(JSON.stringify({ job }), { status: 202 })
  }
}
