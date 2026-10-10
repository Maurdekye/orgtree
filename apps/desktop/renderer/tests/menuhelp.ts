// menuhelp.ts — read a context menu whose entries live in submenus (Open ▸, Hire a subordinate ▸, …).
// The app opens one submenu at a time on hover, so a test that wants "every entry" has to walk them:
// `surveyMenu()` hovers each branch in turn and remembers what it held; `flatLabels()` is the top-level entries
// with each branch's children listed right after it; `openBranchOf(label)` hovers the branch that holds `label`
// so the ordinary click helpers can find it.
import { inAct } from './harness'

const W = window as unknown as Window & typeof globalThis
const top = () => [...document.querySelectorAll('.ctxmenu:not(.ctxmenu-submenu) > .ctxmenu-branch')] as HTMLElement[]
const text = (b: Element | null) => (b?.querySelector('[role="menuitem"]')?.textContent ?? '')
const bare = (s: string) => s.replace(/\s*▸$/, '')
const held = new Map<string, string[]>()

export async function surveyMenu(): Promise<void> {
  held.clear()
  for (const branch of top()) {
    const button = branch.querySelector('[role="menuitem"]')
    if (button?.getAttribute('aria-haspopup') !== 'menu') continue
    await inAct(() => { branch.dispatchEvent(new W.MouseEvent('mouseover', { bubbles: true })) })
    held.set(bare(text(branch)), [...branch.querySelectorAll('.ctxmenu-submenu [role="menuitem"]')].map((b) => b.textContent ?? ''))
    await inAct(() => { branch.dispatchEvent(new W.MouseEvent('mouseout', { bubbles: true })) })
  }
}

/** the model list under "Hire a subordinate ▸" depends on what the machine offers, so it is not listed */
const UNLISTED = ['Hire a subordinate']

/** top-level entries, each branch followed by its children (indented with "· ") */
export function flatLabels(): string[] {
  const out: string[] = []
  for (const branch of top()) {
    const label = text(branch)
    out.push(label)
    if (UNLISTED.includes(bare(label))) continue
    for (const child of held.get(bare(label)) ?? []) out.push('· ' + child)
  }
  return out
}

/** hover the branch holding `label` (a no-op for a top-level entry) */
export async function openBranchOf(label: string): Promise<void> {
  for (const [parent, kids] of held) {
    if (!kids.includes(label)) continue
    const branch = top().find((b) => bare(text(b)) === parent)
    if (branch) await inAct(() => { branch.dispatchEvent(new W.MouseEvent('mouseover', { bubbles: true })) })
    return
  }
}

/** entries that used to be top-level and are now one level down, under their branch (old label → [branch, entry]) */
export const MOVED: Record<string, [string, string]> = {
  'Dissolve suborganization…': ['Dissolve…', 'subtree'],
  'Retire all subordinates…': ['Dissolve…', 'all subordinates'],
  'Cheap-compact subtree…': ['Cheap compact…', 'subtree'],
}

/** click `child` inside the open `branch` submenu */
export async function pickIn(branch: string, child: string): Promise<void> {
  const b = top().find((x) => bare(text(x)) === bare(branch))
  if (!b) throw new Error(`no menu branch "${branch}"`)
  await inAct(() => { b.dispatchEvent(new W.MouseEvent('mouseover', { bubbles: true })) })
  const item = [...b.querySelectorAll('.ctxmenu-submenu [role="menuitem"]')].find((x) => x.textContent === child) as HTMLButtonElement | undefined
  if (!item) throw new Error(`no "${child}" under "${branch}"`)
  await inAct(() => {
    item.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    item.click()
  })
}
