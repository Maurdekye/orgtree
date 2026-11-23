// portable.test.tsx: Export, Import and Duplicate of a node, as a window offers them
// (docs/rust-engine/agent-export.md). USER 2026-11-23 mb05f4fda0d92: "a context menu option on
// agents / projects for import / export"; m3c072bcdc19a: nothing is stripped unless the app
// setting is ticked, and a manual export warns when it found secrets; importing is done from a
// node's context menu, under that node; m2106530cca00 and m36ba89488717: grants that do not fit
// are clamped by a default strategy the dialog shows and lets the user change.
//
// Run:  node tests/run.mjs portable
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import type { CanvasNode } from '../src/canvas/shared'
import { PortablePanel } from '../src/canvas/portable'
import {
  creditText, estimateText, exportFileUrl, forgetPortable, nodesText, openPortable, overLimit, planRow, portableNeedsUpdate, portableOpen, portableUpdateText,
  resultText, secretLines, secretPlaces, sizeText,
} from '../src/portable'
import type { Estimate, ExportResult, ImportResult, Job, Plan, PlanNode, SecretsReport, SendRequest } from '../src/portable'
import { useRemoteHere } from '../src/remotehere'
import { remoteFeed, remoteView } from './remotefeed.fixture'

const noop = () => {}
const agent = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, state: 'live', tier: 'sonnet', children: [], ...extra } as CanvasNode)
const labels = (node: CanvasNode, handlers: Parameters<typeof agentMenuEntries>[1]) =>
  agentMenuEntries(node, handlers).filter((e) => e !== 'sep').map((e) => (e as { label: string }).label)

const REPORT: SecretsReport = {
  stripped: false, detected: 5, kinds: { 'password or key': 3, 'private key': 1, 'watchdog credentials': 1 },
  places: ['transcript of lead', 'scratch folder of lead', 'scratch folder of worker', 'mail of lead', 'documents of lead', 'watchdogs of lead', 'settings of lead', 'uploads of lead']
    .map((place) => ({ place, kinds: {} })),
  files: ['nodes/0001-lead/scratch/.env'], files_more: 0, left_out: [], left_out_more: 0, not_scanned: [], not_scanned_more: 0, watchdog_credentials: 1,
}
const node = (was: string, name: string, extra: Partial<PlanNode> = {}): PlanNode =>
  ({ was, name, parent: null, kind: 'agent', tier: 'opus', retired: false, retired_why: null, account: 'primary', seat: 4, grant: 20, saved_grant: 20, warnings: [], ...extra })
const plan = (extra: Partial<Plan> = {}): Plan => ({
  nodes: [node('lead', 'lead-2'), node('A', 'A', { parent: 'lead-2', tier: 'sonnet', seat: 2, grant: 5, saved_grant: 5 })],
  agents: 2, projects: 0, retired: 0, renamed: [{ from: 'lead', to: 'lead-2' }], cost: 24, full_cost: 24, seats_cost: 6, available: null,
  shrunk_by: null, strategy: 'bottom-up', default_strategy: 'bottom-up', warnings: 0, refusal: null, ok: true, digest: 'digest-1', ...extra,
})

