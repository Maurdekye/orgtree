// Fixture for desklag_probe.py — INPUT-TO-PAINT LATENCY IN THE REAL TRANSCRIPT.
//
// The user symptom this exists to measure: typed text appears seconds after the
// key, and visible state changes lag, while CSS animations keep running. That
// shape is a blocked renderer main thread, so the thing to measure is the cost
// of ONE re-render of the transcript list — which is what a keystroke in the
// composer causes, because `desk.tsx` holds the composer's `text` state in the
// same component that maps the transcript rows.
//
// WHAT IS REAL HERE: the real `Msg` from desk.tsx, the real markdown pipeline,
// the real received-mail fold, the real styles.css. The probe supplies only the
// two things a fixture must: the rows, and a composer that owns sibling state.
//
// This file is bundled UNCHANGED against both v2.0.9 and the branch under test,
// so every number it reports is comparable. It therefore uses only API both
// trees export: `Msg` with the same props desk.tsx passes it.

import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Msg } from '../src/canvas/desk'
import type { ChatMessage } from '../src/types'

/** One synthetic transcript row's shape, chosen by the python side. */
interface RowSpec {
  kind: 'assistant' | 'mail' | 'tool'
  /** body size in characters */
  bytes: number
}

interface MountSpec {
  rows: RowSpec[]
}

/** Prose that costs what real prose costs: markdown structure, inline code and
 *  links, not one long run of the same character (which wraps into far fewer
 *  text nodes than real text and would understate every measurement). */
function prose(bytes: number, seed: number): string {
  const out: string[] = []
  let n = 0, i = 0
  while (n < bytes) {
    const w = i % 9
    const chunk = w === 0 ? `\n## Section ${seed}.${i}\n`
      : w === 3 ? `- a list item with \`inline_code_${i}\` and a [link](https://example.invalid/${i})\n`
      : w === 6 ? `\n\`\`\`\nconst sample${i} = { key: ${i}, name: "value-${seed}" }\n\`\`\`\n`
      : `The quick brown fox ${i} jumps over the lazy dog while the record for agent-${seed} is projected and reconciled. `
    out.push(chunk); n += chunk.length; i++
  }
  return out.join('')
}

function buildRows(spec: MountSpec): ChatMessage[] {
  return spec.rows.map((r, i) => {
    const at = new Date(Date.UTC(2026, 8, 12, 10, 0, i % 60)).toISOString()
    if (r.kind === 'mail') {
      // a RECEIVED MAIL row: an untyped envelope, which is what almost all
      // agent-to-agent mail is, so it takes the five-line fold path
      return {
        role: 'user', seq: i, event_id: 'e' + i, row_id: 'r' + i, ts: at,
        segments: [{ kind: 'mail', rows: [{
          id: 'm' + i, from: 'coordinator-astra', kind: 'message',
          body: prose(r.bytes, i), at,
        }] }],
      } as unknown as ChatMessage
    }
    if (r.kind === 'tool') {
      // a COLLAPSED tool chip carrying a large result, the shape a giant
      // `orgtree_work list` reply arrives in
      return {
        role: 'assistant', seq: i, event_id: 'e' + i, row_id: 'r' + i, ts: at,
        text: prose(400, i),
        tools: [{ id: 't' + i, name: 'orgtree_work', arg: 'list', result: prose(r.bytes, i),
          result_lines: Math.ceil(r.bytes / 60) }],
      } as unknown as ChatMessage
    }
    return {
      role: 'assistant', seq: i, event_id: 'e' + i, row_id: 'r' + i, ts: at,
      text: prose(r.bytes, i),
    } as unknown as ChatMessage
  })
}

/** Mirrors `DeskChatInner`: the composer's text state and the transcript map
 *  live in ONE component, so every keystroke re-renders every row. The two
 *  per-render arrow props are the ones desk.tsx really passes. */
/** set by `api.grow` — a row index and the body size to rebuild it at, so a
 *  test can change ONE body's content without touching the rest */
let applyGrow: ((index: number, bytes: number) => void) | null = null

