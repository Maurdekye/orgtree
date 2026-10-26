// frontend/tests/testguard.mjs — bounds what a FAILING test can cost the machine.
//
// ⚠ WHY THIS EXISTS (2026-10-26, docket test-runs-a-node-process-balloons-to-
// 41-gb-ram-c). A red run of `assert.equal(el.querySelector(sel), null, msg)`
// grew one node process to 41 GB until the user killed it by hand. The same
// shape had already been hit at least ten times ("Array buffer allocation
// failed": attentionaudit, attentionqueue, docketname, mailsender, sysnotice,
// …), and each file grew its own "never hand a DOM node to an assertion" rule.
// This module removes the trap instead of documenting it an eleventh time.
//
// THE MECHANISM, read from Node 24's own lib/internal/assert:
//   1. strictEqual, deepStrictEqual and partialDeepStrictEqual ALWAYS build a
//      diff when they fail, even when the caller passed a message.
//   2. The diff starts from util.inspect of both values at depth 1000, with
//      getters on and custom inspectors off. React keeps its fiber and props
//      on every DOM node it renders (`__reactFiber$…`, `__reactProps$…`, own
//      enumerable keys), so one rendered element prints as thousands of lines.
//   3. The Myers line diff then keeps a copy of its whole frontier array
//      (2·lines+1 int32s) for EVERY edit step: about 8·lines² bytes, held as
//      ArrayBuffers, which is external memory --max-old-space-size does not
//      cap. ~70k lines is ~40 GB; two different 10k-line strings are ~3 GB.
//
// WHAT IT DOES
//   • Wraps the comparison methods of node:assert and node:assert/strict. The
//     wrapper asks Node's ORIGINAL method to compare, with an Error as the
//     message: on failure Node throws that Error as-is before it builds any
//     AssertionError (`innerFail`), so what passes and what fails is exactly
//     Node's decision and nothing has been formatted yet.
//   • On failure it counts the lines Node's report would print, walking the
//     values the way util.inspect does, against a hard budget. Within the
//     budget Node builds its usual message and diff. Past it, the wrapper
//     throws its own AssertionError: the caller's message, the readable
//     operator and a short preview of each value (an element's opening tag,
//     a depth-0 inspect) — milliseconds, not gigabytes.
//   • In a test process OUTSIDE run.mjs's Job Object (a bundle run directly
//     with `node --test`, as the incident's was), a watchdog thread ends the
//     process when it passes ORGTREE_TEST_GUARD_MB resident, when the
//     machine's free memory drops below ORGTREE_TEST_GUARD_FREE_MB, or when
//     its parent process is gone. A thread, because the runaway is a
//     synchronous loop on the main thread, where no timer could ever fire.
//     (Measured 2026-10-26: on Windows a node parent's NON-detached children
//     already die with it, through libuv's kill-on-close job, whether the
//     `node --test` parent is hard-killed or stopped by Git Bash `timeout`.
//     The parent check is for detached launches and other platforms; the
//     memory checks are what would have stopped the incident.)
//
// WHAT IT DOES NOT DO: it never changes what passes or fails, and it bounds
// nothing but assertion reports and uncontained processes. run.mjs's Job
// Object, heap cap, per-test timeout and concurrency cap stay the run's real
// bounds; launch tests through run.mjs.
//
// Loaded twice on purpose, and idempotent: harness.ts imports it first (every
// bundle that mounts a DOM, however it is launched), and run.mjs preloads it
// into every test process with NODE_OPTIONS=--import (the bundles that never
// import the harness). testguard.test.ts holds the controls.

import assert from 'node:assert'
import { syncBuiltinESMExports } from 'node:module'
import { inspect, types } from 'node:util'
import { Worker } from 'node:worker_threads'

/** Lines Node's own failure report may print before its diff stops being
 *  cheap. The diff's arrays cost ~8·lines² bytes, so 1,500 lines (actual and
 *  expected together) stay under ~20 MB and a few milliseconds. */
export const LINE_BUDGET = 1500

// util.inspect's default maxStringLength, which assert's own options keep
const STRING_LIMIT = 10_000

// Symbol.for, not Symbol: the bundled copy and the preloaded copy are two
// module instances and must recognise each other's work.
const INSTALLED = Symbol.for('orgtree.testguard.installed')
const ORIGINAL = Symbol.for('orgtree.testguard.original')