test('sizes, counts and credits in words', () => {
  assert.deepEqual([0, 1536, 5 * 1024 * 1024, 3 * 1024 ** 3].map(sizeText), ['0 B', '1.5 KB', '5.0 MB', '3.0 GB'])
  assert.equal(nodesText({ agents: 3, projects: 1, retired: 2 }), '3 agents, 1 project and 2 retired')
  assert.equal(nodesText({ agents: 1, projects: 0, retired: 0 }), '1 agent')
  assert.equal(nodesText({ agents: 0, projects: 0, retired: 0 }), 'nothing')
  const estimate: Estimate = { nodes: 4, agents: 3, projects: 1, retired: 0, bytes: { scratch: 400, team: 100, transcript: 24, documents: 0, total: 524 }, limit: 1000, strip_secrets: false }
  assert.equal(estimateText(estimate), '3 agents and 1 project, about 524 B before it is packed.')
  assert.equal(overLimit(estimate), false)
  assert.equal(overLimit({ ...estimate, limit: 500 }), true)
  // what an export found: the most frequent kind first, and the places cut short
  assert.deepEqual(secretLines(REPORT), ['3 × password or key', '1 × private key', '1 × watchdog credentials'])
  assert.deepEqual(secretLines({ ...REPORT, kinds: {}, watchdog_credentials: 2 }), ['2 × watchdog credentials'])
  assert.deepEqual(secretPlaces(REPORT).slice(-2), ['watchdogs of lead', 'and 2 more places'])
  assert.deepEqual(secretPlaces({ ...REPORT, places: REPORT.places.slice(0, 2) }), ['transcript of lead', 'scratch folder of lead'])
  // credits
  assert.equal(creditText(plan(), 'boss'), 'It costs 24 credits under boss.')
  assert.equal(creditText(plan({ available: 30 }), null), 'It costs 24 credits at the top level, of 30 that can be drawn there.')
  assert.equal(creditText(plan({ cost: 14, available: 14, shrunk_by: 'bottom-up' }), 'boss'),
    'It costs 14 credits under boss, of 14 that can be drawn there. With the saved grants it would cost 24, so spare credits were taken away.')
  assert.equal(creditText(plan({ cost: 0 }), 'boss'), 'It costs no credits under boss: everything in it arrives retired.')
  assert.equal(creditText(plan({ cost: 1 }), 'boss'), 'It costs 1 credit under boss.')
  // one node of the list
  assert.equal(planRow(node('lead', 'lead-2')), 'lead → lead-2 · opus · grant 20')
  assert.equal(planRow(node('A', 'A', { grant: 0, saved_grant: 5 })), 'A · opus · grant 0 (was 5)')
  assert.equal(planRow(node('B', 'B', { retired: true })), 'B · opus · retired')
  assert.equal(planRow(node('P', 'P-2', { kind: 'project', tier: 'project' })), 'P → P-2 · project')
  const done = { root: 'lead-2', nodes: ['lead-2', 'A', 'B'] } as ImportResult
  assert.equal(resultText(done, false), 'Imported: lead-2 and 2 nodes under it.')
  assert.equal(resultText({ ...done, nodes: ['lead-2'] }, true), 'Copied: lead-2.')
  assert.equal(exportFileUrl('my org', 'x1'), '/api/orgs/my%20org/exports/x1/file')
})

test('an engine older than 4.7.0 cannot do it, and a version nobody can read says nothing', () => {
  for (const older of ['4.6.9', '4.6.9-alpha.2', '3.9.0']) assert.equal(portableNeedsUpdate(older), true, older)
  for (const fine of ['4.7.0', '4.7.0-alpha.1', '4.8.2', '5.0.0', '', null, undefined, 'dev']) assert.equal(portableNeedsUpdate(fine), false, String(fine))
})

