// questionmentions.test.tsx — a question to the user reads like chat.
//
// USER 2026-10-28 20:32:37Z m5952056229d3: "also allow question bodies to
// have formstted msrkdown, latex, and mentionnlinks embedded" (docket
// question-cards-render-markdown-latex-and-mention). Question text and option
// descriptions use the chat transcript's renderer: md() for Markdown and
// KaTeX, then the RefMdBody pass for mention chips. That covers the open card
// (the desk, inbox, Attention view and docket all mount AskCard), its batch
// tabs, and the answered card in the transcript and the inbox. Option labels
// keep their inline rendering and get no chips, and a plain question renders
// exactly as before.
//
// Run: node tests/run.mjs questionmentions

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AskCard, InboxAskCard } from '../src/canvas/asks'
import { EventCard } from '../src/events/card'
import { fileBase } from '../src/api'
import { md } from '../src/canvas/shared'
import type { RefRoutes, RefWorld, ResolvedRef } from '../src/canvas/reflinks'
import type { AskInfo, TreePayload } from '../src/types'
import { inAct, mountView, StrictMode } from './harness'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ORG = 'orgtree'
const world: RefWorld = {
  org: ORG,
  agents: new Map([['alice', 'alice'], ['bob', 'bob']]),
  items: new Map([['ship-it', 'ship-it']]),
  docs: new Map([['release-plan', 'release-plan']]),
}
const routes = () => {
  const opened: ResolvedRef[] = []
  const refs: RefRoutes = { world, onOpen: (r) => { opened.push(r) } }
  return { refs, opened }
}

const FORMATTED = [
  '# Release plan',
  '',
  '- first ask @alice',
  '- then close @item:orgtree/ship-it',
  '',
  'Inline $x^2$ and a block:',
  '',
  '$$\\int_0^1 x\\,dx$$',
  '',
  'Read @doc:orgtree/release-plan first.',
].join('\n')
const TOKENS = ['@alice', '@item:orgtree/ship-it', '@doc:orgtree/release-plan']

const question = (text: string, options?: { label: string; description?: string }[]): AskInfo =>
  ({ id: 'q1', node: 'bob', kind: 'question', status: 'open', question: text, options }) as AskInfo

const mount = async (t: { after: (f: () => void) => void }, node: Parameters<typeof mountView>[0]) => {
  const view = await mountView(<StrictMode>{node}</StrictMode>, (e) => e)
  t.after(() => view.unmount())
  return view.el
}

/** the formatted body: Markdown and KaTeX (which md() drew before this
 *  change) and a ready chip for every mention (which it did not) */
function assertFormatted(body: Element | null, where: string) {
  assert.ok(body, `${where}: the question body is on screen`)
  assert.ok(body!.querySelector('h1'), `${where}: heading`)
  assert.ok(body!.querySelector('ul > li'), `${where}: list`)
  assert.ok(body!.querySelector('.katex-display'), `${where}: block math`)
  assert.ok(body!.querySelectorAll('.katex').length >= 2, `${where}: inline math`)
  for (const token of TOKENS) {
    const chip: Element | null = body!.querySelector(`[data-ref-token="${token}"]`)
    assert.ok(chip, `${where}: ${token} is a mention chip`)
    assert.equal(chip!.getAttribute('data-ref-outcome'), 'ready', `${where}: ${token} resolves`)
  }
}

test('§1 the open card renders its question with Markdown, LaTeX and live mention chips', async (t) => {
  const { refs } = routes()
  const el = await mount(t, <AskCard ask={question(FORMATTED)} slug={ORG} toast={() => {}} refs={refs} />)
  assertFormatted(el.querySelector('.ask-q'), 'open card')
})

