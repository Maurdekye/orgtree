// deepdom_probe.mjs — MEASUREMENT, not a fix. Loaded with `node --import` so it
// patches node:assert/strict BEFORE any bundled suite imports it, and records
// every deep-equality assertion whose operands are (or contain) a DOM node.
//
// Why measured rather than grepped: whether an operand is a DOM node is a
// RUNTIME fact. `assert.deepEqual(got, [])` tells you nothing from the source
// — `got` may be ids, or it may be elements. Grep would guess; this counts.
//
// The finding it exists to quantify (memory-leak, 2026-08-28, measured):
// deep-equality on two SAME-TAG jsdom elements can never throw, because
// Object.keys() on a jsdom element is [] — everything lives on the prototype,
// so deep-equality has nothing to compare. Such a leg is permanently green.
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'

// ⚠ NO LOG PATH = NO MEASUREMENT, and it must say so rather than sit there
// looking attached. This hook once ran with the variable unset, swallowed
// every write in a try/catch, and the run reported zero violations — which is
// also what a clean suite reports. Refuse loudly instead (D-168: abstention
// must never be indistinguishable from success).
const LOG = process.env.ORGTREE_DEEPPROBE_LOG
if (!LOG) {
  throw new Error('deepdom_probe.mjs: ORGTREE_DEEPPROBE_LOG is not set — the '
    + 'probe would record nothing and report a clean sheet. Run it through '
    + 'tests/deepdom_probe.py.')
}
const isNode = (v) => Boolean(v) && typeof v === 'object'
  && typeof v.nodeType === 'number' && typeof v.nodeName === 'string'

/** a node, or a container holding one — an array of elements deep-compares
 *  the same way element-by-element, so it is the same defect */
const touchesNode = (v, d = 0) => {
  if (d > 3 || !v || typeof v !== 'object') return false
  if (isNode(v)) return true
  if (Array.isArray(v)) return v.some((x) => touchesNode(x, d + 1))
  if (v instanceof Map || v instanceof Set) return [...v].some((x) => touchesNode(x, d + 1))
  // a plain object holding elements counts too
  const proto = Object.getPrototypeOf(v)
  if (proto === Object.prototype || proto === null) {
    return Object.values(v).some((x) => touchesNode(x, d + 1))
  }
  return false
}

for (const name of ['deepEqual', 'deepStrictEqual', 'notDeepEqual', 'notDeepStrictEqual']) {
  const orig = assert[name]
  if (typeof orig !== 'function') continue
  assert[name] = function patched(a, b, ...rest) {
    if (touchesNode(a) || touchesNode(b)) {
      // ⚠ skip THIS file's own frame, or every hit is attributed to the
      // probe and the report names no caller at all. (It did, at first —
      // the exclusion said 'deepprobe' after the file was renamed to
      // deepdom_probe, so it matched nothing.)
      const frames = (new Error().stack || '').split('\n').slice(1)
        .find((l) => /\.tsx?:|\.mjs:/.test(l) && !l.includes('deepdom_probe')) || '?'
      try {
        appendFileSync(LOG, JSON.stringify({
          fn: name,
          a: isNode(a) ? a.nodeName : Array.isArray(a) ? `array[${a.length}]` : typeof a,
          b: isNode(b) ? b.nodeName : Array.isArray(b) ? `array[${b.length}]` : typeof b,
          at: frames.trim(),
        }) + '\n')
      } catch { /* the log is best-effort; never break the suite */ }
    }
    return orig.call(this, a, b, ...rest)
  }
}
