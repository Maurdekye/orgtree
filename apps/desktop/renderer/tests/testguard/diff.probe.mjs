// frontend/tests/testguard/diff.probe.mjs - testguard.test.tsx's planted
// assertion. NOT a test file (no .test. in the name, so run.mjs never bundles
// it): the suite launches it under tests/joblimit.ps1 to show Node's own
// assertion diff dying at a memory ceiling that the guarded run survives.
//
//   node diff.probe.mjs unguarded <n>            Node's assert, as shipped
//   node diff.probe.mjs guarded <n> <guard.mjs>  testguard.mjs imported first
//
// Both compare two arrays of <n> one-letter strings that differ in EVERY
// element with assert/strict deepEqual. Node prints each array one element per
// line and its Myers diff keeps a (2*lines+1)-int32 copy per edit step: at
// n = 6000 that is ~1.15 GB of ArrayBuffer (~8 * lines^2 bytes). Prints the
// error's name and its first line, and exits 0 if node survived to print it.
import { pathToFileURL } from 'node:url'

const [mode, n, guardPath] = process.argv.slice(2)
if (mode === 'guarded') await import(pathToFileURL(guardPath).href)
const { default: assert } = await import('node:assert/strict')
const actual = Array.from({ length: Number(n) }, () => 'a')
const expected = Array.from({ length: Number(n) }, () => 'b')
const started = Date.now()
try {
  assert.deepEqual(actual, expected)
  console.log('UNEXPECTED PASS')
} catch (err) {
  const bounded = /report bounded by tests\/testguard\.mjs/.test(String(err?.message))
  console.log(`${err?.name}: ${String(err?.message).split('\n')[0].slice(0, 120)}`)
  console.log(`settled in ${Date.now() - started} ms; bounded=${bounded}`)
}