test('a window on a remote engine older than 4.7.0 is told so by the entry, and that engine is asked nothing', async (t) => {
  assert.equal(portableUpdateText('Galaxy', '4.6.9'), 'Orgtree on Galaxy needs updating to export, import and duplicate: it runs 4.6.9, and that needs 4.7.0 or later.')
  assert.equal(portableUpdateText('Galaxy', null), 'Orgtree on Galaxy needs updating to export, import and duplicate, which needs 4.7.0 or later.')
  forgetPortable()
  const calls: string[] = []
  const feed = remoteFeed(t, (url) => { calls.push(url); return new Response(JSON.stringify({ detail: 'not asked' }), { status: 500 }) })
  const toasts: string[][] = []
  // the window's own feed, as the app keeps it open: the panel reads the connection when an entry is chosen
  const Here = () => { useRemoteHere(); return null }
  const view = await mountView(<><Here /><PortablePanel toast={(lines) => { toasts.push(lines) }} /></>, (el) => el)
  t.after(async () => { await view.unmount(); forgetPortable() })
  const older = remoteView({ version: '4.6.9', app_version: '4.7.0' })
  await feed.remotes([older], older)
  await inAct(async () => { openPortable({ kind: 'export', org: 'org', node: 'lead' }); await flush() })
  assert.equal(portableOpen(), null, 'nothing stays open')
  assert.equal(document.querySelector('.portable'), null)
  assert.deepEqual(toasts, [['Orgtree on Galaxy needs updating to export, import and duplicate: it runs 4.6.9, and that needs 4.7.0 or later.']])
  assert.deepEqual(calls, [], 'and the other engine is asked nothing')
  // the same engine once it runs 4.7.0: the dialog opens and asks for its estimate
  const current = remoteView({ version: '4.7.0', app_version: '4.7.0' })
  await feed.remotes([current], current)
  await inAct(async () => { openPortable({ kind: 'export', org: 'org', node: 'lead' }); await flush() })
  assert.notEqual(portableOpen(), null)
  assert.ok(calls.some((url) => url.includes('/api/orgs/org/nodes/lead/export-estimate')), calls.join(' '))
  assert.equal(toasts.length, 1)
})

test('the menu of an agent and of a project offers Export, Import here and Duplicate', () => {
  const asked: [string, boolean][] = []
  const handlers = { onInbox: noop, onSettings: noop, onRetireAsk: noop, onPortable: (kind: string, hasTeam: boolean) => { asked.push([kind, hasTeam]) } }
  const lead = agent('lead', { children: [agent('kid')] })
  const menu = agentMenuEntries(lead, handlers)
  const names = menu.filter((e) => e !== 'sep').map((e) => (e as { label: string }).label)
  const at = names.indexOf('Export…')
  assert.deepEqual(names.slice(at, at + 3), ['Export…', 'Import here…', 'Duplicate…'])
  assert.ok(at > names.indexOf('Settings') && at < names.indexOf('Dissolve…'), 'its own group, before the ones that stop or retire')
  for (const label of ['Export…', 'Import here…', 'Duplicate…']) (menu.find((e) => e !== 'sep' && e.label === label) as { onSelect: () => void }).onSelect()
  assert.deepEqual(asked, [['export', true], ['import', true], ['duplicate', true]])
  // an agent with nobody under it says so, and the dialog offers no "and everything under it"
  asked.length = 0
  ;(agentMenuEntries(agent('solo'), handlers).find((e) => e !== 'sep' && e.label === 'Export…') as { onSelect: () => void }).onSelect()
  assert.deepEqual(asked, [['export', false]])
  // a retired node can still be exported; nothing is imported under it and it is not copied
  const retired = labels(agent('old', { state: 'archived' }), handlers)
  assert.equal(retired.includes('Export…'), true)
  assert.equal(retired.includes('Import here…') || retired.includes('Duplicate…'), false)
  // a project has the same three
  const project = labels(agent('work', { kind: 'project', children: [agent('kid')] }), handlers)
  for (const label of ['Export…', 'Import here…', 'Duplicate…']) assert.equal(project.includes(label), true, label)
  // a surface that cannot show the dialogs passes nothing, and the entries are not there
  assert.equal(labels(lead, { onInbox: noop, onSettings: noop }).some((label) => /Export|Import|Duplicate/.test(label)), false)
})

// ---------------------------------------------------------------- the dialogs

interface Call { method: string; path: string; body: unknown }

class FakeSend {
  static sent: { url: string; body: unknown; request: FakeSend }[] = []
  upload: SendRequest['upload'] = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  status = 0
  responseText = ''
  private url = ''
  open(_method: string, url: string) { this.url = url }
  send(body: unknown) { FakeSend.sent.push({ url: this.url, body, request: this }) }
  abort() { this.onabort?.() }
  answer(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.() }
}

