import { agent, project } from './projectbunch-fixture'
import type { CanvasNode } from '../src/canvas/shared'

export function workingTree(busy = true): CanvasNode {
  const worker = { ...agent('shader-worker'), busy }
  return project('shader-project', [agent('coordinator', [project('nested-project', [worker])])]) as CanvasNode
}
