// portable.ts — exporting a node to a file, importing a file under a node, and copying a node
// inside its organization: what a window asks the engine, and the words it shows
// (docs/rust-engine/agent-export.md, "Jobs, routes and tools").
//
// The three are opened from a node's context menu (canvas/agentmenu.tsx) and from the canvas's
// own menu, and shown by one panel mounted once per window (canvas/portable.tsx).
//
// - An EXPORT is a job on the engine: it is started, read until it has ended, and its file is
//   then saved through a plain link, as every other file of the app is. When it found secrets
//   and took none out, the engine holds the file until the user has seen what was found.
// - An IMPORT sends the file up first, asks for the plan, and only then creates anything. The
//   plan carries a digest; the import is refused when the plan has changed since.
// - A DUPLICATE needs no file: the plan, then the copy, read as an import is.
import { useSyncExternalStore } from 'react'
import { req } from './api'
import type { HistoryEntryRef } from './historyapi'

export type PortableKind = 'export' | 'import' | 'duplicate'

/** What the panel is opened on. `node` is null for an import at the top level. */
export interface PortableAsk { kind: PortableKind; org: string; node: string | null; project?: boolean; hasTeam?: boolean }

export type Strategy = 'bottom-up' | 'top-down' | 'even'
export const STRATEGIES: readonly { value: Strategy; label: string; hint: string }[] = [
  { value: 'bottom-up', label: 'From the bottom up', hint: 'Spare credits are taken from the lowest agents first, then the ones above them.' },
  { value: 'top-down', label: 'From the top down', hint: 'Spare credits are taken from the topmost agent first, then the ones below it.' },
  { value: 'even', label: 'Evenly', hint: 'One credit from each agent in turn, until it fits.' },
]

export interface Include { scratch: boolean; team: boolean; transcript: boolean; native_sessions: boolean; retired: boolean }
export const INCLUDE_ALL: Include = { scratch: true, team: true, transcript: true, native_sessions: true, retired: false }

export interface Estimate {
  nodes: number; agents: number; projects: number; retired: number
  bytes: { scratch: number; team: number; transcript: number; documents: number; total: number }
  limit: number; strip_secrets: boolean
}

export interface SecretsReport {
  stripped: boolean; detected: number; kinds: Record<string, number>
  places: { place: string; kinds: Record<string, number> }[]
  files: string[]; files_more: number; left_out: string[]; left_out_more: number
  not_scanned: string[]; not_scanned_more: number; watchdog_credentials: number
}

export interface ExportResult {
  root: string; subtree: boolean; counts: { agents: number; projects: number; retired: number; files: number }
  unpacked_bytes: number; file_bytes: number; secrets: SecretsReport; not_included: string[]
}

export interface PlanNode {
  was: string; name: string; parent: string | null; kind: 'agent' | 'project'; tier: string; retired: boolean; retired_why: string | null
  account: string | null; seat: number; grant: number; saved_grant: number; warnings: string[]
}

export interface FileFacts {
  orgtree_version: string; exported_at: string; root: string; subtree: boolean
  from: { organization: string; by: string }
  counts: { agents: number; projects: number; retired: number; files: number }
  unpacked_bytes: number; file_bytes: number
  secrets: { stripped: boolean; detected: number; watchdog_credentials: number }
  foreign: boolean; watchdogs: number; audiences: number; left_out: string[]
}

export interface Plan {
  nodes: PlanNode[]; agents: number; projects: number; retired: number
  renamed: { from: string; to: string }[]
  cost: number; full_cost: number; seats_cost: number; available: number | null
  shrunk_by: Strategy | null; strategy: Strategy | null; default_strategy: Strategy
  warnings: number; refusal: string | null; ok: boolean; digest: string
  file?: FileFacts
}

export interface ImportResult {
  root: string; nodes: string[]; plan: Plan; audiences: number
  watchdogs: { created: number; armed: number; paused: number; notes: string[] }
  notes: string[]; leftovers: string[]; held: string[]; sessions_carried: number; complete: boolean
  history_entry?: HistoryEntryRef
}

export interface Job<R> {
  id: string; kind: PortableKind; state: 'running' | 'confirm' | 'done' | 'failed'
  step: string; nodes: number; total: number; bytes: number; bytes_total?: number
  result?: R; error?: string; refused?: boolean; name: string
}

// ---------------------------------------------------------------- which one is open