/** Keyed by the ORIGINAL function's name, not the property: assert/strict's
 *  `equal` is the strictEqual function and reports as strictEqual. */
const OPERATORS = {
  equal: ['==', 'Expected values to be loosely equal'],
  notEqual: ['!=', 'Expected "actual" to be loosely unequal to "expected"'],
  deepEqual: ['deepEqual', 'Expected values to be loosely deep-equal'],
  notDeepEqual: ['notDeepEqual', 'Expected "actual" not to be loosely deep-equal to "expected"'],
  strictEqual: ['strictEqual', 'Expected values to be strictly equal'],
  notStrictEqual: ['notStrictEqual', 'Expected "actual" to be strictly unequal to "expected"'],
  deepStrictEqual: ['deepStrictEqual', 'Expected values to be strictly deep-equal'],
  notDeepStrictEqual: ['notDeepStrictEqual', 'Expected "actual" not to be strictly deep-equal to "expected"'],
  partialDeepStrictEqual: ['partialDeepStrictEqual', 'Expected values to be partially and strictly deep-equal'],
}

// Thrown by Node itself, never constructed per call: identity is the signal.
const FAILED = new Error('testguard: the comparison failed')

const isPrimitive = (v) => v === null || (typeof v !== 'object' && typeof v !== 'function')

function stringLines(s) {
  const text = s.length > STRING_LIMIT ? s.slice(0, STRING_LIMIT) : s
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** About how many lines assert's report would print for `value` (depth 1000,
 *  getters on, own enumerable keys, every array element), or Infinity once
 *  past `budget`. Errs high: a value it cannot see into cheaply (a Proxy, a
 *  huge array or buffer) counts as over budget, never as small. */
export function estimateLines(value, budget = LINE_BUDGET) {
  let lines = 0
  const path = []
  const visit = (v, depth) => {
    if (lines > budget) return
    if (isPrimitive(v)) { lines += typeof v === 'string' ? stringLines(v) : 1; return }
    // inspect prints [Circular] / [Object] for these, one line each
    if (depth > 1000 || path.includes(v)) { lines += 1; return }
    if (types.isProxy(v)) { lines = Infinity; return }
    lines += 2
    path.push(v)
    try {
      const indexed = Array.isArray(v) || types.isTypedArray(v)
      if (indexed) {
        if (v.length > budget) { lines = Infinity; return }
        for (let i = 0; i < v.length && lines <= budget; i++) visit(v[i], depth + 1)
      } else if (types.isAnyArrayBuffer(v) || types.isDataView(v)) {
        if (v.byteLength > 65_536) { lines = Infinity; return }
        lines += 2
      } else if (types.isMap(v) || types.isSet(v)) {
        if (v.size > budget) { lines = Infinity; return }
        for (const entry of v) {
          if (lines > budget) break
          if (types.isMap(v)) { visit(entry[0], depth + 1); visit(entry[1], depth + 1) } else visit(entry, depth + 1)
        }
      } else if (types.isNativeError(v) || v instanceof Error) {
        lines += stringLines(String(v.stack ?? v.message ?? ''))
      }
      const keys = [...Object.keys(v), ...Object.getOwnPropertySymbols(v)]
      for (const key of keys) {
        if (lines > budget) break
        if (indexed && typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) continue
        const desc = Object.getOwnPropertyDescriptor(v, key)
        if (!desc || !desc.enumerable) continue
        if ('value' in desc) { visit(desc.value, depth + 1); continue }
        if (!desc.get) { lines += 1; continue }
        // assert inspects with `getters: true`, so it calls the getter too
        let got
        try { got = Reflect.apply(desc.get, v, []) } catch { lines += 1; continue }
        visit(got, depth + 1)
      }
    } finally {
      path.pop()
    }
  }
  try { visit(value, 0) } catch { return Infinity }
  return lines > budget ? Infinity : lines
}

const clip = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s)

function typeName(v) {
  try { return v.constructor?.name || Object.prototype.toString.call(v).slice(8, -1) } catch { return 'object' }
}

/** A DOM node as its opening tag, never its graph. Duck-typed so it serves
 *  any jsdom window, including documents a test creates for itself. */
