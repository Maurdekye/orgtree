/** Independent of OS notification categories and foreground suppression. */
export const ACTIVITY_SOUND_OPTIONS = [
  { key: 'responseSound', label: 'Response sound', hint: 'Play a short tone when any agent finishes a response.' },
  { key: 'taskSound', label: 'Task completion sound', hint: 'Play a different tone when an agent reports done or a docket item is completed.' },
] as const
export type ActivitySoundKind = 'response' | 'task'
export type ActivitySoundPreferences = Record<typeof ACTIVITY_SOUND_OPTIONS[number]['key'], boolean>
export const DEFAULT_ACTIVITY_SOUNDS: ActivitySoundPreferences = { responseSound: true, taskSound: true }
export function activitySoundPreferences(value: Partial<ActivitySoundPreferences> = {}): ActivitySoundPreferences {
  return { responseSound: value.responseSound ?? true, taskSound: value.taskSound ?? true }
}
export type ActivitySoundFrame = { type: 'activity_sound'; epoch: string; seq: number
  kind: ActivitySoundKind; org_id: number; id: string }
export function isActivitySound(value: unknown): value is ActivitySoundFrame {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<ActivitySoundFrame>
  return v.type === 'activity_sound' && (v.kind === 'response' || v.kind === 'task')
    && typeof v.epoch === 'string' && v.epoch.length > 0 && v.epoch.length <= 200
    && Number.isSafeInteger(v.seq) && v.seq! >= 0
    && Number.isSafeInteger(v.org_id) && v.org_id! > 0
    && typeof v.id === 'string' && v.id.length > 0 && v.id.length <= 200
}
