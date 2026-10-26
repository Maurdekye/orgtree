import { createContext, useCallback, useContext, useLayoutEffect, useState } from 'react'
import type { ReactNode } from 'react'

const DeskRegistration = createContext<(() => () => void) | null>(null)
const NamesAllowed = createContext(true)

/** One canvas owns its desks, including React-portal window surfaces. A desk
 * takes far-zoom name plates out of the reveal path, not merely below its
 * z-index. Normal-card plates remain available (USER 2026-10-26). */
export function CardNameRevealProvider({ children }: { children: ReactNode }) {
  const [desks, setDesks] = useState(0)
  const register = useCallback(() => {
    setDesks(count => count + 1)
    return () => setDesks(count => count - 1)
  }, [])
  return <DeskRegistration.Provider value={register}>
    <NamesAllowed.Provider value={desks === 0}>{children}</NamesAllowed.Provider>
  </DeskRegistration.Provider>
}

export function useDeskNamePlateGuard() {
  const register = useContext(DeskRegistration)
  useLayoutEffect(() => register?.(), [register])
}

export const useCardNamesAllowed = () => useContext(NamesAllowed)
