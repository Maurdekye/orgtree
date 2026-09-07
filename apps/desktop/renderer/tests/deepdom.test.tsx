// deepdom.test.tsx — deep equality on jsdom elements is a TRAP, and this file
// is the standing proof of it plus the guard that keeps it out of the suite.
//
// Found by `memory-leak` (2026-08-28, measured) while investigating something
// else, and confirmed here independently:
//
//     assert.deepStrictEqual(<p>one</p>, <p>two</p>)   // PASSES. no throw.
//     assert.deepEqual(<p>one</p>, <p>two</p>)         // PASSES.
//     assert.deepStrictEqual(<span>A</span>, <div>Z</div>)  // throws
//     assert.strictEqual(<p>one</p>, <p>two</p>)            // throws
//
// WHY: `Object.keys(element)` on a jsdom element is `[]`. Every accessor —
// textContent, className, children, tagName — lives on the PROTOTYPE, and
// deep-equality only walks OWN enumerable properties. So two same-tag elements
// present as two identical empty objects however different their content.
// Different TAGS throw only because the prototypes differ (HTMLDivElement vs
// HTMLSpanElement), which is why a spot check looks like it works and why this
// survives review: the one case a reviewer tries is the one case that throws.
//
// ⚠ WHY THIS MATTERS MORE HERE THAN ELSEWHERE. This repo proves its tests by
// MUTATION (D-158) — break the source, require the suite to go red. A leg
// asserting deep equality of two same-tag elements can never go red, so the
// mutation harness would report the mutation CAUGHT while nothing was checked:
// a false green inside the instrument used to certify every other green.
//
// §1-§4 pin the behaviour so that if node or jsdom ever changes it, this file
// says so out loud instead of the suite quietly gaining power nobody planned.
// §5 is the GUARD: it fails if any suite in this directory deep-compares
// something that looks like a DOM node.
//
// Run:  cd frontend && node tests/run.mjs deepdom

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

declare const __SRC_DIR__: string
const TESTS = path.join(__SRC_DIR__, '..', 'tests')

const el = (tag: string, text: string) => {
  const e = document.createElement(tag)
  e.textContent = text
  return e
}

/** did it throw? — the whole file is about assertions that DON'T */
const threw = (f: () => void): boolean => {
  try { f(); return false } catch { return true }
}

test('§1 deep equality CANNOT distinguish two same-tag elements', () => {
  const a = el('p', 'one')
  const b = el('p', 'two')
  // the headline. These pass, and that is the defect.
  assert.equal(threw(() => assert.deepStrictEqual(a, b)), false,
    'deepStrictEqual on two <p> with different text does not throw')
  assert.equal(threw(() => assert.deepEqual(a, b)), false,
    'deepEqual likewise')
  // …and the reason, asserted directly rather than assumed
  assert.deepEqual(Object.keys(a), [],
    'a jsdom element has NO own enumerable properties — that is the cause')
  assert.notEqual(a.textContent, b.textContent,
    'anti-vacuity: the two elements really do differ where it counts')
})

test('§2 …even when the difference is enormous', () => {
  const a = el('div', 'A')
  const b = el('div', 'Z')
  b.setAttribute('class', 'completely different')
  b.appendChild(el('span', 'and a child'))
  assert.equal(threw(() => assert.deepStrictEqual(a, b)), false,
    'attributes and children are invisible to deep equality too')
  assert.notEqual(a.outerHTML, b.outerHTML,
    'anti-vacuity: outerHTML shows how different they actually are')
})

test('§3 DIFFERENT tags DO throw — which is why the trap survives review', () => {
  // the spot check a reviewer would try, and the reason it reassures wrongly
  assert.equal(threw(() => assert.deepStrictEqual(el('span', 'A'), el('div', 'Z'))), true,
    'different prototypes throw, so a casual check looks like it works')
})

test('§4 the working alternatives all DO throw', () => {
  const a = el('p', 'one')
  const b = el('p', 'two')
  assert.equal(threw(() => assert.strictEqual(a, b)), true, 'identity throws')
  assert.equal(threw(() => assert.ok(a === b)), true, 'a === b throws')
  assert.equal(threw(() => assert.equal(a.textContent, b.textContent)), true,
    'textContent throws')
  assert.equal(threw(() => assert.equal(a.outerHTML, b.outerHTML)), true,
    'outerHTML throws')
})

