import assert from 'node:assert/strict'

/** jsdom has no layout. Model a target 600px below a 200px viewport's top;
 * its 40px height makes the centered transcript scrollTop exactly 520px. */
export function observeTranscriptCenter(list: HTMLElement, target: HTMLElement, centered: () => void) {
  let top = 0
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 200 },
    offsetHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 1400 },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => {
      top = value
      if (value === 520) centered()
    } },
  })
  const rect = (y: number, height: number): DOMRect => ({
    top: y, bottom: y + height, height, left: 0, right: 400, width: 400,
    x: 0, y, toJSON: () => ({}),
  })
  list.getBoundingClientRect = () => rect(40, 200)
  target.getBoundingClientRect = () => rect(640 - top, 40)
  target.scrollIntoView = () => assert.fail('reply centering must stay inside the transcript')
}
