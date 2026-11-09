import test from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_VERSIONS } from '../src/canvas/shared'

// the head of the list is what a new hire gets (the engine writes 5.2 for a Fable hire that names no version)
test('Fable 5.2 heads the Fable versions; 5.1 and 5 stay selectable', () => {
  assert.deepEqual(MODEL_VERSIONS.fable, ['5.2', '5.1', '5'])
})
