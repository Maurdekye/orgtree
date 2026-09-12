import type { DesktopNotification } from './index'

export const NOTIFICATION_OPTIONS = [
  { key: 'notifyQuestions', label: 'Questions', default: true },
  { key: 'notifyUrgentMail', label: 'Urgent mail', default: true },
  { key: 'notifyTerminalFailures', label: 'Terminal failures', default: true },
  { key: 'notifyDocketAttention', label: 'Docket attention', default: true },
  { key: 'notifyAllMail', label: 'All mail', default: false },
  { key: 'notifyDocuments', label: 'New presented document', default: false },
  { key: 'notifyFrozen', label: 'Agent frozen', default: false },
  { key: 'notifyWhileFocused', label: 'Notify while Orgtree is focused', default: false },
] as const
export type NotificationPreferenceKey = typeof NOTIFICATION_OPTIONS[number]['key']
export type NotificationPreferences = Record<NotificationPreferenceKey, boolean> & {
  notificationsEnabled: boolean
}
export const DEFAULT_NOTIFICATIONS: NotificationPreferences = {
  notificationsEnabled: true,
  ...(Object.fromEntries(NOTIFICATION_OPTIONS.map(o => [o.key, o.default])) as Record<NotificationPreferenceKey, boolean>),
}

/** Old installs keep an explicit routine-mail opt-in; absent new fields always
 * receive their defaults, including the new foreground suppression policy. */
export function notificationPreferences(value: Partial<NotificationPreferences> & { routineNotifications?: boolean } = {}): NotificationPreferences {
  const result: NotificationPreferences = { ...DEFAULT_NOTIFICATIONS }
  if (typeof value.notificationsEnabled === 'boolean') result.notificationsEnabled = value.notificationsEnabled
  for (const { key } of NOTIFICATION_OPTIONS) if (typeof value[key] === 'boolean') result[key] = value[key]!
  if (value.notifyAllMail === undefined && value.routineNotifications === true) result.notifyAllMail = true
  return result
}
export function notificationEnabled(kind: DesktopNotification['kind'], prefs: NotificationPreferences): boolean {
  if (!prefs.notificationsEnabled) return false
  switch (kind) {
    case 'question': return prefs.notifyQuestions
    case 'urgent-mail': return prefs.notifyUrgentMail || prefs.notifyAllMail
    case 'terminal-failure': return prefs.notifyTerminalFailures !== false
    case 'work-attention': return prefs.notifyDocketAttention
    case 'routine': return prefs.notifyAllMail
    case 'document': return prefs.notifyDocuments
    case 'agent-frozen': return prefs.notifyFrozen
    default: return false
  }
}
