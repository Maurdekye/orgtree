// canvas/shortcutsettings.tsx — App settings → Keyboard shortcuts.
//
// A read-only reference (user 2026-10-14: an explainer, in Settings only; no
// rebinding). It draws shortcuts.ts, which a test keeps in step with the
// real bindings, so this page cannot list a key that does nothing or miss
// one that does.

import { Fragment } from 'react'
import { useComposerEnter } from '../enterkey'
import { isMacPlatform, keyCaps, shortcutGroups } from '../shortcuts'
import { SetGroup, SetRow } from './settingskit'

export function ShortcutsSettings({ mac = isMacPlatform() }: { mac?: boolean }) {
  const { behavior } = useComposerEnter()
  return <>
    {shortcutGroups(behavior).map(group => (
      <SetGroup key={group.title} title={group.title}>
        {group.items.map(item => (
          <SetRow key={item.action + item.keys.join()} label={item.action} hint={item.note}>
            <span className="kbd-combos">
              {item.keys.map((combo, i) => (
                <Fragment key={combo}>
                  {i > 0 && <span className="kbd-or" aria-hidden="true">/</span>}
                  <span className="kbd-combo">
                    {keyCaps(combo, mac).map((cap, j) => <kbd key={j}>{cap}</kbd>)}
                  </span>
                </Fragment>
              ))}
            </span>
          </SetRow>
        ))}
      </SetGroup>
    ))}
  </>
}