/** A window whose engine answers `answer`; `calls` is what it was asked. */
async function panel(t: TestContext, answer: (call: Call) => unknown) {
  forgetPortable()
  FakeSend.sent = []
  useFakeClock()
  const calls: Call[] = []
  const globals = globalThis as unknown as { fetch: unknown; XMLHttpRequest?: unknown }
  const old = { fetch: globals.fetch, xhr: globals.XMLHttpRequest }
  globals.fetch = async (input: unknown, init?: RequestInit) => {
    const at = new URL(String(input), 'http://app')
    const call = { method: init?.method ?? 'GET', path: at.pathname + at.search, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined }
    calls.push(call)
    const value = answer(call)
    if (value instanceof Response) return value
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
  }
  globals.XMLHttpRequest = FakeSend
  const toasts: string[][] = []
  const view = await mountView(<PortablePanel toast={(lines) => { if (lines) toasts.push(lines) }} />, (el) => el)
  t.after(async () => {
    await view.unmount()
    forgetPortable()
    realClock()
    globals.fetch = old.fetch
    globals.XMLHttpRequest = old.xhr
  })
  return { calls, toasts }
}

const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const all = <T extends Element = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)]
const button = (text: string) => all<HTMLButtonElement>('.portable button').find((b) => b.textContent?.trim().startsWith(text))
const click = (el: Element | null | undefined) => inAct(async () => { assert.ok(el, 'the control is there'); (el as HTMLElement).click(); await flush() })
const text = () => q('.portable')?.textContent ?? ''
const open = (ask: Parameters<typeof openPortable>[0]) => inAct(async () => { openPortable(ask); await flush() })
const job = <R,>(state: Job<R>['state'], extra: Partial<Job<R>> = {}): Job<R> =>
  ({ id: 'x1', kind: 'export', state, step: 'reading the nodes', nodes: 1, total: 3, bytes: 2048, name: 'lead-team.orgtree.zip', ...extra })
const ESTIMATE: Estimate = { nodes: 3, agents: 3, projects: 0, retired: 0, bytes: { scratch: 4096, team: 0, transcript: 1024, documents: 0, total: 5120 }, limit: 256 * 1024 ** 3, strip_secrets: false }
const EXPORTED: ExportResult = { root: 'lead', subtree: true, counts: { agents: 3, projects: 0, retired: 0, files: 12 }, unpacked_bytes: 5120, file_bytes: 2048,
  secrets: REPORT, not_included: ['nodes/0001-lead/scratch/link (a link, which is not followed)'] }

test('an export is measured, started, read until it ends, and held for the user when it found secrets', async (t) => {
  let state: Job<ExportResult> = job('running')
  const { calls, toasts } = await panel(t, (call) => {
    if (call.path.includes('/export-estimate')) return ESTIMATE
    if (call.method === 'POST' && call.path.endsWith('/nodes/lead/export')) return state
    if (call.method === 'POST' && call.path.endsWith('/confirm')) { state = job('done', { result: EXPORTED }); return state }
    if (call.method === 'DELETE') return { removed: true }
    return state
  })
  await open({ kind: 'export', org: 'org', node: 'lead', hasTeam: true })
  assert.equal(calls[0]!.path, '/api/orgs/org/nodes/lead/export-estimate?subtree=true&retired=false', 'with a team under it, the team is the first offer')
  assert.match(text(), /3 agents, about 5\.0 KB before it is packed\./)
  const strip = all<HTMLInputElement>('.portable-tick input').find((input) => input.parentElement?.textContent?.includes('Take detected secrets out'))!
  assert.equal(strip.checked, false, 'as the app setting says: nothing is taken out')
  // only the agent: measured again, and no team folders to take
  await click(all<HTMLInputElement>('.portable-scope input')[0])
  assert.equal(calls.at(-1)!.path, '/api/orgs/org/nodes/lead/export-estimate?subtree=false&retired=false')
  assert.equal(text().includes('Team folders'), false)
  await click(all<HTMLInputElement>('.portable-scope input')[1])
  await click(button('Export'))
  const started = calls.find((call) => call.method === 'POST')!
  assert.deepEqual(started.body, { subtree: true, include: { scratch: true, team: true, transcript: true, native_sessions: true, retired: false }, strip: false })
  assert.match(text(), /reading the nodes….*1 of 3 nodes, 2\.0 KB/)
  // it found secrets and took none out: the file is not offered before the user has seen them
  state = job('confirm', { result: EXPORTED })
  await advance(800)
  assert.match(q('.portable-found')!.textContent!, /This export holds secrets, and nothing was taken out\./)
  assert.deepEqual(all('.portable-found li').map((li) => li.textContent), ['3 × password or key', '1 × private key', '1 × watchdog credentials'])
  assert.match(q('.portable-found')!.textContent!, /The credentials of 1 watchdog are in the file/)
  assert.equal(q('.portable-save'), null)
  await click(button('Keep them in the file'))
  assert.equal(calls.at(-1)!.path, '/api/orgs/org/exports/x1/confirm')
  const save = q<HTMLAnchorElement>('.portable-save')!
  assert.equal(save.getAttribute('href'), '/api/orgs/org/exports/x1/file')
  assert.equal(save.getAttribute('download'), 'lead-team.orgtree.zip')
  assert.match(text(), /Ready: 3 agents, 2\.0 KB\./)
  assert.match(text(), /1 thing is not in it/)
  await click(save)
  assert.deepEqual(toasts.at(-1), ['Saving lead-team.orgtree.zip'])
  // closing lets the engine's copy go
  await click(button('Done'))
  assert.deepEqual([calls.at(-1)!.method, calls.at(-1)!.path], ['DELETE', '/api/orgs/org/exports/x1'])
  assert.equal(portableOpen(), null)
})

