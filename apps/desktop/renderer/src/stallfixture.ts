/* stallfixture.ts - TEST-ONLY hook for the stall tooling's rig proof RP1 (spec ui-stall-tooling-spec section 5): with a fixture
   build (ORGTREE_STALL_FIXTURE=busy at build time) a keydown in the desk composer spins the page for 1500 ms inside a named
   function, so the proof can check that the stall record names the input, the target and that function. A normal build defines
   the flag as '' and the bundler drops all of this; tests/stall-fixture.test.mjs checks both builds. */
declare const __ORGTREE_STALL_FIXTURE__: string | undefined

export function stallFixtureBusy(): void {
  const t = performance.now()
  while (performance.now() - t < 1500) { /* spin */ }
}

export function installStallFixture(doc: Document = document): void {
  if (typeof __ORGTREE_STALL_FIXTURE__ === 'undefined' || __ORGTREE_STALL_FIXTURE__ !== 'busy') return
  doc.addEventListener('keydown', (e) => {
    if ((e.target as Element | null)?.closest?.('[data-stall-id="desk-composer"]')) stallFixtureBusy()
  }, true)
}
