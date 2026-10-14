import { req } from './api'
import type { OpRequest, OpResult } from './types'
import type { HistoryDirection } from './undokeys'

export type HistoryKind = 'move' | 'hire' | 'retire' | 'retool'
export interface HistoryEntryRef { id: number; kind: HistoryKind; label: string }
export interface HistoryTarget extends HistoryEntryRef { at: string; confirm_required?: boolean }
export interface HistoryRow extends HistoryEntryRef { at: string; state: 'done' | 'undone' | 'refused'; reason?: string }
export interface UserHistory { bound: number; undo: HistoryTarget | null; redo: HistoryTarget | null; entries: HistoryRow[] }
export interface HistoryRecorded { history_entry?: HistoryEntryRef; duplicate?: boolean }
export interface HistoryApplied { status: 'undone' | 'redone'; id: number; label: string; history: UserHistory }
export interface HistoryConfirm { status: 'confirm'; id: number; label: string; agent: string; turns: number; confirm: string; history: UserHistory }
export interface HistoryRefused { code: 'history_empty' | 'history_moved' | 'history_conflict'; id?: number; label?: string; reason?: string; history: UserHistory }
export type HistoryAnswer = HistoryApplied | HistoryConfirm | HistoryRefused
const base = (slug: string) => `/api/orgs/${encodeURIComponent(slug)}`

export const getUserHistory = (slug: string): Promise<UserHistory> => req(base(slug) + '/history')
export const applyUserHistory = (slug: string, direction: HistoryDirection, id: number, confirm?: string): Promise<HistoryAnswer> =>
  req(base(slug) + '/history/' + direction, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...(confirm ? { confirm } : {}) }),
  }, undefined, [404, 409])

/** One ID per deliberate submission; retries reuse the same ID. */
export const historyRequestId = (): string => crypto.randomUUID()
export const userGesture = (slug: string, steps: (OpRequest | Record<string, unknown>)[], label: string,
  request_id: string = historyRequestId()): Promise<{ results?: OpResult[] } & HistoryRecorded> =>
  req(base(slug) + '/gesture', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps, label, request_id }),
  })
