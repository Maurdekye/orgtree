import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SoundHeatmap } from '../src/epic/heatmap'
import type { HeatField } from '../src/epic/heatfield'
import { clearEpicTree, publishEpicCanvas } from '../src/epic/tap'
import './epicmode-fakes'

test('drag, zoom and camera animation cannot regrid heat when card virtualization changes', () => {
  const host = document.createElement('div')
  host.className = 'viewport'
  host.innerHTML = '<div class="space" style="width:4096px;height:4096px;transform:translate(0px,0px) scale(1)"><div data-first-use-agent="source" style="transform:translate(200px,200px);width:124px;height:124px"></div></div>'
  document.body.append(host)
  const space = host.firstElementChild as HTMLElement
  const layout = new Map([['source', { x: 200, y: 200 }], ['negative', { x: -900, y: -600 }]])
  publishEpicCanvas([], layout, () => ({ w: 124, h: 124 }))
  const heat = new SoundHeatmap(document)
  const state = heat as unknown as { layout(): void; field: HeatField }
  try {
    state.layout()
    const initial = state.field, canvas = space.querySelector<HTMLCanvasElement>('.epic-heatmap')!
    initial.impulse({ x: 262, y: 262 })
    const values = initial.values.slice(), bounds = canvas.style.cssText
    const edge = document.createElement('div')
    edge.dataset.firstUseAgent = 'negative'
    edge.style.cssText = 'transform:translate(-900px,-600px);width:124px;height:124px'
    for (let frame = 0; frame < 12; frame++) {
      // Camera movement virtualizes cards; it never changes the complete layout.
      space.style.transform = `translate(${frame * 17}px,${frame * -9}px) scale(${1 - frame * 0.035})`
      if (frame % 2 === 0) space.append(edge); else edge.remove()
      state.layout()
      assert.equal(state.field === initial, true, 'camera-only motion must not resample world temperatures')
      assert.deepEqual(state.field.values, values, 'heat stays in exactly the same physical cells between simulation ticks')
      assert.equal(canvas.style.cssText, bounds, 'the shared ancestor alone applies camera movement')
      assert.equal(canvas.parentElement === space, true)
    }
  } finally { heat.stop(); host.remove(); clearEpicTree() }
})