function domPreview(v) {
  if (!('nodeType' in v) || !('nodeName' in v)) return null
  const type = v.nodeType
  const nodeName = v.nodeName
  if (typeof type !== 'number' || typeof nodeName !== 'string') return null
  if (type === 1) {
    let attrs = ''
    const list = v.attributes ?? []
    for (let i = 0; i < list.length && i < 8; i++) attrs += ` ${list[i].name}="${clip(String(list[i].value), 60)}"`
    if (list.length > 8) attrs += ` …+${list.length - 8}`
    return `<${nodeName.toLowerCase()}${attrs}> (${typeName(v)}, ${v.childNodes?.length ?? 0} child nodes, ${v.isConnected ? 'in a document' : 'detached'})`
  }
  if (type === 3) return `#text ${JSON.stringify(clip(String(v.data ?? ''), 80))}`
  return `${nodeName} (${typeName(v)})`
}

/** One bounded line for any value: what a person needs to recognise it. */
export function preview(v) {
  try {
    if (typeof v === 'string') {
      return v.length > 200 ? `${JSON.stringify(v.slice(0, 200))}… (${v.length} chars, ${stringLines(v)} lines)` : JSON.stringify(v)
    }
    if (isPrimitive(v)) return inspect(v)
    if (types.isProxy(v)) return `<Proxy> (${typeName(v)})`
    const dom = domPreview(v)
    if (dom) return dom
    const listy = Array.isArray(v) || ArrayBuffer.isView(v) || types.isMap(v) || types.isSet(v)
    if (!listy) {
      const keys = Object.keys(v).length
      if (keys > 200) return `${typeName(v)} with ${keys} own keys`
    }
    return clip(inspect(v, {
      depth: 0, maxArrayLength: 20, maxStringLength: 120, breakLength: Infinity,
      compact: true, customInspect: false, getters: false,
    }))
  } catch (err) {
    return `<preview failed: ${err?.message ?? err}>`
  }
}

/** What the failure carries as `actual`/`expected`: primitives as they are
 *  (cheap, and what reporters expect), anything else as its preview, so no
 *  reporter (TAP's YAML walker, a custom one) can walk a DOM graph either. */
const summary = (v) =>
  (isPrimitive(v) ? (typeof v === 'string' && v.length > STRING_LIMIT ? `${v.slice(0, STRING_LIMIT)}…` : v) : preview(v))

/** Point a Node-built AssertionError's stack at the test, not this wrapper:
 *  the same name dance AssertionError's constructor does for its header. */
function fromCaller(err, fn) {
  if (!(err instanceof Error) || typeof Error.captureStackTrace !== 'function') return err
  const name = err.name
  try {
    if (err.code) err.name = `${name} [${err.code}]`
    Error.captureStackTrace(err, fn)
    void err.stack
  } catch { /* keep Node's own stack */ } finally {
    try { err.name = name } catch { /* read-only name: leave it */ }
  }
  return err
}

function boundedFailure(operator, readable, actual, expected, message, stackStartFn) {
  const custom = message !== undefined
  const negative = operator === '!=' || operator.startsWith('not')
  const body = negative
    ? [`  ${preview(actual)}`]
    : [`+ actual   ${preview(actual)}`, `- expected ${preview(expected)}`]
  const head = custom ? `${message}\n\n${readable}` : readable
  const text = `${head} (report bounded by tests/testguard.mjs: these values print as more than ${LINE_BUDGET} lines):\n${body.join('\n')}`
  // operator 'fail' keeps AssertionError from building its diff; the real
  // operator is set right after
  const err = new assert.AssertionError({ message: text, operator: 'fail', stackStartFn })
  err.generatedMessage = !custom
  err.operator = operator
  err.actual = summary(actual)
  err.expected = summary(expected)
  return err
}

