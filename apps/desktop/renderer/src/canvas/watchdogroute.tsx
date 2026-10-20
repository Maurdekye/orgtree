import { createContext, useContext } from 'react'
import type { Watchdog } from '../types'
import type { SlotLease } from './slots'

export interface DeskDogs {
  org?: string
  dogs: Watchdog[]
  counts?: Record<string, import('./watchdoggroup').WatchdogCount>
  slotLeases?: SlotLease[]
  open: (id: string) => void
}
const Ctx = createContext<DeskDogs | null>(null)
export const DeskDogsProvider = Ctx.Provider
export function useDogRoute(): DeskDogs | null { return useContext(Ctx) }
