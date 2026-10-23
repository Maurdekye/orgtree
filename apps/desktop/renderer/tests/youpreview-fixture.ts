import type { Event, Segment } from '../src/generated/events'

const actor = { kind: 'user', id: '@user' } as const
export const requestText = 'Please check the release checklist.'
export const mailRow = (ev: Event, id: string) => ({
  id, from: '@user', kind: 'message', notice: ev.variant === 'lifecycle.hired',
  at: '2026-10-23T12:00:00Z', body: 'Recorded mail body', ev,
})
export const requestEvent = (body = requestText): Event => ({
  v: 1, variant: 'ordinary.message', actor, object: null, engine_authored: false, body,
})
export const hiredRows = Array.from({ length: 4 }, (_, i) => mailRow({
  v: 1, variant: 'lifecycle.hired', actor, engine_authored: false,
  object: { kind: 'node', org: 'preview-fixture', id: `worker-${i}`, name: `worker-${i}`, generation: 1 },
  node: `worker-${i}`, by: '@user', relation: 'report', tier: 'sol', grant: 0, parent: 'qa-lead', why: null,
}, `hire-${i}`))
export const requestSegments: Segment[] = [{ kind: 'mail', rows: [mailRow(requestEvent(), 'request-1')] }]
export const hireSegments: Segment[] = [{ kind: 'mail', rows: hiredRows }]