// ==================================================================== §5
// THE GUARD. A source-level check, deliberately: the runtime probe that
// measured this suite found zero such calls, but "zero today" is not a rule.
// This fails the moment someone writes one.
// ⚠ ONE COPY OF THE PATTERN, used by the guard AND by the guard's own
// anti-vacuity check. They started as two copies and immediately drifted —
// §5 was tightened, §5b was not, and §5b went on certifying a pattern that
// was no longer the one running. Two copies of a rule that must agree is the
// same defect this whole file is about, one level up.
const SUSPECT = /assert\.(?:not)?deep(?:Strict)?Equal\(\s*([^,]*)/g
// the shapes that read as DOM: a query result or a child list, NOT passed
// through anything that extracts a value from it. `.map(x => x.textContent)`
// yields strings and IS the correct form, so the pattern must not flag it.
//
// ⚠ AN EARLIER VERSION ALSO FLAGGED `\bel\b\s*[,)]`, meaning to catch a bare
// element operand. It instead matched the ARGUMENT of any helper call —
// `names(el)`, `times(el)`, `cam(el)` — and reported six violations that were
// nothing of the kind (those helpers return arrays of textContent, the very
// fix this guard exists to encourage). The runtime probe said zero and the
// runtime probe was right. A guard that cries wolf gets deleted by the third
// person who trips over it, so it stays narrow deliberately.
//
// ⚠ WHAT THIS GUARD CANNOT SEE, stated so nobody mistakes it for complete: a
// bare variable — `assert.deepEqual(row, other)` where `row` was assigned an
// element earlier. Whether an operand is a DOM node is a RUNTIME fact and no
// regex settles it. `tests/deepdom_probe.mjs` is the exhaustive instrument;
// this is the cheap one that runs on every commit.
const DOMISH = /querySelector(?:All)?\(|\.children\b|\.firstElementChild\b|\.lastElementChild\b|\.parentElement\b|getElementsB/
const SAFE = /\.textContent|\.outerHTML|\.innerHTML|\.className|\.id\b|\.map\(|\.length\b|\.tagName|\.nodeName|\.getAttribute|\.filter\(/

/** THE predicate — does this source text deep-compare something DOM-shaped? */
const flagsViolation = (src: string): boolean =>
  [...src.matchAll(SUSPECT)]
    .some((m) => DOMISH.test(m[1] ?? '') && !SAFE.test(m[1] ?? ''))

test('§5 no suite in this directory deep-compares a DOM node', () => {
  const offenders: string[] = []
  const files = readdirSync(TESTS).filter((f) => /\.tsx?$/.test(f) && f !== 'deepdom.test.tsx')
  assert.ok(files.length > 5, `fixture: found ${files.length} suites to scan`)

  for (const f of files) {
    const src = readFileSync(path.join(TESTS, f), 'utf8')
    for (const m of src.matchAll(SUSPECT)) {
      const operand = m[1] ?? ''
      if (DOMISH.test(operand) && !SAFE.test(operand)) {
        const line = src.slice(0, m.index).split('\n').length
        offenders.push(`${f}:${line}  ${operand.trim().slice(0, 70)}`)
      }
    }
  }
  assert.deepEqual(offenders, [],
    'deep equality on a DOM node can NEVER fail (see §1) — compare identity, '
    + 'textContent or outerHTML instead:\n  ' + offenders.join('\n  '))
})

// ⚠ §5's own anti-vacuity: the pattern must actually MATCH something when a
// violation exists, or "no offenders" would mean "the regex is broken". This
// runs the same predicate over a synthetic line that IS a violation.
test('§5b the guard can actually see a violation', () => {
  // ⚠ this calls the SAME `flagsViolation` §5 runs. It used to hold its own
  // copy of the three regexes, which is how it kept passing while certifying
  // a pattern §5 no longer used.
  assert.equal(flagsViolation("assert.deepEqual(row.querySelector('.l2'), other)"),
    true, 'the guard flags a real violation')
  assert.equal(flagsViolation("assert.deepStrictEqual(a.parentElement, b.parentElement)"),
    true, 'and the parentElement shape the pendcol work nearly used')
  assert.equal(flagsViolation(
    "assert.deepEqual([...el.children].map((c) => c.textContent), ['a'])"),
  false, 'and does NOT flag the correct fix')
  // the exact false positive that an earlier pattern produced six times: a
  // HELPER CALL whose argument merely happens to be named `el`
  assert.equal(flagsViolation("assert.deepEqual(names(el), ['bravo', 'alpha'])"),
    false, 'nor a helper that takes an element and returns strings')
})
