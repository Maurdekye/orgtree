import { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type { MenuEntry } from './contextmenu'
import { objectTooltipProps, registerObjectNativeTooltipDocument } from './objecttooltip'

export type ObjectKind = 'ticket' | 'watchdog' | 'document' | 'mail' | 'panel'
export const OBJECT_NAV_ATTR = 'data-object-nav'
export const OBJECT_ID_ATTR = 'data-object-id'
export const OBJECT_ORG_ATTR = 'data-object-org'
export type ObjectNavMenu = (kind: ObjectKind, id: string, org: string | null, anchor: Element) => MenuEntry[] | Promise<MenuEntry[]>
const Ctx = createContext<{ current: ObjectNavMenu | null; org: string | null; openUserInbox?: () => void } | null>(null)
export function ObjectNavProvider({ children }: { children: ReactNode }) {
  const inherited = useContext(Ctx)
  const reg = useRef<{ current: ObjectNavMenu | null; org: string | null; openUserInbox?: () => void }>({ current: null, org: null })
  const own = useMemo(() => reg.current, [])
  useEffect(() => {
    if (!inherited) return registerObjectNativeTooltipDocument(document, () => own.org)
  }, [inherited, own])
  return <Ctx.Provider value={inherited ?? own}>{children}</Ctx.Provider>
}
export function useProvideObjectNav(build: ObjectNavMenu | null, org: string, openUserInbox?: () => void) {
  const reg = useContext(Ctx)
  if (reg) { reg.current = build; reg.org = org; reg.openUserInbox = openUserInbox }
}
export function useObjectNavRegistry() { return useContext(Ctx) }
export function objectNavElementAt(target: EventTarget | null, within?: Element): Element | null {
  const el = (target as Element | null)?.closest?.(`[${OBJECT_NAV_ATTR}]`)
  return el && (!within || within.contains(el)) ? el : null
}
export function objectNavProps(kind: ObjectKind, id: string, org?: string) {
  return { [OBJECT_NAV_ATTR]: kind, [OBJECT_ID_ATTR]: id, [OBJECT_ORG_ATTR]: org,
    ...(kind === 'ticket' || kind === 'document' ? objectTooltipProps(kind, id, org) : {}) }
}
