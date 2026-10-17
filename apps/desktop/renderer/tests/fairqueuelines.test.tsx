// fairqueuelines.test.tsx — FAIR-QUEUE WATCHER LINES on the canvas (Orgtree
// 4.4.0; docket `project-nodes-in-the-org-hierarchy-with-a-fair-p`, point 26,
// user 2026-10-17 22:48Z: agents with an active fair_queue watcher on a
// project get a line to that project in a unique colour, readable in both
// themes; a paused watcher shows dimmed or dashed).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 fairQueueLinks: one line per armed or paused fair_queue dog, from its
//      owner to the project it watches (target by name, '@' tolerated);
//      paused dogs are marked; exited, spent and other kinds draw nothing,
//      nor does a dog whose project is not on the canvas;
//   §2 the line's colour is its own: a stroke no other wire, tier or status
//      token uses, set for the dark theme and again for the light themes;
//      a paused line is dashed and dimmed.
//
// The rendered lines are measured by projectnode-visual (scene `fairqueue`).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs fairqueuelines

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fairQueueLinks } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'

declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')

const dog = (id: string, owner: string, target: string, extra: Partial<Watchdog> = {}) => ({
  id, owner, name: id, kind: 'fair_queue', target, interval_s: 5, state: 'armed',
  at: new Date().toISOString(), fired: 0, once: false, ...extra,
}) as unknown as Watchdog

/* ─── §1 which dogs draw a line ─────────────────────────────────────────── */

test('§1 one line per armed or paused fair_queue dog, owner to project', () => {
  const projects = new Set(['website', 'ui'])
  const links = fairQueueLinks([
    dog('q1', 'dev1', 'website'),
    dog('q2', 'boss', '@ui', { state: 'paused' }),
    dog('q3', 'dev2', 'website', { state: 'exited' }),
    dog('q4', 'dev3', 'website', { spent: true } as Partial<Watchdog>),
    dog('c1', 'dev1', 'website', { kind: 'command' } as Partial<Watchdog>),
    dog('q5', 'dev4', 'gone'),
  ], (n) => projects.has(n))
  assert.deepEqual(links, [
    { key: 'fq:q1', owner: 'dev1', project: 'website', paused: false },
    { key: 'fq:q2', owner: 'boss', project: 'ui', paused: true },
  ])
})

/* ─── §2 its colour ─────────────────────────────────────────────────────── */

const rule = (sel: string) => {
  const at = css.indexOf(sel + ' {')
  assert.ok(at >= 0, `no rule ${sel}`)
  return css.slice(at, css.indexOf('}', at))
}

test('§2a the line has its own colour token, in the dark and the light themes', () => {
  assert.match(rule('.edge.fq-line'), /stroke:\s*var\(--fq-line\)/)
  const dark = /:root \{[^}]*--fq-line:\s*(#[0-9a-fA-F]{6})/.exec(css)
  const light = /:root:is\(\.contrast-light, \.contrast-solarized-light\) \{[^}]*--fq-line:\s*(#[0-9a-fA-F]{6})/.exec(css)
  assert.ok(dark, 'dark --fq-line')
  assert.ok(light, 'light --fq-line')
  assert.notEqual(dark[1]!.toLowerCase(), light[1]!.toLowerCase(), 'the light theme deepens it')
  // nobody else wears it: no other custom property holds the same value
  for (const hex of [dark[1]!, light[1]!]) {
    const others = [...css.matchAll(new RegExp(`--([a-z0-9-]+):\\s*${hex}`, 'gi'))].map((m) => m[1])
    assert.deepEqual([...new Set(others)], ['fq-line'], `${hex} is unique to the fair-queue line`)
  }
})

test('§2b a paused watcher\'s line is dashed and dimmed', () => {
  const off = rule('.edge.fq-line.off')
  assert.match(off, /stroke-dasharray:\s*\d/)
  const op = /opacity:\s*([.\d]+)/.exec(off)
  const base = /opacity:\s*([.\d]+)/.exec(rule('.edge.fq-line'))
  assert.ok(op && base && Number(op[1]) < Number(base[1]), 'dimmer than the armed line')
})
