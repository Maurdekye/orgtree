/** Conservative Markdown → source mapping. A full semantic text comparison
 * proves the DOM and lexer agree before any source offsets are returned.
 * DOM paths/pixels and indexOf(selectedText) are never durable identities. */
import { mathMarkdown } from './markdownmath'
import { localizeStamps } from '../timefmt'

type Unit = { char: string; start: number; end: number }
type Token = { type: string; raw: string; text?: string; tokens?: Token[]; items?: Token[];
  header?: { tokens: Token[]; text: string }[]; rows?: { tokens: Token[]; text: string }[][] }
type DomUnit = { node: Node; start: number; end: number; char: string; atomic?: Element }
export type SourceRange = { start: number; end: number }

function entity(raw: string, doc: Document): string {
  const box = doc.createElement('textarea'); box.innerHTML = raw
  return box.value
}
function literal(text: string, start: number, doc: Document): Unit[] {
  const out: Unit[] = []
  const token = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);|⟦t:[^⟧]+⟧/gi
  let cursor = 0
  const emit = (s: string, a: number, b?: number) => {
    for (let i = 0; i < s.length;) {
      const char = String.fromCodePoint(s.codePointAt(i)!)
      out.push({ char, start: a + (b === undefined ? i : 0), end: b ?? a + i + char.length })
      i += char.length
    }
  }
  for (const match of text.matchAll(token)) {
    emit(text.slice(cursor, match.index), start + cursor)
    const visible = match[0].startsWith('⟦t:') ? localizeStamps(match[0]) : entity(match[0], doc)
    emit(visible, start + match.index!, start + match.index! + match[0].length)
    cursor = match.index! + match[0].length
  }
  emit(text.slice(cursor), start + cursor)
  return out
}
/** Lexer offsets use normalized newlines; coordinates always return to the
 * exact original string, including CRLF and supplementary Unicode scalars. */
function normalize(source: string): { text: string; boundary: number[] } {
  let text = ''; const boundary = [0]
  for (let i = 0; i < source.length;) {
    const start = i; const c = source[i++]!
    if (c === '\r') { if (source[i] === '\n') i++; text += '\n' }
    else text += c
    boundary[text.length - 1] = start; boundary[text.length] = i
  }
  return { text, boundary }
}