let asked: PortableAsk | null = null
const listeners = new Set<() => void>()
const tell = () => { for (const listener of listeners) listener() }
export function openPortable(ask: PortableAsk): void { asked = ask; tell() }
export function closePortable(): void { if (asked) { asked = null; tell() } }
export const portableOpen = (): PortableAsk | null => asked
export const usePortableAsk = (): PortableAsk | null =>
  useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, portableOpen, portableOpen)

// ---------------------------------------------------------------- what is asked of the engine

const org = (slug: string): string => `/api/orgs/${encodeURIComponent(slug)}`
const node = (slug: string, name: string): string => `${org(slug)}/nodes/${encodeURIComponent(name)}`
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
/** A plan reads the whole file's index; an export's first answer waits for nothing. */
const SLOW = 120_000

export const exportEstimate = (slug: string, name: string, subtree: boolean, retired: boolean): Promise<Estimate> =>
  req(`${node(slug, name)}/export-estimate?subtree=${subtree}&retired=${retired}`, undefined, SLOW)
export const startExport = (slug: string, name: string, body: { subtree: boolean; include: Include; strip: boolean }): Promise<Job<ExportResult>> =>
  req(`${node(slug, name)}/export`, json('POST', body))
export const exportStatus = (slug: string, id: string): Promise<Job<ExportResult>> => req(`${org(slug)}/exports/${encodeURIComponent(id)}`)
export const confirmExport = (slug: string, id: string): Promise<Job<ExportResult>> => req(`${org(slug)}/exports/${encodeURIComponent(id)}/confirm`, { method: 'POST' })
export const forgetExport = (slug: string, id: string): Promise<unknown> => req(`${org(slug)}/exports/${encodeURIComponent(id)}`, { method: 'DELETE' })
/** The address the finished export is saved from. */
export const exportFileUrl = (slug: string, id: string): string => `${org(slug)}/exports/${encodeURIComponent(id)}/file`

export interface ImportChoice { dest: string | null; strategy?: Strategy; expect?: string; resume_watchdogs?: boolean }
export const planImport = (slug: string, id: string, choice: ImportChoice): Promise<Plan> =>
  req(`${org(slug)}/imports/${encodeURIComponent(id)}/plan`, json('POST', choice), SLOW)
export const applyImport = (slug: string, id: string, choice: ImportChoice): Promise<Job<ImportResult>> =>
  req(`${org(slug)}/imports/${encodeURIComponent(id)}/apply`, json('POST', choice), SLOW)
export const importStatus = (slug: string, id: string): Promise<Job<ImportResult>> => req(`${org(slug)}/imports/${encodeURIComponent(id)}`)
export const forgetImport = (slug: string, id: string): Promise<unknown> => req(`${org(slug)}/imports/${encodeURIComponent(id)}`, { method: 'DELETE' })

export interface DuplicateChoice { subtree: boolean; strategy?: Strategy; expect?: string }
export const planDuplicate = (slug: string, name: string, choice: DuplicateChoice): Promise<Plan> =>
  req(`${node(slug, name)}/duplicate`, json('POST', { ...choice, preview: true }), SLOW)
export const startDuplicate = (slug: string, name: string, choice: DuplicateChoice): Promise<Job<ImportResult>> =>
  req(`${node(slug, name)}/duplicate`, json('POST', choice), SLOW)

/** The request a file is sent up with: what tells how much of it has gone (remotefiles.ts). */
export type SendRequest = Pick<XMLHttpRequest, 'open' | 'send' | 'abort' | 'status' | 'responseText'> & {
  upload: { onprogress: ((event: { loaded: number; total: number }) => void) | null }
  onload: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null
}

/** Send an export file up for an import. `progress` hears how much has gone; the answer is the
 *  job's id, and `stop` ends the sending. */
export function sendImportFile(slug: string, file: File, progress: (sent: number) => void,
  make: () => SendRequest = () => new XMLHttpRequest() as unknown as SendRequest): { done: Promise<string>; stop: () => void } {
  const request = make()
  const done = new Promise<string>((resolve, reject) => {
    request.upload.onprogress = (event) => progress(event.loaded)
    request.onload = () => {
      let parsed: { id?: unknown; detail?: unknown } = {}
      try { parsed = JSON.parse(request.responseText) as typeof parsed } catch { /* not JSON: the status says it */ }
      if (request.status >= 200 && request.status < 300 && typeof parsed.id === 'string') resolve(parsed.id)
      else reject(Object.assign(new Error(typeof parsed.detail === 'string' && parsed.detail ? parsed.detail : `The file was refused (${request.status}).`), { status: request.status }))
    }
    request.onerror = () => reject(new Error('Sending the file broke off. Nothing was imported.'))
    request.onabort = () => reject(Object.assign(new Error('Stopped. Nothing was imported.'), { stopped: true }))
    request.open('PUT', `${org(slug)}/imports/upload?name=${encodeURIComponent(file.name)}`)
    request.send(file)
  })
  return { done, stop: () => request.abort() }
}

