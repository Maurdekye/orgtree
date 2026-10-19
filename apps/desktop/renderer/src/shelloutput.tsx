import { createContext } from 'react'
export interface ShellOutputFrame { turn_started_at: string; revision: number; tools: { id: string; text: string; truncated: boolean }[] }
export const ShellOutputContext = createContext<ShellOutputFrame | null>(null)
export function acceptShellOutput(current: ShellOutputFrame | null | undefined, _incoming: unknown, _turn?: string | null): ShellOutputFrame | null { return current ?? null }
