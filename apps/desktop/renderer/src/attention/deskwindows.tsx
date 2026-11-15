// attention/deskwindows.tsx — ATTENTION DESKS IN WINDOWS OF THEIR OWN (4.6.1, red stub).
import type { ReactNode } from 'react'
import type { AgentDeskPanelProps } from './AgentDeskPanel'

export interface AttentionDeskWindow { id: string; agent: string | null }

export function attentionDeskWindows(_slug: string): AttentionDeskWindow[] { return [] }
export function openAttentionDeskWindow(_slug: string, _agent: string | null): string { return '' }
export function forgetAttentionDeskWindows(): void {}

export function AttentionDeskWindows(_props: Omit<AgentDeskPanelProps, 'eligible' | 'claim' | 'attentionDraft'>): ReactNode {
  return null
}
