import assert from 'node:assert/strict'
import { flush, inAct } from './harness'

/** Select a detail-test target without toggling off the org's opening row.
 * Default-selection behavior itself is asserted by docketopen.test.tsx.
 * Tests of a deliberate clear/reopen still click explicitly. */
export async function selectDocketRow(row: Element | null | undefined): Promise<void> {
  assert.ok(row instanceof window.HTMLElement, 'the detail test has a real target row')
  if (!row.classList.contains('on')) await inAct(() => row.click())
  await flush()
  assert.equal(row.classList.contains('on'), true, 'the intended docket row is selected')
}

/** Establish the empty-pane precondition for a navigation test explicitly. */
export async function clearDocketSelection(host: ParentNode): Promise<void> {
  const selected = host.querySelector<HTMLElement>('.docket-row.on')
  if (selected) await inAct(() => selected.click())
  await flush()
  assert.equal(!!host.querySelector('.docket-row.on'), false, 'selection was deliberately cleared')
  assert.equal(!!host.querySelector('.docket-pane-sub'), false, 'no ticket detail remains open')
}