function Harness({ spec }: { spec: MountSpec }) {
  const [grown, setGrown] = useState<Record<number, number>>({})
  applyGrow = (index, bytes) => setGrown((prev) => ({ ...prev, [index]: bytes }))
  const rows = useMemo(() => buildRows({
    rows: spec.rows.map((r, i) => (i in grown ? { ...r, bytes: grown[i]! } : r)),
  }), [spec, grown])
  const [text, setText] = useState('')
  return <div className="deskchat">
    <div className="msgs">
      {rows.map((m, i) => (
        <div data-transcript-row key={m.assistant_id ?? m.native_event_id ?? m.row_id ?? m.event_id ?? m.seq ?? i}>
          <Msg m={m} slug="orgtree" nid="probe"
            replyAvailable={() => false} onLocateReply={() => {}} />
        </div>
      ))}
    </div>
    <textarea id="composer" rows={2} value={text}
      onChange={(e) => setText(e.target.value)} />
  </div>
}

// ---------------------------------------------------------------------------
// instrumentation
// ---------------------------------------------------------------------------

interface Counter { calls: number; ms: number }
const rects: Counter = { calls: 0, ms: 0 }
{
  // Range.getClientRects is how the five-line fold measures a body. Counting it
  // separates "React re-rendered" from "layout was interrogated per text node".
  const proto = Range.prototype as unknown as { getClientRects(): DOMRectList }
  const original = proto.getClientRects
  proto.getClientRects = function patched(this: Range) {
    const t0 = performance.now()
    const out = original.call(this)
    rects.calls++; rects.ms += performance.now() - t0
    return out
  }
}

const longTasks: number[] = []
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration)
  }).observe({ entryTypes: ['longtask'] })
} catch { /* the browser without longtask support reports none */ }

/** A keystroke's latency, measured the way the user perceives it: from the
 *  input event to the frame that actually shows the new character. */
interface Keystroke { latency: number; rectCalls: number; rectMs: number }
const strokes: Keystroke[] = []
let pending: { t0: number; rectCalls: number; rectMs: number } | null = null

function armComposer(): void {
  const box = document.getElementById('composer')
  if (!box) return
  box.addEventListener('input', () => {
    pending = { t0: performance.now(), rectCalls: rects.calls, rectMs: rects.ms }
    // Two frames: the first runs after React has committed, the second is the
    // frame that presents it. The delta to the SECOND is what the eye waits for.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!pending) return
      strokes.push({
        latency: performance.now() - pending.t0,
        rectCalls: rects.calls - pending.rectCalls,
        rectMs: rects.ms - pending.rectMs,
      })
      pending = null
    }))
  }, true)
}

const api = {
  mount(spec: MountSpec) {
    const host = document.getElementById('root')!
    rects.calls = 0; rects.ms = 0; longTasks.length = 0; strokes.length = 0
    const t0 = performance.now()
    createRoot(host).render(<Harness spec={spec} />)
    // React 18 commits synchronously enough for a mount measurement to be taken
    // on the next frame; the python side awaits it.
    return new Promise<{ mountMs: number; rectCalls: number; rectMs: number; nodes: number }>((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const result = {
          mountMs: performance.now() - t0,
          rectCalls: rects.calls, rectMs: rects.ms,
          nodes: host.querySelectorAll('*').length,
        }
        armComposer()
        done(result)
      }))
    })
  },
  reset() { rects.calls = 0; rects.ms = 0; longTasks.length = 0; strokes.length = 0 },
  /** Change ONE row's body. The fold must notice: driving the measurement from
   *  observers rather than from the render count is only correct if a genuine
   *  content change still re-measures, so the test that proves the fix is fast
   *  also has to prove this. */
  grow(index: number, bytes: number) {
    applyGrow?.(index, bytes)
    return new Promise<void>((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        // one more frame: the observer's callback lands after the commit
        requestAnimationFrame(() => done())
      }))
    })
  },
  /** Every received-mail fold on screen, as the reader sees it. */
  folds() {
    return [...document.querySelectorAll('.turn-mail-preview')].map((el) => {
      const button = el.querySelector('.turn-mail-toggle')
      return {
        folded: el.classList.contains('folded'),
        expandable: el.classList.contains('expandable'),
        label: button?.textContent ?? null,
      }
    })
  },
  report() {
    return {
      strokes,
      longTasks: [...longTasks],
      longTaskTotal: longTasks.reduce((a, b) => a + b, 0),
      rectCalls: rects.calls, rectMs: rects.ms,
    }
  },
}

;(window as unknown as { __desklag: typeof api }).__desklag = api
