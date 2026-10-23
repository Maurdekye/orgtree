import test from 'node:test'
import assert from 'node:assert/strict'
import { withDraftTree, DRAFT } from '../src/canvas/shared'
import type { CanvasNode, DraftState } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const node = (id: string, extra = {}): CanvasNode => ({
  id, title: id, tier: 'sol', state: 'live', children: [], ...extra,
} as CanvasNode)
const tree = (roots: CanvasNode[]): TreePayload => ({ roots } as unknown as TreePayload)
const preview = withDraftTree as (t: TreePayload, d: DraftState | null, position: string) => CanvasNode

test('centre hire is after the old middle among live direct children', () => {
  const roots = [node('alpha'), node('project', { kind: 'project' }), node('omega')]
  const shown = preview(tree(roots), { parent: null, tier: 'sol' }, 'centre')
  assert.deepEqual(shown.children.map(n => n.id), ['alpha', 'project', DRAFT, 'omega'])
  assert.deepEqual(roots.map(n => n.id), ['alpha', 'project', 'omega'])
})
