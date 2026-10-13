import type { MenuEntry } from './contextmenu'
import type { Watchdog, WorkItem } from '../types'

/** Canonical ticket actions. Surfaces supply their existing navigation/fold/copy routes. */
export function ticketActions({ item, selected, open, fold, owner, copySlug, copyReference }:
  { item: WorkItem; selected?: boolean; open: () => void;
    fold?: { kids: number; folded: boolean; toggle: () => void };
    owner?: { open: () => void; why?: string }; copySlug: () => void; copyReference?: () => void }): MenuEntry[] {
  const entries: MenuEntry[] = [{ label: selected ? 'Close details' : 'Open details', onSelect: open }]
  if (fold && fold.kids > 0) entries.push({
    label: `${fold.folded ? 'Show' : 'Hide'} ${fold.kids} sub-item${fold.kids === 1 ? '' : 's'}`, onSelect: fold.toggle })
  if (item.owner?.node && owner) entries.push({ label: `Open owner (${item.owner.node})`, title: owner.why, onSelect: owner.open })
  entries.push('sep', { label: 'Copy slug', onSelect: copySlug })
  if (copyReference) entries.push({ label: 'Copy reference', onSelect: copyReference })
  return entries
}

/** The same state gates and commands used by the watchdog detail buttons. */
export function watchdogActions(dog: Watchdog, act: (action: 'pause' | 'resume' | 'remove') => void): MenuEntry[] {
  if (dog.spent) return []
  return [dog.state === 'armed' ? { label: 'Pause', onSelect: () => act('pause') }
    : { label: dog.state === 'exited' ? 'Resume (re-spawn)' : 'Resume', onSelect: () => act('resume') },
    { label: 'Remove', danger: true, onSelect: () => act('remove') }]
}
