// durationunits.test.ts - a duration reads "250ms" like "3s": the unit sits against its number
// (USER 2026-10-30 mf5ac518e2d05 "theres a space between the number and the ms for millisecond
// counts but no space for second counts", mdd3b2c7f700b "remove the space for ms").
//
// Run:  node apps/desktop/renderer/tests/run.mjs durationunits
//
// These drive the REAL shared formatter the transcript's tool and thought clocks call, over a
// sweep wide enough to hit every unit and every boundary between them, so a formatter that
// regains a space in ONE branch fails here and not only in the one chip a screen test happens
// to draw.

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { executionTime, formatDuration, formatSeconds } from '../src/canvas/toolclock'

test('milliseconds read like seconds: the unit sits against its number', () => {
  for (const [ms, text] of [
    [0, '0ms'], [31, '31ms'], [784, '784ms'], [999.4, '999ms'],
    [1200, '1.2s'], [12000, '12s'], [65000, '1m 05s'], [3720000, '1h 02m'],
  ] as const) assert.equal(formatDuration(ms), text)
})

test('no duration the formatter returns has a space between a number and its unit', () => {
  let seen = 0
  const step = (ms: number) => ms < 5000 ? 7 : ms < 120e3 ? 1013 : 61001
  for (let ms = 0; ms < 8 * 3600e3; ms += step(ms)) {
    const text = formatDuration(ms)
    seen++
    assert.doesNotMatch(text, /\d\s+(ms|s|m|h)\b/, `${ms} ms read ${JSON.stringify(text)}`)
  }
  assert.ok(seen > 1000, 'the sweep ran')
})

test('a finished call and a recorded thought share the same unit style', () => {
  assert.equal(executionTime('2026-10-30T10:00:00.000Z', '2026-10-30T10:00:00.031Z'), '31ms')
  assert.equal(executionTime('2026-10-30T10:00:00.000Z', '2026-10-30T10:00:03.000Z'), '3.0s')
  assert.equal(formatSeconds(0), '0s')
  assert.equal(formatSeconds(59), '59s')
  assert.equal(formatSeconds(75), '1m 15s')
})

test('an unreadable or negative duration draws nothing', () => {
  for (const bad of [NaN, Infinity, -1]) assert.equal(formatDuration(bad), '')
})
