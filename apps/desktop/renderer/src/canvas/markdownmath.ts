import { Marked, type TokenizerExtension, type Tokens } from 'marked'
import katex from 'katex'

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

interface MathToken extends Tokens.Generic { type: 'mathInline' | 'mathBlock'; raw: string; text: string; display: boolean }

// Called by Markdown's lexer, so fenced/indented code and backtick spans retain
// their ordinary precedence. Unfinished delimiters remain normal Markdown.
function mathToken(src: string, block: boolean): MathToken | undefined {
  const open = block ? (src.startsWith('$$') ? '$$' : src.startsWith('\\[') ? '\\[' : '')
    : src.startsWith('$$') ? '$$' : src.startsWith('\\[') ? '\\['
      : src.startsWith('\\(') ? '\\(' : src.startsWith('$') ? '$' : ''
  if (!open) return
  const display = open === '$$' || open === '\\['
  const close = open === '\\[' ? '\\]' : open === '\\(' ? '\\)' : open
  if (open === '$' && (!src[1] || /[\s$]/.test(src[1]!))) return
  if (open === '$' && /[({]/.test(src[1]!)) return // shell ${VAR} and $(command)
  let end = open.length
  for (; end < src.length; end++) {
    if (!display && /[\r\n]/.test(src[end]!)) return
    if (!src.startsWith(close, end)) continue
    // A dollar escaped with an odd number of backslashes is part of LaTeX.
    if (close[0] === '$') {
      let slashes = 0
      for (let i = end - 1; i >= 0 && src[i] === '\\'; i--) slashes++
      if (slashes % 2) continue
    }
    break
  }
  if (end >= src.length) return
  const text = src.slice(open.length, end)
  if (!text.trim()) return
  if (open === '$') {
    if (/\s/.test(text.at(-1)!) || /[\w$]/.test(src[end + 1] ?? '')) return
    // Bare amounts and shell identifiers are deliberately conservative. Use
    // explicit \(...\) for uppercase identifiers or numeric-only formulas.
    if (/^\d[\d.,]*(?:\s|$)/.test(text) || /^[A-Z_][A-Z0-9_]*$/.test(text)) return
  }
  const raw = src.slice(0, end + close.length)
  if (block && src.slice(raw.length).match(/^[^\S\n]*\S/)) return
  return { type: block ? 'mathBlock' : 'mathInline', raw, text, display }
}

const renderMath = (token: MathToken) => {
  // escapeAngles has already escaped prose '<'. Restore that one transform
  // for the LaTeX parser; generated output still passes through DOMPurify.
  const text = token.text.replace(/&lt;/g, '<')
  try {
    return katex.renderToString(text, { displayMode: token.display, output: 'htmlAndMathml',
      throwOnError: true, trust: false, strict: 'error', maxExpand: 1000, maxSize: 20,
      macros: {} })
  } catch {
    return escapeHtml(token.raw.replace(/&lt;/g, '<'))
  }
}

const inline: TokenizerExtension = {
  name: 'mathInline', level: 'inline',
  start(src) {
    // Do not stop Markdown text at an embedded shell/currency marker (US$5).
    for (const m of src.matchAll(/\$|\\[([]/g)) {
      if (m.index! > 0 && /[\w\\]/.test(src[m.index! - 1]!)) continue
      if (mathToken(src.slice(m.index), false)) return m.index
    }
  },
  tokenizer(src) { return mathToken(src, false) },
}
const block: TokenizerExtension = {
  name: 'mathBlock', level: 'block',
  start(src) { const m = /(?:^|\n)(?=\$\$|\\\[)/.exec(src); return m ? m.index + m[0].length : undefined },
  tokenizer(src) { return mathToken(src, true) },
}

// An isolated parser avoids changing marked's global extension registry.
export const mathMarkdown = new Marked({ extensions: [
  { ...inline, renderer: token => renderMath(token as MathToken) },
  { ...block, renderer: token => renderMath(token as MathToken) },
] })