test('§2 an option description takes chips and math; its label stays plain; a chip click '
  + 'opens the reference without picking the option', async (t) => {
  const { refs, opened } = routes()
  const ask = question('Who reviews it?', [
    { label: '@alice', description: 'pairs with @bob on $O(n)$ work' },
    { label: 'Nobody' }])
  const el = await mount(t, <AskCard ask={ask} slug={ORG} toast={() => {}} refs={refs} />)
  const label = el.querySelector('.ask-option-label') as HTMLElement
  assert.equal(label.querySelector('[data-ref-token]'), null, 'a label gets no chip')
  assert.equal(label.textContent, '@alice', 'the label reads as written')
  const desc = el.querySelector('.ask-option-description') as HTMLElement
  assert.ok(desc.querySelector('.katex'), 'description math renders')
  const chip = desc.querySelector('[data-ref-token="@bob"]') as HTMLElement | null
  assert.ok(chip, 'the description mention is a chip')
  await inAct(() => { chip!.click() })
  assert.deepEqual(opened.map((r) => r.token), ['@bob'], 'the chip opened its reference')
  const row = desc.closest('.ask-row') as HTMLElement
  assert.equal(row.classList.contains('on'), false, 'and did not pick the option')
  assert.equal(el.querySelector('.ask-submit')!.hasAttribute('disabled'), true, 'nothing is ready to submit')
  // the shared chip pass builds no control inside a button (two destinations
  // in one target), so the description sits beside the option's pick button
  assert.equal(desc.closest('button'), null, 'the description is not inside a button')
  const pick = row.querySelector('.ask-row-pick') as HTMLButtonElement | null
  assert.equal(pick?.tagName, 'BUTTON', 'the option is picked by a real button')
  assert.ok(pick!.contains(label), 'holding the label')
  assert.equal(pick!.getAttribute('aria-pressed'), 'false')
  assert.ok(desc.id, 'the description has an id')
  assert.equal(pick!.getAttribute('aria-describedby'), desc.id, 'and describes the button')
  await inAct(() => { desc.click() })
  assert.equal(row.classList.contains('on'), true, 'the rest of the row still picks, as the whole row did')
  assert.equal(pick!.getAttribute('aria-pressed'), 'true')
  assert.deepEqual(opened.map((r) => r.token), ['@bob'], 'and opened nothing')
})

test('§2b the pick button picks once per click, and the other rows stay buttons', async (t) => {
  const ask = question('Which?', [{ label: 'One', description: 'the first' }, { label: 'Two' }])
  const el = await mount(t, <AskCard ask={ask} slug={ORG} toast={() => {}} refs={routes().refs} />)
  const [one] = [...el.querySelectorAll('.ask-row')] as HTMLElement[]
  const pick = one!.querySelector('.ask-row-pick') as HTMLButtonElement | null
  assert.ok(pick, 'the option has a pick button')
  await inAct(() => { pick!.click() })
  assert.equal(one!.classList.contains('on'), true, 'one click picks')
  await inAct(() => { pick!.click() })
  assert.equal(one!.classList.contains('on'), false, 'the next unpicks: the row did not also toggle')
  const other = [...el.querySelectorAll('.ask-row')].find((r) => r.textContent?.trim() === 'Other')
  assert.equal(other?.tagName, 'BUTTON', 'Other is still one button')
})

test('§3 CONTROL: a plain question renders exactly the HTML it did before', async (t) => {
  const text = 'Which branch should this target?'
  const { refs } = routes()
  const ask = question(text, [{ label: 'Main', description: 'the default branch' }, { label: 'Integ' }])
  const el = await mount(t, <AskCard ask={ask} slug={ORG} toast={() => {}} refs={refs} />)
  const body = el.querySelector('.ask-q') as HTMLElement
  assert.equal(body.tagName, 'DIV')
  assert.equal(body.className, 'ask-q md')
  assert.equal(body.innerHTML, md(text, fileBase(ORG, 'bob')).__html)
  const desc = el.querySelector('.ask-option-description') as HTMLElement
  assert.equal(desc.tagName, 'SPAN')
  assert.equal(desc.className, 'dim ask-option-description')
  assert.equal(desc.innerHTML, 'the default branch')
  assert.equal(el.querySelector('[data-ref-token]'), null, 'no chips in plain prose')
})

test('§4 CONTROL: a surface without link context leaves every mention as written text', async (t) => {
  const el = await mount(t, <AskCard ask={question(FORMATTED)} slug={ORG} toast={() => {}} />)
  const body = el.querySelector('.ask-q') as HTMLElement
  assert.ok(body.querySelector('h1') && body.querySelector('.katex-display'), 'still formatted')
  assert.equal(body.querySelector('[data-ref-token]'), null, 'but no chips')
  assert.match(body.textContent ?? '', /@item:orgtree\/ship-it/)
})

test('§5 a question tab of a batch card renders the same way', async (t) => {
  const { refs } = routes()
  const ask = { id: 'b1', node: 'bob', kind: 'batch', status: 'open', revs: { ask: 1 },
    tabs: [{ kind: 'question', question: FORMATTED, options: [{ label: 'Go', description: 'with @alice' }] },
      { kind: 'question', question: 'Second?' }] } as unknown as AskInfo
  const el = await mount(t, <AskCard ask={ask} slug={ORG} toast={() => {}} refs={refs} />)
  assertFormatted(el.querySelector('.ask-q'), 'batch tab')
  assert.ok(el.querySelector('.ask-option-description [data-ref-token="@alice"]'), 'description chip')
})