function guarded(original) {
  if (original[ORIGINAL]) return original
  const [operator, readable] = OPERATORS[original.name]
  const name = original.name
  const wrapper = {
    [name](actual, expected, message) {
      // missing arguments and a caller's own Error keep Node's exact paths:
      // the first throws ERR_MISSING_ARGS, the second throws that Error
      if (arguments.length < 2 || message instanceof Error) return Reflect.apply(original, this, arguments)
      try {
        Reflect.apply(original, this, [actual, expected, FAILED])
        return
      } catch (err) {
        if (err !== FAILED) throw err
      }
      const actualLines = estimateLines(actual)
      const total = actualLines > LINE_BUDGET ? Infinity
        : actualLines + estimateLines(expected, LINE_BUDGET - actualLines)
      if (total <= LINE_BUDGET) {
        try {
          Reflect.apply(original, this, [actual, expected, message])
        } catch (err) {
          throw fromCaller(err, wrapper)
        }
      }
      throw boundedFailure(operator, readable, actual, expected, message, wrapper)
    },
  }[name]
  Object.defineProperty(wrapper, ORIGINAL, { value: original })
  return wrapper
}

/** The unwrapped Node method behind a guarded one (for the controls). */
export const originalOf = (fn) => fn?.[ORIGINAL] ?? fn

function installAssertGuard() {
  const cache = new Map()
  const targets = [assert, assert.strict, assert.Assert?.prototype].filter(Boolean)
  for (const target of targets) {
    for (const prop of Object.keys(OPERATORS)) {
      const fn = target[prop]
      if (typeof fn !== 'function' || fn[ORIGINAL] || !OPERATORS[fn.name]) continue
      if (!cache.has(fn)) cache.set(fn, guarded(fn))
      target[prop] = cache.get(fn)
    }
  }
  // named imports (`import { strictEqual } from 'node:assert'`) follow too
  syncBuiltinESMExports()
}

// ------------------------------------------------------------ the watchdog
// Runs in its own thread with its own tiny heap. fs.writeSync, not console:
// console output from a worker is relayed through the main thread, which is
// exactly the thread that is stuck when this fires.
const WATCHDOG = `
const { workerData } = require('node:worker_threads')
const { writeSync } = require('node:fs')
const { freemem } = require('node:os')
const { limitMb, freeMb, ppid, intervalMs } = workerData
const MB = 1024 * 1024
function stop(reason) {
  try { writeSync(2, '\\n[testguard] ' + reason + ' - ending test process ' + process.pid + ' (outside run.mjs\\'s Job; run tests through run.mjs)\\n') } catch {}
  try { process.kill(process.pid, 'SIGKILL') } catch {}
}
setInterval(() => {
  const rss = process.memoryUsage.rss()
  if (limitMb > 0 && rss > limitMb * MB) return stop('resident memory ' + Math.round(rss / MB) + ' MB passed ORGTREE_TEST_GUARD_MB=' + limitMb)
  const free = freemem()
  if (freeMb > 0 && free < freeMb * MB) return stop('machine free memory ' + Math.round(free / MB) + ' MB fell below ORGTREE_TEST_GUARD_FREE_MB=' + freeMb)
  if (ppid > 1) {
    try { process.kill(ppid, 0) } catch (err) { if (err && err.code === 'ESRCH') return stop('parent process ' + ppid + ' is gone') }
  }
}, intervalMs)
`

function envMb(name, dflt) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return dflt
  if (!/^\d+$/.test(raw.trim())) {
    // refused, not read as 0: a typo must not switch a guard off silently
    throw new Error(`[testguard] ${name}=${JSON.stringify(raw)} is not a whole number of MB`)
  }
  return Number(raw.trim())
}

function startWatchdog() {
  // run.mjs sets this to its Job's ceiling: the kernel bounds that run and
  // TerminateJobObject ends its whole tree, so a thread would add nothing
  if (envMb('ORGTREE_TEST_CONTAINED_MB', 0) > 0) return 'contained'
  const limitMb = envMb('ORGTREE_TEST_GUARD_MB', 3072)
  const freeMb = envMb('ORGTREE_TEST_GUARD_FREE_MB', 2048)
  if (limitMb === 0) return 'off'
  const worker = new Worker(WATCHDOG, {
    eval: true,
    workerData: { limitMb, freeMb, ppid: process.ppid, intervalMs: 200 },
    resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
  })
  worker.on('error', () => { /* the guard must never fail a test itself */ })
  worker.unref()
  return 'watching'
}

const state = globalThis[INSTALLED] ?? (globalThis[INSTALLED] = (() => {
  installAssertGuard()
  return { watchdog: startWatchdog() }
})())

/** 'contained' (run.mjs's Job bounds it), 'watching' or 'off'. */
export const watchdog = state.watchdog
