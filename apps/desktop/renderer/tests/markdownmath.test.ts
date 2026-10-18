import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { md } from '../src/canvas/shared'
import { linkifyRefs } from '../src/canvas/refmd'

const body = (source: string, doc = document) => {
  const host = doc.createElement('div')
  host.innerHTML = md(source).__html
  return host
}
for (const [name, source, display] of [
  ['dollar inline', '$x^2 + y^2$', false],
  ['parenthesis inline', String.raw`\(\frac{a}{b}\)`, false],
  ['dollar display', String.raw`$$\sum_{n=1}^{10} n$$`, true],
  ['bracket display', String.raw`\[\int_0^1 x\,dx\]`, true],
] as const) test(name + ' renders accessible offline math', () => {
  const host = body(source)
  assert.equal(host.querySelectorAll('.katex').length, 1)
  assert.equal(!!host.querySelector('.katex-display'), display)
  assert.equal(host.querySelector('annotation')?.textContent, source.slice(display ? 2 : source[0] === '$' ? 1 : 2, display ? -2 : source[0] === '$' ? -1 : -2))
  assert.ok(host.querySelector('math'), 'MathML accessibility is missing')
})

test('display math accepts multiline alignment without Markdown eating underscores', () => {
  const source = String.raw`Before

\[
\begin{aligned}
a_1 &= b_2 \\
c_3 &= d_4
\end{aligned}
\]

After`
  const host = body(source)
  assert.equal(host.querySelectorAll('.katex-display').length, 1)
  assert.ok(host.textContent?.includes('Before') && host.textContent.includes('After'))
  assert.equal(host.querySelectorAll('em').length, 0)
})

test('math shares paragraphs, Markdown lists, emphasis and link labels', () => {
  const host = body('- **Result:** $x_1$ and [formula $y^2$](https://example.com)')
  assert.equal(host.querySelectorAll('.katex').length, 2)
  assert.equal(host.querySelector('strong')?.textContent, 'Result:')
  assert.equal(host.querySelector('a')?.getAttribute('href'), 'https://example.com')
})

test('currency, escaped dollars and ambiguous spacing remain ordinary text', () => {
  for (const source of ['$5 and $10', '$5-$10', 'US$5, CAD$10', '$  x$ and $x  $', String.raw`\$x\$`, 'a $5 fee, then $x$']) {
    const host = body(source)
    assert.equal(host.querySelectorAll('.katex').length, source.endsWith('$x$') ? 1 : 0, source)
    if (source.startsWith('$5')) assert.equal(host.textContent?.trim(), source)
  }
})

test('shell variables and command substitution stay literal', () => {
  for (const source of ['echo $HOME and $PATH', 'echo $HOME/$PATH', 'echo ${HOME}:${PATH}', 'echo $(pwd) and $USER', '$FOO$BAR']) {
    const host = body(source)
    assert.equal(host.querySelectorAll('.katex').length, 0, source)
    assert.equal(host.textContent?.trim(), source)
  }
})

test('inline, multi-backtick, fenced and indented code never render math', () => {
  for (const source of ['`$x$`', '`` $x$ ` \\(y\\) ``', '```tex\n$$x$$\n\\[y\\]\n```', '    $x$\n    \\(y\\)']) {
    const host = body(source)
    assert.equal(host.querySelectorAll('.katex').length, 0, source)
    assert.ok(host.querySelector('code'))
  }
})

test('invalid and unfinished LaTeX preserve source without breaking surrounding Markdown', () => {
  for (const source of [String.raw`$\frac{$`, String.raw`\(\notARealCommand{x}\)`, String.raw`$$\begin{missing}x\end{missing}$$`]) {
    const host = body(source)
    assert.equal(host.querySelectorAll('.katex').length, 0)
    assert.equal(host.textContent?.trim(), source)
  }
  assert.equal(body('unfinished $x and **bold**').querySelector('strong')?.textContent, 'bold')
})

test('less-than math and invalid HTML-looking input remain safe', () => {
  const host = body('$a < b$ and ' + String.raw`\(\bad{<img src=x onerror=alert(1)>}\)`)
  assert.equal(host.querySelectorAll('.katex').length, 1)
  assert.equal(host.querySelectorAll('img,script,[onerror]').length, 0)
  assert.equal(host.querySelector('annotation')?.textContent, 'a < b')
  assert.ok(host.textContent?.includes('<img src=x onerror=alert(1)>'))
})

test('references decorate normal prose but never duplicate or mutate math internals', () => {
  const host = body(String.raw`@helper $\text{@helper}$ @user [link](https://example.com)`)
  const before = host.querySelector('.katex')?.outerHTML
  assert.ok(before, 'missing formula control')
  const world = { org: 'test', agents: new Map([['helper', { id: 'helper', name: 'helper', tier: 'sol', state: 'live' }]]), items: new Map(), docs: new Map() } as any
  linkifyRefs(host, world, false)
  assert.equal(host.querySelector('.katex')?.outerHTML, before)
  assert.ok(host.querySelector('[data-ref-token="@helper"]'))
  assert.equal(host.querySelector('a')?.getAttribute('href'), 'https://example.com')
  assert.ok(host.textContent?.includes('@user'))
})

test('a separately owned document receives the same complete math markup', () => {
  const doc = document.implementation.createHTMLDocument('synthetic pop-out')
  const host = body(String.raw`\[\sqrt{2}\]`, doc)
  doc.body.append(host)
  assert.equal(host.ownerDocument, doc)
  assert.equal(host.querySelectorAll('.katex').length, 1)
  assert.ok(host.querySelector('math'))
})

test('untrusted commands cannot create links or network media and macros are request-local', () => {
  const host = body(String.raw`$\href{https://example.com}{x}$ $\includegraphics{https://example.com/a.png}$`)
  assert.equal(host.querySelectorAll('a,img,iframe').length, 0)
  body(String.raw`$\gdef\secret{42}\secret$`)
  const later = String.raw`$\secret$`
  assert.equal(body(later).textContent?.trim(), later)
})
