import type { AskInfo } from '../src/types'

export const elicitationFixture = (id = 'elicitation-synthetic'): AskInfo => ({
  id, node: 'synthetic-agent', kind: 'elicitation', status: 'open', at: '2026-10-19T14:00:00Z',
  question: 'Allow the synthetic browser to open this page?',
  elicitation: { server: 'Synthetic Browser', mode: 'form', expires_at: '2026-10-19T14:05:00Z',
    message: 'Allow the synthetic browser to open this page?',
    schema: { type: 'object', required: ['allow'], properties: {
      allow: { type: 'boolean', title: 'Allow this action', default: false },
      visits: { type: 'integer', title: 'Number of visits', default: 2, minimum: 1, maximum: 3 },
      policy: { type: 'string', title: 'Permission', default: 'once', oneOf: [{ const: 'once', title: 'This request' }, { const: 'deny', title: 'Do not allow' }] },
      pages: { type: 'array', title: 'Pages', default: ['home'], items: { type: 'string', enum: ['home', 'help'] } },
    } } },
})