function markdownUnits(source: string, doc: Document): Unit[] | null {
  const normalized = normalize(source)
  const out: Unit[] = []
  let valid = true
  const emitLiteral = (raw: string, start: number) => { for (const unit of literal(raw, start, doc)) out.push(unit) }
  const walk = (tokens: Token[], start: number, end: number) => {
    let cursor = start
    for (const token of tokens) {
      const pos = normalized.text.indexOf(token.raw, cursor)
      if (!token.raw || pos < cursor || pos + token.raw.length > end) { valid = false; return }
      const stop = pos + token.raw.length; cursor = stop
      if (token.type === 'space' || token.type === 'hr' || token.type === 'image' || token.type === 'def') continue
      if (token.items) { walk(token.items, pos, stop); continue }
      if (token.header) {
        let cellCursor = pos
        for (const cell of [...token.header, ...(token.rows ?? []).flat()]) {
          const at = normalized.text.indexOf(cell.text, cellCursor)
          if (at < cellCursor || at + cell.text.length > stop) { valid = false; return }
          walk(cell.tokens, at, at + cell.text.length); cellCursor = at + cell.text.length
        }
        continue
      }
      if (token.tokens) { walk(token.tokens, pos, stop); continue }
      if (token.type === 'mathInline' || token.type === 'mathBlock') {
        // A rendered expression is atomic; annotation text is our comparison
        // token, while the source interval includes its original delimiters.
        for (const char of token.text ?? '') out.push({ char, start: pos, end: stop })
        continue
      }
      if (token.type === 'escape') {
        for (const char of token.text ?? '') out.push({ char, start: pos, end: stop })
        continue
      }
      if (token.type === 'br') continue
      if (token.type === 'code' || token.type === 'codespan') {
        let codeStart = pos; let codeEnd = stop
        if (token.type === 'codespan') {
          const run = /^`+/.exec(token.raw)?.[0].length ?? 0
          codeStart += run; codeEnd -= run
        } else if (/^ {0,3}(?:`{3,}|~{3,})/.test(token.raw)) {
          codeStart += token.raw.indexOf('\n') + 1
          const last = /\n {0,3}(?:`{3,}|~{3,})[^\n]*\n?$/.exec(token.raw)
          if (last) codeEnd = pos + last.index
        }
        // Code is literal, including entities. Removed indentation/newline
        // normalization never changes the order of non-whitespace characters.
        const raw = normalized.text.slice(codeStart, codeEnd)
        for (let i = 0; i < raw.length;) {
          const char = String.fromCodePoint(raw.codePointAt(i)!)
          out.push({ char, start: codeStart + i, end: codeStart + i + char.length }); i += char.length
        }
        continue
      }
      emitLiteral(token.raw, pos)
    }
  }
  walk(mathMarkdown.lexer(normalized.text) as unknown as Token[], 0, normalized.text.length)
  return valid ? out.map(unit => ({ ...unit, start: normalized.boundary[unit.start]!, end: normalized.boundary[unit.end]! })) : null
}

function domUnits(root: Element): DomUnit[] {
  const out: DomUnit[] = []
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? ''
      for (let i = 0; i < text.length;) {
        const char = String.fromCodePoint(text.codePointAt(i)!)
        out.push({ node, start: i, end: i + char.length, char }); i += char.length
      }
      return
    }
    if (node.nodeType !== 1) return
    const el = node as Element
    if (el !== root && el.hasAttribute('data-selection-source')) return
    const reference = el.getAttribute('data-ref-token') ?? el.getAttribute('data-ref-mention')
    // The sanitizer preserves KaTeX's text annotation but may strip its
    // encoding attribute; the trusted renderer's .katex ancestor is the gate.
    const math = el.matches('.katex') ? el.querySelector('annotation')?.textContent : null
    const atomic = reference ?? math
    if (atomic !== null && atomic !== undefined) {
      for (const char of atomic) out.push({ node: el, start: 0, end: el.childNodes.length, char, atomic: el })
      return
    }
    if (el.matches('button,input,textarea,select,svg,script,style,[aria-hidden="true"],.code-copy,.ref-why')) return
    for (const child of el.childNodes) visit(child)
  }
  visit(root)
  return out
}
const nonspace = (unit: { char: string }) => !/^\s$/u.test(unit.char)

/** Return one enclosing source interval. Markdown syntax within the interval
 * is retained as source text. A rendering mismatch refuses instead of guessing. */
export function selectedSourceRange(root: Element, source: string, range: Range, format: 'markdown' | 'plain' = 'markdown'): SourceRange | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer) || range.collapsed) return null
  const plain: Unit[] = []
  if (format === 'plain') for (let i = 0; i < source.length;) {
    const char = String.fromCodePoint(source.codePointAt(i)!); plain.push({ char, start: i, end: i + char.length }); i += char.length
  }
  const projected = format === 'plain' ? plain : markdownUnits(source, root.ownerDocument)
  if (!projected) return null
  const canonical = projected.filter(nonspace)
  const visible = domUnits(root).filter(nonspace)
  if (canonical.length !== visible.length || canonical.some((unit, i) => unit.char !== visible[i]!.char)) return null
  const selected: number[] = []
  for (let i = 0; i < visible.length; i++) {
    const unit = visible[i]!
    const part = root.ownerDocument.createRange()
    if (unit.atomic) part.selectNode(unit.atomic)
    else { part.setStart(unit.node, unit.start); part.setEnd(unit.node, unit.end) }
    // Positive intersection, including backwards selections whose Range has
    // already normalized anchor/focus. Merely touching a boundary is excluded.
    if (range.compareBoundaryPoints(3, part) < 0 && range.compareBoundaryPoints(1, part) > 0) selected.push(i)
  }
  if (!selected.length) return null
  const first = canonical[selected[0]!]!; const last = canonical[selected.at(-1)!]!
  if (first.start >= last.end) return null
  let start = first.start; let end = last.end
  const selectedText = range.toString()
  const leading = selectedText.match(/^\s+/u)?.[0].replace(/\r\n/g, '\n').length ?? 0
  const trailing = selectedText.match(/\s+$/u)?.[0].replace(/\r\n/g, '\n').length ?? 0
  for (let i = 0; i < leading && start > 0 && /\s/u.test(source[start - 1]!); i++) {
    start--; if (source[start] === '\n' && source[start - 1] === '\r') start--
  }
  for (let i = 0; i < trailing && end < source.length && /\s/u.test(source[end]!); i++) {
    if (source[end] === '\r' && source[end + 1] === '\n') end++; end++
  }
  return { start: [...source.slice(0, start)].length, end: [...source.slice(0, end)].length }
}
