// creditdisplay.test.tsx — the credit bar is the production path for the
// grant/alloc/free/seat figures users inspect and drag. Keep these assertions
// on its rendered DOM: testing only fmtCredits would miss a raw interpolation
// reintroduced in the component.

import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CreditBar } from '../src/canvas/cards'
import { fmtCredits } from '../src/canvas/shared'

test('credit formatter preserves credit precision without binary tails', () => {
  assert.deepEqual(
    [0, 0.1, 0.2, 0.1 + 0.2, 1.25, 5].map(fmtCredits),
    ['0', '0.1', '0.2', '0.3', '1.25', '5'],
  )
})

test('CreditBar renders fractional grant, allocation, free and seat values cleanly',
  async () => {
    const grant = 0.1 + 0.2
    const committed = 0.1 + 0.1
    const view = await mountView(
      <CreditBar grant={grant} committed={committed} seat={0.2}
        zoom={1} pxc={10} />,
      (el) => el,
    )
    try {
      const tip = view.el.querySelector('.cbar-tip')
      assert.ok(tip, 'the production credit tip did not render')
      const text = tip!.textContent ?? ''
      assert.match(text, /grant\s*0\.3/, 'grant should display the quantized total')
      assert.match(text, /alloc\s*0\.2/, 'allocation should display the fractional value')
      assert.match(text, /free\s*0\.1/, 'free should display the fractional remainder')
      assert.match(text, /seat\s*0\.2/, 'seat should display the fractional seat')
      assert.doesNotMatch(text, /000000000|999999999/, 'binary floating-point tail leaked into the UI')
    } finally {
      await view.unmount()
    }
  })

test('CreditBar formats counter-offer arithmetic as well as stored values',
  async () => {
    const view = await mountView(
      <CreditBar grant={0.1 + 0.2} committed={0} seat={0.2}
        baseline={0.1} draftMode zoom={1} pxc={10} />,
      (el) => el,
    )
    try {
      const text = view.el.querySelector('.cbar-tip')?.textContent ?? ''
      assert.match(text, /offer\s*0\.3\s*\(\+0\.2\)/,
        'counter-offer delta should not expose binary arithmetic')
      assert.match(text, /now\s*0\.1/, 'counter-offer baseline should remain readable')
    } finally {
      await view.unmount()
    }
  })
