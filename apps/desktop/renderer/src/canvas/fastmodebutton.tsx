import { useState } from 'react'
import type { ToastFn } from '../types'
import type { CanvasNode } from './shared'
import { saveScope } from '../api'
import { BoltIcon } from '../icons'
import { FAST_MODE_HELP, useFastMode } from './fastmode'

export function FastModeButton({ node, slug, toast }: { node: CanvasNode; slug: string; toast: ToastFn }) {
  const supported = useFastMode(node.tier, node.scope?.model_version)
  const [saving, setSaving] = useState(false)
  if (!supported || node.state !== 'live') return null
  const on = node.scope?.fast_mode === true
  const queued = node.busy === true && typeof node.fast_mode_current === 'boolean'
    && node.fast_mode_current !== on
  const button = <button className={'cc-fast' + (on || queued ? ' on' : '') + (queued ? ' queued-speed' : '')} type="button" aria-label="Fast mode"
    aria-pressed={on} title={FAST_MODE_HELP} disabled={saving} onClick={() => {
      setSaving(true)
      void saveScope(slug, node.id, { fast_mode: !on })
        .catch((e: Error) => toast([`error: ${e.message}`])).finally(() => setSaving(false))
    }}><BoltIcon fontSize="inherit" /></button>
  return button
}
