import type { ReactNode } from 'react'
export const isMobile = false
export const isCompact = () => false
export const sheetGate = () => false
export function MaybePortal({ children }: { children: ReactNode }) { return <>{children}</> }
