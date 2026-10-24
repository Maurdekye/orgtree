// shell/defaults.tsx — the default-org-settings FIELDS, with no window of
// their own.
//
// The settled v3 layout puts "Default org settings" inside App settings as a
// tab. Rendering the whole `DefaultsPanel` there would nest one modal frame
// inside another: two titled, pinnable, closable surfaces, whose Escape
// handlers fight each other. So the fields live here and both callers pour
// them into their own container — the App settings tab into a tab panel, and
// `DefaultsPanel` in App.tsx into the standalone window it has always had.
//
// It sits in shell/ rather than in App.tsx because canvas/accounts.tsx (the
// App settings panel) has to import it, and importing from App.tsx would make
// a cycle: App.tsx already imports AccountsPanel.
import { useEffect, useState } from 'react'
import { SettingsSaveStatus, settingNumber, useSettingsAutosave } from '../settingsautosave'
import type { SettingsRequest } from '../types'
import { getDefaults, saveDefaults } from '../api'
import { SetGroup, SetRow, SetToggle } from '../canvas/settingskit'
import { EffortBar } from '../canvas/effortbar'
import type { DefaultsPayload, ToastFn } from '../types'

/** The default-org-settings FIELDS, with no window of their own.
 *
 *  Extracted so App settings can carry them as a tab (the settled v3 layout)
 *  without nesting one modal frame inside another — the two would each draw a
 *  titled, pinnable, closable surface and the inner one's Escape would fight
 *  the outer one's. `DefaultsPanel` in App.tsx is the same fields inside the
 *  standalone window they have always had; both call `onDone` where the old
 *  code called `close`, so neither route changed behaviour. */
export function DefaultsForm({ toast, onDone }: {
  toast: ToastFn; onDone: () => void
}) {
  const [d, setD] = useState<Partial<DefaultsPayload> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true
    getDefaults().then(value => { if (live) { setD(value); setLoadError(null) } })
      .catch((e: Error) => { if (live) setLoadError(e.message) })
    return () => { live = false }
  }, [retry])
  const server = { max_top_grant: d?.max_top_grant ?? 1000,
    default_top_grant: d?.default_top_grant ?? 50, compact_at: Math.round((d?.compact_at ?? .8) * 100),
    default_effort: d?.default_effort ?? '', auto_resume: !!d?.auto_resume }
  const autosave = useSettingsAutosave('default-org-settings', server, async fields => {
    const body = { ...fields } as SettingsRequest
    if ('max_top_grant' in fields) body.max_top_grant = settingNumber(fields.max_top_grant, 1)
    if ('default_top_grant' in fields) body.default_top_grant = settingNumber(fields.default_top_grant, 0)
    if ('compact_at' in fields) body.compact_at = settingNumber(fields.compact_at, 50, 95)
    const saved = await saveDefaults(body)
    setD(saved)
    return {}
  }, toast)
  if (d == null) return loadError ? <div role="alert">Unable to load default org settings: {loadError}
    <button onClick={() => setRetry(n => n + 1)}>Retry</button></div> : <div className="dim pad">Loading…</div>
  const close = () => { void autosave.queue.flush().then(ok => { if (ok) onDone() }) }
  const value = autosave.value
  const set = (key: keyof typeof server, next: unknown) => autosave.set<unknown>(key, value<unknown>(key, server[key]),
    ['max_top_grant', 'default_top_grant', 'compact_at'].includes(key) ? 750 : 0)(next)
  return (
    <>
        {/* WHICH ORGS THIS APPLIES TO is the panel's most load-bearing
            sentence, and it used to live inside the h3 — where a pinned window
            hides it along with the duplicated heading. Outside it, visible in
            both modes (Astra 2026-09-06). */}
        <div className="dim modalpin-subtitle">Applied to every new
          organization</div>
        <SetGroup title="Credits">
          <SetRow label="Top-level grant cap">
            <input type="number" min="1" step="1" aria-label="Top-level grant cap"
              value={value<number | string>('max_top_grant', server.max_top_grant)}
              onChange={(e) => set('max_top_grant', e.target.value)} />
          </SetRow>
          <SetRow label="Default top-level grant" hint="Pre-filled on new hires">
            <input type="number" min="0" step="1" aria-label="Default top-level grant"
              value={value<number | string>('default_top_grant', server.default_top_grant)}
              onChange={(e) => set('default_top_grant', e.target.value)} />
          </SetRow>
        </SetGroup>
        <SetGroup title="Agents">
          <SetRow label="Compaction threshold %" hint="50–95">
            <input type="number" min="50" max="95" step="1" aria-label="Compaction threshold %"
              value={value<number | string>('compact_at', server.compact_at)}
              onChange={(e) => set('compact_at', e.target.value)} />
          </SetRow>
          <SetRow label="Default thinking effort"
            hint="Agents without their own effort use the org default. If neither sets a level, high is the fallback before harness/model mapping.">
            <EffortBar value={value('default_effort', server.default_effort)} level="" inheritLabel="Default (high fallback)"
              onSet={(v) => set('default_effort', v)} />
          </SetRow>
        </SetGroup>
        <SetGroup title="Usage limits">
          <SetToggle label="Auto-resume usage-limit-frozen agents after the reset time" checked={value('auto_resume', server.auto_resume)}
            hint="Resume agents automatically after their usage limit resets."
            onChange={next => set('auto_resume', next)} />
        </SetGroup>
        <div className="hint">
          These defaults apply only when creating an organization; existing
          organizations keep their own settings.
        </div>
        <SettingsSaveStatus status={autosave.status} retry={() => { void autosave.queue.flush(true) }} />
        <div className="row"><button aria-label="Close default org settings" onClick={close}>Close</button></div>

    </>
  )
}
