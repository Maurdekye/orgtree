import type { DesktopPreferences } from '../../../packages/contracts'

type EpicPrefs = Pick<DesktopPreferences, 'epicMode' | 'epicMuted'>

/** Kept in the native menu, hidden while EPIC is off, so an open menu can
 * follow preference broadcasts without replacing the menu under the pointer. */
export function epicMuteTrayItem(prefs: EpicPrefs, save: (patch: Partial<DesktopPreferences>) => unknown): Electron.MenuItemConstructorOptions {
  return { id: 'epic-mute', label: 'Mute EPIC sounds', type: 'checkbox',
    visible: prefs.epicMode === true, checked: prefs.epicMuted === true,
    click: item => { save({ epicMuted: item.checked }) } }
}

export function refreshTrayEpic(menu: Pick<Electron.Menu, 'getMenuItemById'> | undefined, prefs: EpicPrefs): void {
  const item = menu?.getMenuItemById('epic-mute')
  if (item) { item.visible = prefs.epicMode === true; item.checked = prefs.epicMuted === true }
}