// ---------------------------------------------------------------- words

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const credits = (n: number): string => Number.isInteger(n) ? String(n) : n.toFixed(2)

/** "3 agents, 1 project and 2 retired agents". */
export function nodesText(c: { agents: number; projects: number; retired: number }): string {
  const parts = [c.agents ? count(c.agents, 'agent') : '', c.projects ? count(c.projects, 'project') : '', c.retired ? `${c.retired} retired` : ''].filter(Boolean)
  if (parts.length === 0) return 'nothing'
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** What an estimate comes to, in one line. */
export const estimateText = (e: Estimate): string =>
  `${nodesText(e)}, about ${sizeText(e.bytes.total)} before it is packed.`

/** Is the estimate over what one export may hold? */
export const overLimit = (e: Estimate): boolean => e.bytes.total > e.limit

/** What an export found, one line per kind, the most frequent first. */
export function secretLines(report: SecretsReport): string[] {
  const lines = Object.entries(report.kinds).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([kind, n]) => `${n} × ${kind}`)
  if (report.watchdog_credentials > 0 && !lines.some((line) => line.includes('watchdog'))) lines.push(`${report.watchdog_credentials} × watchdog credentials`)
  return lines
}

/** Where they were found: the first few places, then how many more. */
export function secretPlaces(report: SecretsReport, most = 6): string[] {
  const places = report.places.map((p) => p.place)
  return places.length > most ? [...places.slice(0, most), `and ${places.length - most} more places`] : places
}

/** The credits of a plan, in words. */
export function creditText(plan: Plan, dest: string | null): string {
  const where = dest ? `under ${dest}` : 'at the top level'
  if (plan.cost === 0) return `It costs no credits ${where}: everything in it arrives retired.`
  const base = `It costs ${credits(plan.cost)} ${plan.cost === 1 ? 'credit' : 'credits'} ${where}`
  const room = plan.available === null ? '' : `, of ${credits(plan.available)} that can be drawn there`
  if (!plan.shrunk_by) return `${base}${room}.`
  return `${base}${room}. With the saved grants it would cost ${credits(plan.full_cost)}, so spare credits were taken away.`
}

/** One node of a plan, as the list shows it: "lead → lead-2 · opus · grant 12 (was 20)". */
export function planRow(node: PlanNode): string {
  const name = node.was === node.name ? node.name : `${node.was} → ${node.name}`
  if (node.kind === 'project') return `${name} · project${node.retired ? ' · retired' : ''}`
  const grant = node.retired ? 'retired' : node.grant === node.saved_grant ? `grant ${credits(node.grant)}` : `grant ${credits(node.grant)} (was ${credits(node.saved_grant)})`
  return `${name} · ${node.tier} · ${grant}`
}

/** What a finished import or copy says first. */
export function resultText(result: ImportResult, copy: boolean): string {
  const others = result.nodes.length - 1
  const what = others > 0 ? `${result.root} and ${count(others, 'node')} under it` : result.root
  return `${copy ? 'Copied' : 'Imported'}: ${what}.`
}

/** The first Orgtree whose engine can export, import and duplicate. */
const SINCE = [4, 7, 0] as const

/** Does the engine's version say it cannot do this? Asked before anything is sent, with the
 *  version a remote organization's engine gave when this computer connected. A version that
 *  cannot be read says nothing. */
export const portableNeedsUpdate = (version: string | null | undefined): boolean => {
  const numbers = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version ?? '')?.slice(1).map(Number)
  if (!numbers) return false
  for (let i = 0; i < SINCE.length; i++) if (numbers[i] !== SINCE[i]) return numbers[i]! < SINCE[i]!
  return false
}

/** What the window says of a remote engine that cannot do it, as the Files entry does of one that cannot list a
 *  folder (`filesUpdateText` in remotefiles.ts): the entries stay, and say so when they are chosen. */
export const portableUpdateText = (name: string, version: string | null | undefined): string =>
  `Orgtree on ${name} needs updating to export, import and duplicate${version ? `: it runs ${version}, and that needs` : ', which needs'} ${SINCE.join('.')} or later.`

/** Tests only. */
export function forgetPortable(): void { asked = null; tell() }
