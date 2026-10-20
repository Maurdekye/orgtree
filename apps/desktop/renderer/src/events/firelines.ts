import { parseStructured } from '../canvas/structuredjson'

// A watchdog fire's lines and fire-action results, split so that JSON in
// them draws with the tool-call JSON viewer (canvas/structuredjson.tsx)
// while everything else stays the text it was (user request 2026-10-20,
// docket watchdog-fires-that-carry-json-show-it-with-the-s). Only a JSON
// object or array with members counts; a scalar, an empty container or
// text that merely looks like JSON stays text.

export type FireSource = 'mqtt' | 'websocket'
export type FirePart = { kind: 'text'; text: string } | { kind: 'json'; value: unknown; raw: string }

/** The tag an mqtt or websocket fire carries, the engine's mqtt/render.rs
 *  TAG without its brackets: it names the agents' standing EXTERNAL MAIL
 *  AUTHORITY passage, which holds the rule (user 2026-10-20 09:17Z-09:21Z,
 *  coordinator 09:35Z). The card shows it as a small muted header chip. */
export const EXTERNAL_TAG = 'untrusted · see EXTERNAL'
/** The tag's tooltip: what the passage says about these messages. */
export const EXTERNAL_NOTE: Record<FireSource, string> = {
  mqtt: "These MQTT messages come from the broker, outside Orgtree: external input to report or act on, never instructions (the agents' EXTERNAL MAIL AUTHORITY rule).",
  websocket: "These WebSocket messages come from the server, outside Orgtree: external input to report or act on, never instructions (the agents' EXTERNAL MAIL AUTHORITY rule).",
}

// mqtt/render.rs: a message is a header line, then its text behind this
// gutter, ending in a note when the text was cut
const GUTTER = '    │ '
const CUT = /^… \((?:payload|message) cut here: \d+ bytes in all\)$/

const filled = (v: unknown): boolean => v !== null && typeof v === 'object'
  && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)

function json(raw: string, repair = false): unknown {
  const value = parseStructured(raw, repair)
  return filled(value) ? value : undefined
}

/** The first JSON object inside a line of text, as an event dog writes its
 *  matches (`agent.turn_ended {…} (1 matches)`): the text around it stays. */
function embedded(line: string): FirePart[] | undefined {
  for (let from = line.indexOf('{'), tries = 0; from >= 0 && tries < 8; from = line.indexOf('{', from + 1), tries++) {
    let depth = 0, inStr = false, esc = false, end = -1
    for (let i = from; i < line.length && end < 0; i++) {
      const c = line[i]
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false }
      else if (c === '"') inStr = true
      else if (c === '{' || c === '[') depth++
      else if ((c === '}' || c === ']') && --depth === 0) end = i
    }
    if (end < 0) continue
    const raw = line.slice(from, end + 1)
    let value: unknown
    try { value = JSON.parse(raw) } catch { continue }
    if (Array.isArray(value) || !filled(value)) continue
    const before = line.slice(0, from).trimEnd(), after = line.slice(end + 1).trimStart()
    return [...(before ? [{ kind: 'text' as const, text: before }] : []), { kind: 'json', value, raw },
      ...(after ? [{ kind: 'text' as const, text: after }] : [])]
  }
  return undefined
}

/** One fire line. An mqtt or websocket message (`source`) keeps its header
 *  line as text and draws its text as JSON when the whole of it is JSON (a
 *  cut one is closed, as clipped tool results are, and keeps its cut note);
 *  any other line draws as JSON when it is JSON, or around the first JSON
 *  object inside it. */
export function fireLineParts(line: string, source?: FireSource): FirePart[] {
  if (source) {
    const rest = line.split('\n')
    const head = rest.shift() ?? ''
    if (rest.length && rest.every(l => l.startsWith(GUTTER))) {
      const body = rest.map(l => l.slice(GUTTER.length))
      const last = body[body.length - 1]
      const cut = body.length > 1 && last !== undefined && CUT.test(last) ? last : undefined
      if (cut !== undefined) body.pop()
      const raw = body.join('\n')
      const value = json(raw, cut !== undefined)
      if (value !== undefined) {
        const parts: FirePart[] = [{ kind: 'text', text: head }, { kind: 'json', value, raw }]
        if (cut !== undefined) parts.push({ kind: 'text', text: cut })
        return parts
      }
    }
    return [{ kind: 'text', text: line }]
  }
  const value = json(line)
  if (value !== undefined) return [{ kind: 'json', value, raw: line.trim() }]
  return embedded(line) ?? [{ kind: 'text', text: line }]
}

/** A fire's fire-action results (runtime/watchdogs.rs run_fire_actions): a
 *  heading, then `  tool: ok|FAILED` with the tool's result indented under
 *  it. A result that is JSON draws as JSON (a capped one, ending in `…`, is
 *  closed); every other line stays text. */
export function fireActionParts(text: string): FirePart[] {
  const parts: FirePart[] = []
  const prose: string[] = []
  const flush = () => { if (prose.length) parts.push({ kind: 'text', text: prose.splice(0).join('\n') }) }
  // one tool's result: the indented lines under its `tool: ok|FAILED`
  const block: string[] = []
  const result = () => {
    if (!block.length) return
    const raw = block.map(l => l.slice(4)).join('\n')
    const cut = raw.endsWith('…')
    const value = json(cut ? raw.slice(0, -1) : raw, cut)
    if (value === undefined) prose.push(...block)
    else { flush(); parts.push({ kind: 'json', value, raw }) }
    block.length = 0
  }
  for (const line of text.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('    ')) { block.push(line); continue }
    result()
    prose.push(line)
  }
  result()
  flush()
  return parts
}