test('an export that found secrets can be made again without them', async (t) => {
  let made = 0
  const { calls } = await panel(t, (call) => {
    if (call.path.includes('/export-estimate')) return { ...ESTIMATE, strip_secrets: false }
    if (call.method === 'POST' && call.path.endsWith('/export')) { made++; return made === 1 ? job('confirm', { result: EXPORTED }) : job('done', { id: 'x2', result: { ...EXPORTED, secrets: { ...REPORT, stripped: true } } }) }
    return { removed: true }
  })
  await open({ kind: 'export', org: 'org', node: 'lead' })
  assert.equal(q('.portable-scope'), null, 'nobody under it: nothing to choose')
  await click(button('Export'))
  await click(button('Export again without them'))
  const posts = calls.filter((call) => call.method === 'POST')
  assert.deepEqual(posts.map((call) => (call.body as { strip: boolean }).strip), [false, true])
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.path.endsWith('/exports/x1')), 'the first file is dropped')
  assert.match(text(), /5 detected secrets were taken out\./)
  assert.equal(q<HTMLAnchorElement>('.portable-save')!.getAttribute('href'), '/api/orgs/org/exports/x2/file')
})

test('an import sends the file, shows the plan, and creates only what was shown', async (t) => {
  const facts = { orgtree_version: '4.7.0', exported_at: '2026-11-23T20:40:00Z', root: 'lead', subtree: true, from: { organization: 'Other org', by: 'user' },
    counts: { agents: 2, projects: 0, retired: 0, files: 9 }, unpacked_bytes: 5120, file_bytes: 2048, secrets: { stripped: false, detected: 2, watchdog_credentials: 0 },
    foreign: true, watchdogs: 1, audiences: 0, left_out: [] }
  const short = plan({ file: facts, cost: 14, available: 14, shrunk_by: 'bottom-up', nodes: [
    node('lead', 'lead-2', { grant: 10, warnings: ['grant shrunk from 20 to 10 to fit the credits there are', 'tools switched off, as boss does not hold them: bash'] }),
    node('A', 'A', { parent: 'lead-2', tier: 'gone', retired: true, retired_why: 'this computer cannot staff gone now; rehire it on another model', grant: 0, saved_grant: 5 })] })
  const result: ImportResult = { root: 'lead-2', nodes: ['lead-2', 'A'], plan: short, audiences: 0, watchdogs: { created: 1, armed: 0, paused: 1, notes: [] },
    notes: [], leftovers: ['A: its team folder could not be written'], held: [], sessions_carried: 1, complete: false, history_entry: { id: 7, kind: 'import', label: 'Import lead-2 and its team' } }
  let status: Job<ImportResult> = job('running', { kind: 'import', id: 'x9', step: 'creating the nodes' })
  const { calls, toasts } = await panel(t, (call) => {
    if (call.path.endsWith('/plan')) return { ...short, strategy: (call.body as { strategy?: string }).strategy ?? 'bottom-up', digest: `digest-${(call.body as { strategy?: string }).strategy ?? 'default'}` }
    if (call.path.endsWith('/apply')) return status
    if (call.method === 'DELETE') return { removed: true }
    return status
  })
  await open({ kind: 'import', org: 'org', node: 'boss' })
  assert.equal(q('[role="dialog"] h3')?.textContent, 'Import under boss')
  const input = q<HTMLInputElement>('.portable input[type=file]')!
  const file = new window.File(['zip'], 'lead-team.orgtree.zip') as unknown as File
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await inAct(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); await flush() })
  assert.equal(FakeSend.sent[0]!.url, '/api/orgs/org/imports/upload?name=lead-team.orgtree.zip')
  assert.equal(FakeSend.sent[0]!.body, file, 'the file itself, never read into the page')
  assert.equal(button('Import')!.disabled, true, 'nothing to import before there is a plan')
  await inAct(async () => { FakeSend.sent[0]!.request.answer(200, { id: 'x9', bytes: 3 }); await flush() })
  assert.deepEqual(calls[0], { method: 'POST', path: '/api/orgs/org/imports/x9/plan', body: { dest: 'boss' } })
  // where it came from, and that it is another computer's
  assert.match(text(), /From Other org, exported .* by user with Orgtree 4\.7\.0: 5\.0 KB unpacked\./)
  assert.match(q('.portable [role="alert"]')!.textContent!, /made on another computer, or was changed since it was made/)
  assert.match(text(), /2 secrets were detected when it was exported and left in the file\./)
  // the plan: names, grants, what comes in retired and why, and each change on the way in
  assert.deepEqual(all('.portable-nodes > li > span:first-child').map((el) => el.textContent), ['lead → lead-2 · opus · grant 10 (was 20)', 'A · gone · retired'])
  assert.match(text(), /this computer cannot staff gone now/)
  assert.deepEqual(all('.portable-warnings li').map((li) => li.textContent), ['grant shrunk from 20 to 10 to fit the credits there are', 'tools switched off, as boss does not hold them: bash'])
  assert.match(text(), /It costs 14 credits under boss, of 14 that can be drawn there\. With the saved grants it would cost 24/)
  // the strategy is the app's own first, and choosing another plans again
  const strategy = q<HTMLSelectElement>('.portable-strategy select')!
  assert.equal(strategy.value, 'bottom-up')
  await inAct(async () => { strategy.value = 'even'; strategy.dispatchEvent(new window.Event('change', { bubbles: true })); await flush() })
  assert.deepEqual(calls.at(-1)!.body, { dest: 'boss', strategy: 'even' })
  // watchdogs stay paused unless asked
  await click(all<HTMLInputElement>('.portable-tick input').find((el) => el.parentElement?.textContent?.includes('Arm the watchdogs')))
  await click(button('Import'))
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/api/orgs/org/imports/x9/apply', body: { dest: 'boss', strategy: 'even', expect: 'digest-even', resume_watchdogs: true } })
  assert.match(text(), /creating the nodes…/)
  status = job('done', { kind: 'import', id: 'x9', result })
  await advance(800)
  assert.match(text(), /Imported: lead-2 and 1 node under it\..*Undo takes it back\./)
  assert.match(text(), /Some parts could not be brought in:A: its team folder could not be written/)
  assert.deepEqual(toasts.at(-1), ['Imported: lead-2 and 1 node under it.'])
  // the file was imported: closing has nothing of the engine's to drop
  const before = calls.length
  await click(button('Done'))
  assert.equal(calls.slice(before).some((call) => call.method === 'DELETE'), false)
})

