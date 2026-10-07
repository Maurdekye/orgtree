import { useAppValue } from './appfeed'
import { isMobile } from './mobile'
import { composerKeyHint, composerSendKey, type EnterKeyBehavior } from './composerkeys'

/** The app socket seeds this at startup and pushes changes to every open window. */
export function useComposerEnter() {
  const value = useAppValue<EnterKeyBehavior>('enter_key_behavior')
  const behavior: EnterKeyBehavior = value === 'newline' ? 'newline' : 'send'
  return { behavior, hint: composerKeyHint(behavior, isMobile),
    sends: (e: Parameters<typeof composerSendKey>[0]) => composerSendKey(e, behavior, isMobile) }
}
