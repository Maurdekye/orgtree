import { createContext, useContext, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type { MenuEntry } from './contextmenu'

export type ObjectKind = 'ticket' | 'watchdog'
export const OBJECT_NAV_ATTR = 'data-object-nav'
export const OBJECT_ID_ATTR = 'data-object-id'
export const OBJECT_ORG_ATTR = 'data-object-org'
export type ObjectNavMenu = (kind: ObjectKind, id: string, org: string | null, anchor: Element) => MenuEntry[] | Promise<MenuEntry[]>
const Ctx = createContext<{ current: ObjectNavMenu | null; org: string | null } | null>(null)
export function ObjectNavProvider({ children }: { children: ReactNode }) {
  const inherited = useContext(Ctx)
  const reg = useRef<{ current: ObjectNavMenu | null; org: string | null }>({ current: null, org: null })
  const own = useMemo(() => reg.current, [])
  return <Ctx.Provider value={inherited ?? own}>{children}</Ctx.Provider>
}
export function useProvideObjectNav(build: ObjectNavMenu | null, org: string) {
  const reg = useContext(Ctx)
  if (reg) { reg.current = build; reg.org = org }
}
export function useObjectNavRegistry() { return useContext(Ctx) }
export function objectNavElementAt(target: EventTarget | null, within?: Element): Element | null {
  const el = (target as Element | null)?.closest?.(`[${OBJECT_NAV_ATTR}]`)
  return el && (!within || within.contains(el)) ? el : null
}
export function objectNavProps(kind: ObjectKind, id: string, org?: string) {
  return { [OBJECT_NAV_ATTR]: kind, [OBJECT_ID_ATTR]: id, [OBJECT_ORG_ATTR]: org }
}