test('§6 the inbox and Attention card passes its routes to the card', async (t) => {
  const { refs } = routes()
  const tree = { roots: [], max_top_grant: 1000 } as unknown as TreePayload
  const el = await mount(t, <InboxAskCard ask={question(FORMATTED)} slug={ORG} tree={tree}
    toast={() => {}} refs={refs} />)
  assertFormatted(el.querySelector('.ask-q'), 'inbox card')
})

const answered = (q: string, description: string) => ({ v: 1, variant: 'answer.ask',
  actor: { kind: 'user', id: '@user' }, engine_authored: true,
  object: { kind: 'ask', org: ORG, id: 'a1', node: 'bob' },
  questions: [{ label: 'Plan', question: q, selected: ['Go'], options: [{ label: 'Go', description }], multi: false }],
  text: null, dismissed: false, single: true })

test('§7 the answered card in the transcript renders the question the same way', async (t) => {
  const { refs } = routes()
  const el = await mount(t, <EventCard org={ORG} profile="operator" row={{ ev: answered(FORMATTED, 'with @alice') }}
    world={refs.world} onOpen={refs.onOpen} />)
  assertFormatted(el.querySelector('.answered-qtext'), 'answered card')
  assert.ok(el.querySelector('.answered-opt-desc [data-ref-token="@alice"]'), 'description chip')
  assert.equal(el.querySelector('.answered-opt-label')!.textContent, 'Go', 'the label is unchanged')
})

test('§8 the inbox\'s resolved card renders the question the same way', async (t) => {
  const { refs } = routes()
  const ask = { ...question(FORMATTED, [{ label: 'Go', description: 'with @alice' }]),
    status: 'answered', answer: { selected: ['Go'], text: null } } as unknown as AskInfo
  const el = await mount(t, <AskCard ask={ask} slug={ORG} toast={() => {}} refs={refs} />)
  assertFormatted(el.querySelector('.answered-qtext'), 'resolved card')
  assert.ok(el.querySelector('.answered-opt-desc [data-ref-token="@alice"]'), 'description chip')
})

test('§9 CONTROL: a plain answered question keeps its inline look', async (t) => {
  const { refs } = routes()
  const el = await mount(t, <EventCard org={ORG} profile="operator" row={{ ev: answered('Pick one?', 'warm') }}
    world={refs.world} onOpen={refs.onOpen} />)
  const q = el.querySelector('.answered-qtext') as HTMLElement
  assert.equal(q.querySelector('p'), null, 'no paragraph box around plain text')
  assert.equal(q.querySelector('.answered-chip')!.textContent, 'Plan')
  assert.equal(q.textContent, 'PlanPick one?')
  const desc = el.querySelector('.answered-opt-desc') as HTMLElement
  assert.equal(desc.querySelector('p'), null)
  assert.equal(desc.textContent, 'warm')
})

// ── the row's look, from the stylesheet ─────────────────────────────────────
// An option row was one <button>, so contextual button rules reached it: the
// inbox, docket and Attention panels are `.settings` panels, and mobile has
// its own floor. The row is now a container, so it repeats exactly those
// declarations, and its pick button resets them (measured 2026-10-28: without
// this the inbox's option labels sat 7px 15px inside their own padding).
declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
const rule = (selector: string): Map<string, string> => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const at = css.search(new RegExp('(^|[}\\n])\\s*' + escaped + '\\s*\\{'))
  assert.ok(at >= 0, `styles.css has a rule for exactly "${selector}"`)
  // the match may begin at the previous rule's closing brace: read from this rule's own
  const open = css.indexOf('{', at)
  const body = css.slice(open + 1, css.indexOf('}', open))
  const declarations = new Map(body.split(';').map((d) => d.split(':').map((s) => s.trim())).filter((d) => d[0])
    .map(([k, ...v]) => [k!, v.join(':')]))
  assert.ok(declarations.size > 0, `the "${selector}" rule has declarations`)
  return declarations
}

test('§10 an option row repeats the contextual button rules the single button had, and its pick button resets them', () => {
  for (const [button, row] of [['.settings button', '.settings div.ask-row'], ['html.mobile button', 'html.mobile div.ask-row']]) {
    assert.deepEqual([...rule(row!)].sort(), [...rule(button!)].sort(), `${row} repeats ${button}`)
  }
  const pick = rule('.ask-row .ask-row-pick')
  for (const [k, v] of [['padding', '0'], ['min-height', '0'], ['font', 'inherit'], ['border', 'none'], ['background', 'none']]) {
    assert.equal(pick.get(k!), v, `the pick button resets ${k}`)
  }
})