test('an import that cannot be made says why and offers no Import', async (t) => {
  const { calls } = await panel(t, (call) => call.path.endsWith('/plan')
    ? plan({ ok: false, refusal: 'the seats alone cost 8 credits and 7 can be drawn under boss; no strategy can make it fit', available: 7 })
    : { removed: true })
  await open({ kind: 'import', org: 'org', node: null })
  assert.equal(q('[role="dialog"] h3')?.textContent, 'Import')
  const input = q<HTMLInputElement>('.portable input[type=file]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [new window.File(['zip'], 'a.zip')] })
  await inAct(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); await flush() })
  await inAct(async () => { FakeSend.sent[0]!.request.answer(200, { id: 'x3' }); await flush() })
  assert.deepEqual(calls[0]!.body, { dest: null }, 'the top level')
  assert.match(text(), /the seats alone cost 8 credits and 7 can be drawn under boss/)
  assert.equal(button('Import')!.disabled, true)
  // closing drops the file that was sent up
  await click(button('Cancel'))
  assert.deepEqual([calls.at(-1)!.method, calls.at(-1)!.path], ['DELETE', '/api/orgs/org/imports/x3'])
})

test('a file the engine refuses is said, and nothing is left behind', async (t) => {
  const { calls } = await panel(t, () => ({ removed: true }))
  await open({ kind: 'import', org: 'org', node: 'boss' })
  const input = q<HTMLInputElement>('.portable input[type=file]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [new window.File(['x'], 'notes.zip')] })
  await inAct(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); await flush() })
  await inAct(async () => { FakeSend.sent[0]!.request.answer(413, { detail: 'An export holds at most 256 GiB.' }); await flush() })
  assert.match(q('.portable [role="alert"]')!.textContent!, /An export holds at most 256 GiB\./)
  assert.equal(calls.length, 0)
})

test('a duplicate shows its plan first and copies what was shown', async (t) => {
  const shown = plan({ nodes: [node('lead', 'lead-2', { parent: 'boss' })], agents: 1 })
  const result = { root: 'lead-2', nodes: ['lead-2'], plan: shown, audiences: 0, watchdogs: { created: 0, armed: 0, paused: 0, notes: [] }, notes: [], leftovers: [], held: [],
    sessions_carried: 0, complete: true } as ImportResult
  let status: Job<ImportResult> = job('running', { kind: 'duplicate', id: 'x5', step: 'copying' })
  const { calls, toasts } = await panel(t, (call) => {
    if (call.method === 'POST' && (call.body as { preview?: boolean }).preview) return { ...shown, digest: `digest-${(call.body as { subtree: boolean }).subtree}` }
    if (call.method === 'POST') return status
    return status
  })
  await open({ kind: 'duplicate', org: 'org', node: 'lead', hasTeam: true })
  assert.deepEqual(calls[0], { method: 'POST', path: '/api/orgs/org/nodes/lead/duplicate', body: { subtree: true, preview: true } })
  assert.match(text(), /Its docket items, its cost history and its mail are not copied\./)
  assert.match(text(), /1 agent will be created\. It costs 24 credits under boss\./)
  await click(all<HTMLInputElement>('.portable-scope input')[0])
  assert.deepEqual(calls.at(-1)!.body, { subtree: false, preview: true })
  await click(button('Duplicate'))
  assert.deepEqual(calls.at(-1)!.body, { subtree: false, strategy: 'bottom-up', expect: 'digest-false' })
  status = job('done', { kind: 'duplicate', id: 'x5', result })
  await advance(800)
  assert.equal(calls.at(-1)!.path, '/api/orgs/org/imports/x5', 'a copy is read as an import is')
  assert.match(text(), /Copied: lead-2\./)
  assert.deepEqual(toasts.at(-1), ['Copied: lead-2.'])
})
